# Does Jev help an agent solve real tasks? A/B evidence

**17 of 20 tasks. By per-arm means: 2 wins · 2 losses · 13 ties, mean difference −1.10pp.** Conclusion: *no advantage detected, and no stable harm either.*

This directory is the reproducibility kit for that claim: the driver, the analysis scripts, the
per-run results and the harness's own evidence files. Read the findings in
[`docs/pier-ab-report.md`](../../docs/pier-ab-report.md) (English) or
[`docs/pier-ab-report.zh-CN.md`](../../docs/pier-ab-report.zh-CN.md) (中文).

## What was compared

The same agent (DSH headless), the same model (`commandcode` route, `deepseek/deepseek-v4.1-flash`),
the same task image, the same concurrency and the same start second. Only one thing differs:

| arm | profile | plugin |
| --- | --- | --- |
| A | `headless` | off |
| B | `headless-jev` | on |

Each task is one [Pier](https://github.com/datacurve-ai/pier) trial whose score comes from the
task's own hidden tests, not from us:

- **F2P** = `FAIL_TO_PASS`: tests that fail before a fix and must pass after it. `reward = 1`
  requires **all** of them.
- **P2P** = `PASS_TO_PASS`: tests that already passed and must keep passing.
- `reward = -1` means the trial itself errored (infrastructure), and is excluded rather than read
  as a zero.

F2P *pass ratio* is reported next to the binary reward, because the binary score hides the
difference between "missed one test" and "missed forty".

## What is here

| path | what it is |
| --- | --- |
| `results.json` | every run: reward, F2P/P2P counts, pass ratio, steps, tool calls, prompt/uncached/cached/output/reasoning tokens, wall seconds; plus one row per task pairing the arms |
| `evidence/<run>/` | the harness's own output per run: `reward.json`, `result.json` (timings), `setup.txt` (which arm it was), `model.patch`, and for treatment runs `jev-stats.json` + `jev-decisions.jsonl` (the plugin's counter and decision trail) |
| `scripts/` | the driver (`run-top20.py`, `run-arm.ps1`), the Pier agent (`dsh_agent.py`, `pilot_setup.py`), and the analysis tools (`pair-scores.mjs`, `pair-cost.mjs`, `session-metrics.mjs`, `rebuild-status.mjs`, `failing-tests.mjs`, …) |
| `top20-ids.txt`, `skip.txt` | the task list, and tasks excluded with a reason |

Deliberately **not** committed: agent transcripts (~450 KB per run), session archives (~700 KB per
run, 10 MB total), salvaged patches (65 MB), `node_modules`, container images. They are large and
regenerable; `scripts/session-metrics.mjs` shows how to re-derive the cost numbers from a session
archive if you re-run the pilot.

## What this directory is — and is not

It **is** the pilot's scripts, its results and the harness's own evidence. It is **not**
self-contained: the runs executed against a separate DeepSWE checkout, and reproducing them needs
that checkout plus the tools below.

| you must provide | why | override |
| --- | --- | --- |
| a DeepSWE checkout | `tasks/<id>/` (task.toml + image), and the jobs root where Pier writes results | `DEEPSWE_ROOT` (ps1) · `DEEPSWE_TASKS` · `DEEPSWE_JOBS` |
| Docker Desktop | every trial is a compose project with its own network and egress proxy | — |
| `datacurve-pier` | the harness that runs a trial and scores it | `PIER_EXE` |
| built plugin tarball | the treatment profile installs it inside the container | put `dsh-jev-<version>.tgz` in this directory (`pnpm pack` produces it) |
| API keys | `DEEPSEEK_API_KEY` (model route) and `TYPESAFE_API_KEY` (Jev verdicts) | environment |
| DSH profiles | `pilot_setup.py` writes `~/.dsh/profiles/{headless,headless-jev}` | `DSH_HOME` |

Defaults assume this pilot's layout (`D:\code\deep-swe`, `D:\code\.uv-tools\...`); every path is
overridable and everything else resolves relative to the script, so `scripts/` runs from any
checkout. `top20_tasks.json` is committed so the task list, the ranking metric (reference patch
size) and the image tags are readable without the DeepSWE checkout.

## Reproducing

Prerequisites: the table above, plus Python 3, PowerShell 7 and a CommandCode API key.

```powershell
# 1. Two DSH profiles, identical except for the plugin.
python scripts/pilot_setup.py                      # writes ~/.dsh/profiles/{headless,headless-jev}

# 2. One arm of one task (repeat for A and B).
pwsh -File scripts/run-arm.ps1 -Jev off -TaskId vitest-duration-sharding   # control
pwsh -File scripts/run-arm.ps1 -Jev on  -TaskId vitest-duration-sharding   # treatment

# 3. The whole sweep, with resume and retry (pairs = concurrent task pairs).
python scripts/run-top20.py --pairs 3
```

Scores come back under the Pier jobs root (`<jobs>/<timestamp>/<task>__<id>/verifier/reward.json`).
Re-derive the tables with:

```bash
node scripts/pair-scores.mjs      # verifier scoreboard, per-arm means
node scripts/pair-cost.mjs        # paired cost: tokens, steps, wall time
node scripts/pair-steps.mjs       # step counts per arm
node scripts/rebuild-status.mjs   # rebuild the scoreboard from the job directories
node export-bench.mjs --jobs <jobs-dir> --out .   # regenerate this directory
```

Run the analysis scripts from this directory, or set `PIER_PILOT` to it, since they look for
`top20-ids.txt` next to themselves.

## Traps this pilot hit (please don't repeat them)

1. **Pier builds each task image with `buildx --pull`**, so pre-pulling the base image locally does
   not help. Registry refusals are intermittent; the fix is one serialized pull plus backoff retry.
2. **Docker's default address pool runs out.** Every trial creates its own compose network and a
   badly failed run leaves it behind, so after a day of runs new trials die with
   `all predefined address pools have been fully subnetted` before the agent even starts. Prune
   unused networks before each launch — this, not the registry, was the dominant late failure.
3. **Pier names job directories to the second**, so both arms launched in the same second collide
   with `Job directory already exists`. Space launches out and guard with a lock file.
4. **Background jobs die with the session.** Long runs must be started detached
   (`Start-Process`), or the driver and Pier are killed mid-trial and the containers are orphaned —
   which is how ten finished trials were lost in this pilot.
5. **Read the score fields correctly**: `f2p_passed` / `f2p_total`, not a list; and `reward = -1` is
   an errored trial, not a zero.

## The honest caveat

Run-to-run variance is far larger than the effect being measured. Re-running the *same arm* on the
*same task* moved koota-deferred from 30/71 to 69/71 F2P. A single pair per arm therefore cannot
settle the question; the pilot's repeats (`run-top20.py --attempts 3 --unsaturated`) exist to
measure that spread, and `skip.txt` records what could not be measured at all.
