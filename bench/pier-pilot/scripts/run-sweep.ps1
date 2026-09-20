# Finish the 20-task sweep. Run detached, not as a harness background job: harness jobs are
# cleared when the session context rolls over, which is what left ten finished trials orphaned.
Set-Location 'D:\code\dsh-jev'
python tmp/pier-pilot/run-top20.py --pairs 3
