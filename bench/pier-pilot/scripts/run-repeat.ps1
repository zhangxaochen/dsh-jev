# Repeat the unsaturated tasks three times per arm, to separate run-to-run variance from a real
# plugin effect. Detached for the same reason as run-sweep.ps1.
Set-Location 'D:\code\dsh-jev'
python tmp/pier-pilot/run-top20.py --pairs 3 --attempts 3 --unsaturated --tag repeat
