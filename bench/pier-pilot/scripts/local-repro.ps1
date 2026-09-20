# Reproduce the plugin-vs-runtime incompatibility locally, without Docker/Pier:
# build the same two profiles on top of the published @deepseek-ai/dsh 0.1.5-rc.2 and run
# one trivial task through each, printing whatever the plugin does at startup.
$ErrorActionPreference = 'Continue'
$pilot = 'D:\code\dsh-jev\tmp\pier-pilot'
$home = Join-Path $pilot 'dshhome'
$cli = Join-Path $pilot 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$shellHome = $env:DSH_HOME

function New-Profile([string]$name, [bool]$withPlugin) {
  $dir = Join-Path $home "profiles\$name"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $bundles = if ($withPlugin) {
    '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless","dsh-jev"]'
  } else {
    '["@deepseek-ai/dsh-base","@deepseek-ai/dsh-headless"]'
  }
  $manifest = '{"name":"dsh-profile-' + $name + '","private":true,"dependencies":{},' +
    '"dsh":{"profile":{"bundles":' + $bundles + ',"patchReload":"startup"}}}'
  Set-Content -Path (Join-Path $dir 'package.json') -Value $manifest -Encoding UTF8
  Set-Content -Path (Join-Path $dir 'cordis.patch.yml') -Value '[]' -Encoding UTF8
  Push-Location $dir
  npm i --no-audit --no-fund --loglevel=error '@deepseek-ai/dsh-base' '@deepseek-ai/dsh-headless' 2>&1 | Select-Object -Last 2
  if ($withPlugin) { npm i --no-audit --no-fund --loglevel=error (Join-Path $pilot 'dsh-jev-0.2.0.tgz') 2>&1 | Select-Object -Last 2 }
  Pop-Location
  "profile $name ready (plugin=$withPlugin)"
}

New-Item -ItemType Directory -Force -Path $home | Out-Null
foreach ($f in @('.credentials.yaml', '.env')) {
  $src = Join-Path $shellHome $f
  if (Test-Path $src) { Copy-Item $src (Join-Path $home $f) -Force }
}
Set-Content -Path (Join-Path $home 'settings.yaml') -Value '{}' -Encoding UTF8

New-Profile -name 'headless' -withPlugin $false
New-Profile -name 'headless-jev' -withPlugin $true

$env:DSH_HOME = $home
$env:HEADLESS = 'true'

foreach ($profile in @('headless', 'headless-jev')) {
  "`n================ $profile ================"
  $out = & node $cli --profile $profile 'Reply with the single word: ok' 2>&1
  $text = ($out | Out-String)
  if ($text.Length -gt 3000) { $text.Substring(0, 3000) } else { $text }
  "---- exit: $LASTEXITCODE ----"
}
