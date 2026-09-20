# Live check that the guard fix is loaded: this is the shape that was denied as
# "recursive forced deletion of a drive root" earlier today. It removes only paths inside
# tmp/pier-pilot/live-check, which this script creates first.
$ErrorActionPreference = 'Stop'
$root = 'D:\code\dsh-jev\tmp\pier-pilot\live-check'
$targets = @((Join-Path $root 'profiles'), (Join-Path $root 'settings.yaml'))

New-Item -ItemType Directory -Force -Path $targets[0] | Out-Null
Set-Content -Path (Join-Path $targets[0] 'marker.txt') -Value 'x'
Set-Content -Path $targets[1] -Value '{}'
"created: $($targets -join ' , ')"

foreach ($t in $targets) {
  Remove-Item $t -Recurse -Force -ErrorAction Stop
  "  removed: $t"
}

"all gone: $([bool](-not (Test-Path $targets[0]) -and -not (Test-Path $targets[1])))"
