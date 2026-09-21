# Jev plugin effectiveness: an A/B pilot on real DeepSWE tasks

中文版 / Chinese version: [`pier-ab-report.zh-CN.md`](pier-ab-report.zh-CN.md)

Method, scripts and per-run evidence: [`bench/pier-pilot/`](../bench/pier-pilot/README.md).

**Headline: 17 of 20 tasks measured. By per-arm means: 2 wins · 2 losses · 13 ties, mean
difference −1.10pp — no advantage detected, and no stable harm either.**

## 1. Setup and scoring

Two DSH profiles differ in exactly one way — whether the Jev plugin is loaded:

| arm | profile | plugin |
| --- | --- | --- |
| A (control) | `headless` | off |
| B (treatment) | `headless-jev` | on |

Same model on the same route (`commandcode`, `deepseek/deepseek-v4.1-flash`), same task image, same
concurrency, same start second (a cross-process lock spaces launches by 5 s and by 90 s when images
must be built). Each task is one Pier trial, scored by the task's own hidden tests:

| symbol | meaning | role |
| --- | --- | --- |
| **F2P** | `FAIL_TO_PASS` | tests that fail before the fix and must pass after it — the required behaviour |
| **P2P** | `PASS_TO_PASS` | tests that already passed and must keep passing — the regression guard |
| `reward` | 1 ⟺ all F2P pass **and** all P2P pass | the binary verdict |
| `reward = -1` | the trial itself errored | infrastructure, excluded rather than counted as zero |

The binary reward cannot tell "missed one test" from "missed forty", so F2P **pass ratio** is
reported alongside it. Note that the `partial` field Harbor also writes is dominated by P2P counts
(a task with 0/2 F2P and 214/214 P2P still reports `partial ≈ 99%`), so this report uses the F2P
pass ratio, not `partial`.

## 2. Results: 17 of 20 tasks, no stable advantage

Two readings, and they disagree — which is the honest state of this pilot.

**"Latest run per arm"** (what an earlier draft of this report used): 3 wins, 0 losses, 14 ties,
all in the plugin's favour.

**Per-arm means over every run of that arm** (the defensible reading):

| task | A runs | A mean F2P | A range | B runs | B mean F2P | B range | mean Δ |
| --- | --- | --- | --- | --- | --- | --- | --- |
| koota-composite-trait-aspects | 1 | 94.12% | — | 1 | 100.00% | — | **+5.88pp** |
| koota-pair-relation-tracking | 3 | 93.86% | 86.84–97.37 | 2 | 96.05% | 94.74–97.37 | **+2.19pp** |
| fastapi-deprecation-response-headers | 2 | 100.00% | — | 2 | 98.18% | — | −1.82pp |
| koota-deferred-mutation-buffer | 4 | 94.72% | 91.55–98.59 | 2 | 69.72% | 42.25–97.18 | **−25.00pp** |
| 13 further tasks | 1–3 | identical | — | 1–3 | identical | — | 0.00pp |

Totals: **2 wins · 2 losses · 13 ties, mean Δ −1.10pp.** The sign is not even consistent, so the
pilot shows **no detected advantage** rather than a small positive one.

Note the fastapi-deprecation and koota-deferred rows: an earlier draft reported both as plugin wins
(+1.905pp and +2.010pp) because it compared the latest run of each arm. Across these runs that rule
picks different points of a wide distribution. On means, one is a small loss and the other a 25 pp
loss.

### The one result that is not just a mean shift

koota-composite-trait-aspects is the only **reward flip** (A reward 0 with 48/51 F2P, B reward 1
with 51/51). It has n=1 per arm, so it is a single pair — suggestive, not established.

### Two pairs that must be discarded

| task | both arms | why it is not a measurement |
| --- | --- | --- |
| narwhals-rolling-window-suite | F2P 0/103 · **P2P 0/10093** | P2P at zero means the suite never ran |
| kombu-virtual-queue-dead-lettering | F2P 0/76 · **P2P 0/1412** | same |

So of 17 pairs, 15 are valid; the per-arm means above already exclude these two.

### About the repeats

The repeat phase was meant to give three attempts per arm per task (`--attempts 3`). It was cut
short by the quota ceiling, and — checked afterwards — Pier left **no per-attempt directories or
per-attempt scores** in the job output, so how the attempts aggregate could not be verified. What
the repeats did produce is the evidence in §3: extra independent runs whose spread dwarfs the effect
being measured.

## 3. Run-to-run variance is the dominant term

The same arm on the same task, re-run, moves further than the arms differ from each other:

| observation | data |
| --- | --- |
| koota-deferred, plugin arm | 42.25% → **97.18%** |
| koota-deferred, control arm | 97.18% · 98.59% · 91.55% · 91.55% |
| fastapi-deprecation, plugin arm | 100.00% → 96.36% |
| koota-pair, control arm | 97.37% · 97.37% → 86.84% |

An earlier reading of this pilot blamed the plugin for a 41-test collapse on koota-deferred
(98.59% vs 42.25%, −56 pp). Further runs of the same configuration landed at 97.18% for the plugin
arm and 91.55% for the control, so that collapse was not reproducible: it is run-to-run variance,
not a plugin effect. Within-arm spread reaches 55 pp here, while per-arm means differ by
single-digit pp on every task except koota-deferred.

## 4. Cost: no net token saving

Measured across 14 pairs, same-reward runs only, per arm using its most recent run:

| metric | median Δ | mean Δ | plugin better |
| --- | --- | --- | --- |
| prompt tokens (total) | −3.2% | +13.0% | 7/14 |
| uncached input tokens | **+16.6%** | **+71.9%** | 5/14 |
| output tokens | −2.8% | +11.0% | 10/14 |
| steps | **+2.6%** | +3.4% | 7/14 |
| wall time | **−12.5%** | −1.6% | 8/14 |

Uncached input is confounded with how much work a run did (it scales with the number of requests),
so normalising per step is the fair comparison — and per step the plugin is lower in 6 pairs and
higher in 7, i.e. a median of about zero. The pruner demonstrably removes content (≈2,200 tool
results ≈ 857 K tokens in one run) but the end-to-end prompt does not shrink, because the plugin
also *adds* material (pruned-tool notices, shaped results, guard warnings) and issues its own
advisory calls. Wall time is the one mildly favourable signal (−12.5% median, 8/14), still within
noise at this sample size.

## 5. What is demonstrably working

These are engineering effects rather than score effects, and each has a measured counter:

- pruning is active (thousands of tool results removed per long run);
- the loop guard produced no false interruptions (0 interrupts across the runs);
- the safety guard screened tens of thousands of actions with no false denials, and the
  `headlessAsk: warn` downgrade is measurably live (`warned` counter > 0 instead of fail-closed denials).

## 6. Verdict and limits

- **Score channel**: on per-arm means the plugin wins 2 and loses 2 of 15 valid pairs, mean
  −1.10 pp; the only reward flip (koota-composite) is n=1 per arm. Honest statement: **no advantage
  detected, no stable harm detected**. An earlier draft's "3 wins · 0 losses" came from a
  latest-run-per-arm rule and **overstated** the result; it is retracted here.
- **Cost channel**: no net token saving; a weak, sign-mixed improvement in wall time.
- **Sample**: 17 of 20 tasks, 1–4 runs per arm, with within-arm spread up to 55 pp. Not measured:
  `numba-stencil-boundary-modes` (trials error repeatedly, see `skip.txt`),
  `updo-policy-alerting`, `prometheus-transactional-reload-status`.
- The five traps this pilot hit (image `buildx --pull`, Docker address-pool exhaustion, same-second
  job directories, background jobs dying with the session, score field names) are recorded in
  [`bench/pier-pilot/README.md`](../bench/pier-pilot/README.md).
- Selection caveat: the 20 tasks come from the upstream `top20_tasks.json`, ranked by **reference
  patch size** (53.9 KB down to 33.1 KB), not by difficulty or by anything related to this plugin.
  Eight of them are saturated (both arms 100% F2P), so the task set has limited power to detect an
  effect at all.

The pilot was stopped on 2026-09-21 06:55 because CommandCode's weekly window was exhausted
(33.47/35 used; resets 2026-09-25 16:51). Finishing the last three tasks needs roughly $3–4 of
quota, or waiting for the reset.
