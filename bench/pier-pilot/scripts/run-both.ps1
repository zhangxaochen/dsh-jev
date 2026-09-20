# Run both arms of the pilot sequentially with the same harness version, so the pair is
# comparable: control (no plugin) then treatment (plugin). Sequential on purpose - two
# concurrent runs produced duplicate containers and confusion earlier.
$ErrorActionPreference = 'Continue'
$log = 'D:\code\dsh-jev\tmp\pier-pilot\both-arms.log'
"=== both arms started $(Get-Date -Format 'HH:mm:ss') ===" | Set-Content $log -Encoding UTF8

foreach ($arm in @(@{ Jev = 'off'; Label = 'A control (no plugin)' }, @{ Jev = 'on'; Label = 'B treatment (plugin)' })) {
  "`n=== arm $($arm.Label) - start $(Get-Date -Format 'HH:mm:ss') ===" | Add-Content $log
  $out = & pwsh -File 'D:\code\dsh-jev\tmp\pier-pilot\run-arm.ps1' -Jev $arm.Jev 2>&1
  $out | Add-Content $log
  $rewardLine = $out | Select-String -Pattern 'Job Info' -Context 0,4
  "=== arm $($arm.Label) - done $(Get-Date -Format 'HH:mm:ss') ===" | Add-Content $log
}

"`n=== both arms finished $(Get-Date -Format 'HH:mm:ss') ===" | Add-Content $log
Get-Content $log -Tail 12
