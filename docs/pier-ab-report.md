# Jev plugin effectiveness: an A/B pilot on real DeepSWE tasks

中文版 / Chinese version: [`pier-ab-report.zh-CN.md`](pier-ab-report.zh-CN.md)

Method, scripts and per-run evidence: [`bench/pier-pilot/`](../bench/pier-pilot/README.md).

**Headline: 17 of 20 tasks measured, 3 wins · 0 losses · 14 ties. No harm detected; three small
advantages; not yet a proven benefit.**

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
reported alongside it. That distinction turned out to matter (§3).

## 2. Results: 3 wins, 0 losses, 14 ties

Mean difference in partial (F2P/P2P pass ratio) score: **+0.309 pp**, all of it in the plugin arm's
favour. Every difference sits on F2P pass ratio:

| task | A (control) | B (plugin) | Δ | nature |
| --- | --- | --- | --- | --- |
| koota-composite-trait-aspects | 48/51 (reward 0) | **51/51 (reward 1)** | **+1.345 pp** | **a genuine flip**: B solved it, A did not |
| koota-deferred-mutation-buffer | 65/71 | **69/71** | **+2.010 pp** | B missed four fewer tests |
| koota-pair-relation-tracking | 33/38 | **37/38** | **+1.905 pp** | B missed four fewer tests |

The remaining 12 pairs tie exactly, including eight where both arms scored 100%/100% (saturated
tasks with no room to move): valibot, koota-query, fastapi-implicit, etree, scriggo,
fastapi-deprecation, arcane, dynamodb, kysely, vitest.

### Two pairs that must be discarded

| task | both arms | why it is not a measurement |
| --- | --- | --- |
| narwhals-rolling-window-suite | F2P 0/103 · **P2P 0/10093** | P2P at zero means the suite never ran |
| kombu-virtual-queue-dead-lettering | F2P 0/76 · **P2P 0/1412** | same |

So of 17 pairs, 15 are valid: **3 wins · 0 losses · 12 ties**.

## 3. Run-to-run variance is the dominant term

The same arm on the same task, re-run, moves further than the arms differ from each other:

| observation | data |
| --- | --- |
| koota-deferred, plugin arm (before → after) | 30/71 → **69/71** |
| koota-deferred, control arm | 70/71 → 65/71 |
| fastapi-deprecation, plugin arm | 132/137 → **137/137** (the earlier "loss" disappeared) |
| koota-pair, control arm | 37/38 → 33/38 |

An earlier reading of this pilot blamed the plugin for a 41-test collapse on koota-deferred
(70/71 vs 30/71, −56 pp). The repeats **falsified** that: same configuration, same task, 30/71 →
69/71. Variance is ±56 pp; the arms differ by ±2 pp. Single pairs therefore carry no verdict.

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

- **Score channel**: the plugin arm never lost and won three times, consistently on F2P pass ratio,
  by +1.3 to +2.0 pp. With this variance the honest statement is *no harm detected, three small
  advantages* — **not** a proven benefit.
- **Cost channel**: no net token saving; a weak, sign-mixed improvement in wall time.
- **Sample**: 17 of 20 tasks, 1–3 runs per arm. Not measured: `numba-stencil-boundary-modes`
  (trials error repeatedly, see `skip.txt`), `updo-policy-alerting`,
  `prometheus-transactional-reload-status`.

The pilot was stopped on 2026-09-21 06:55 because CommandCode's weekly window was exhausted
(33.47/35 used; resets 2026-09-25 16:51). Finishing the last three tasks needs roughly $3–4 of
quota, or waiting for the reset.
