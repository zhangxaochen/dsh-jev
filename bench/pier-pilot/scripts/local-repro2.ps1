# Corrected local repro: does dsh-jev break @deepseek-ai/dsh 0.1.5-rc.2 at startup?
# Everything is written under tmp/pier-pilot/dshhome; the user's home is untouched.
$ErrorActionPreference = 'Continue'
$pilot = 'D:\code\dsh-jev\tmp\pier-pilot'
$dshHome = Join-Path $pilot 'dshhome'
$cli = Join-Path $pilot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$shellHome = $env:DSH_HOME

# The plugin and the runtime both resolve from the pilot root, which is a parent of the
# profile directories, so no per-profile install is needed.
if (-not (Test-Path (Join-Path $pilot 'node_modules\dsh-jev'))) {
  Push-Location $pilot
  npm i --no-audit --no-fund --loglevel=error (Join-Path $pilot 'dsh-jev-0.2.0.tgz') 2>&1 | Select-Object -Last 2
  Pop-Location
}
"plugin installed in pilot root: $(Test-Path (Join-Path $pilot 'node_modules\dsh-jev\package.json'))"

New-Item -ItemType Directory -Force -Path $dshHome | Out-Null
foreach ($f in @('.credentials.yaml', '.env')) {
  $src = Join-Path $shellHome $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $dshHome $f) -Force }
}

foreach ($spec in @(@{ name = 'headless'; plugin = $false }, @{ name = 'headless-jev'; plugin = $true })) {
  $dir = Join-Path $dshHome "profiles\$($spec.name)"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $bundles = if ($spec.plugin) {
    '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-jev"]'
  } else {
    '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]'
  }
  $manifest = '{"name":"dsh-profile-' + $spec.name + '","private":true,"dependencies":{},' +
    '"dsh":{"profile":{"bundles":' + $bundles + ',"patchReload":"startup"}}}'
  Set-Content -Path (Join-Path $dir 'package.json') -Value $manifest -Encoding UTF8
  Set-Content -Path (Join-Path $dir 'cordis.patch.yml') -Value '[]' -Encoding UTF8
}

$env:DSH_HOME = $dshHome
$env:HEADLESS = 'true'
$env:DSH_JEV_METRICS_PATH = Join-Path $dshHome 'jev-stats.json'
$env:DSH_JEV_DECISIONS_PATH = Join-Path $dshHome 'jev-decisions.jsonl'
$env:DSH_JEV_GATE_PATH = Join-Path $dshHome 'jev-enabled.json'

foreach ($name in @('headless', 'headless-jev')) {
  Remove-Item (Join-Path $dshHome 'jev-stats.json') -Force -ErrorAction SilentlyContinue
  "`n================ $name ================"
  $out = & node $cli --profile $name 'Reply with the single word: ok' 2>&1
  ($out | Out-String).Trim() | ForEach-Object { $_.Substring(0, [Math]::Min(2000, $_.Length)) }
  "---- exit: $LASTEXITCODE ----"
  "plugin wrote metrics: $(Test-Path (Join-Path $dshHome 'jev-stats.json'))"
}
