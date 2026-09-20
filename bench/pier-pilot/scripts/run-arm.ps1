# Launch one arm of the pilot: DSH headless on one DeepSWE task, plugin on or off.
# Secrets are read from the host's own files and passed through without being printed.
param(
  [Parameter(Mandatory = $true)][ValidateSet('on', 'off')][string]$Jev,
  [string]$TaskId = 'vitest-duration-sharding',
  [int]$Attempts = 1
)

$ErrorActionPreference = 'Stop'
$pilot = 'D:\code\dsh-jev\tmp\pier-pilot'
$taskPath = Join-Path 'D:\code\deep-swe\tasks' $TaskId

# Credentials: the model key from the harness credential document, the plugin key from .env.
$credFile = Join-Path $env:DSH_HOME '.credentials.yaml'
$envFile = Join-Path $env:DSH_HOME '.env'
if (Test-Path $credFile) {
  $env:DSH_CREDENTIALS_YAML_B64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes($credFile))
}
if (Test-Path $envFile) {
  foreach ($line in Get-Content $envFile) {
    if ($line -match '^\s*TYPESAFE_API_KEY\s*=\s*(.+)$') { $env:TYPESAFE_API_KEY = $Matches[1].Trim() }
  }
}

$env:PYTHONPATH = $pilot
$mounts = '[{"type":"bind","source":"' + ($pilot -replace '\\', '/') + '","target":"/mnt/pilot","read_only":true}]'

$withJev = if ($Jev -eq 'on') { 'true' } else { 'false' }
"=== pilot arm: jev=$Jev  task=$TaskId ==="
"credentials: model=$(if ($env:DSH_CREDENTIALS_YAML_B64) { 'ok' } else { 'MISSING' })  plugin=$(if ($env:TYPESAFE_API_KEY) { 'ok' } else { 'MISSING' })"

# Call the installed Pier directly. `uv tool run` refuses to serve several concurrent
# invocations from one tool environment ("cannot be resumed with a different config"), which
# killed whole arms when four runs started together.
$pierArgs = @(
  'run',
  '-p', $taskPath,
  '--agent-import-path', 'dsh_agent:DshCli',
  '--agent-kwarg', "with_jev=$withJev",
  '--mounts-json', $mounts,
  '--artifact', '/logs/agent'
)
if ($Attempts -gt 1) {
  "attempts per trial: $Attempts"
  $pierArgs += @('-k', "$Attempts")
}
$pierExe = 'D:\code\.uv-tools\datacurve-pier\Scripts\pier.exe'
if (Test-Path $pierExe) {
  "launcher: $pierExe"
  & $pierExe @pierArgs
} else {
  'launcher: uv tool run (direct executable not found)'
  uv tool run --from datacurve-pier pier @pierArgs
}

"=== arm finished: exit $LASTEXITCODE ==="
exit $LASTEXITCODE
