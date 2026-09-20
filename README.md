# dsh-jev

[![CI](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml/badge.svg)](https://github.com/zhangxaochen/dsh-jev/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/dsh-jev.svg)](https://www.npmjs.com/package/dsh-jev)

[English](https://github.com/zhangxaochen/dsh-jev/blob/master/README.md) · [简体中文](https://github.com/zhangxaochen/dsh-jev/blob/master/README.zh-CN.md)

The Cordis plugin suite that pairs [Jev](https://typesafe.ai) (TypeSafe's System One decision models) with [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

It adds the layer of semantic judgement dsh does not have: non-generative decision primitives (Noul, Choice, Score) at ~150 ms, used for **dynamic tool pruning** (fewer prompt tokens, lower time to first token), **semantic dead-loop blocking**, and a **guard for high-risk execution**. The verdicts come from System One rather than sampling, so they are fast and reproducible, and one decision costs about **$0.00013** — measured on 2026-09-20 over 2,254 decisions (12.4 KiB of input each, billed at $0.042 per million input tokens; output is free).

## Contents

- [Features](#features)
- [Install](#install)
- [Usage](#usage)
- [Division of labour with DSH built-ins](#division-of-labour-with-dsh-built-ins)
- [Development and verification](#development-and-verification)
- [Contributing](#contributing)
- [License](#license)

## Features

| Module | Service / hook | What it does |
| :--- | :--- | :--- |
| `typesafe-client` | registers `ctx.typesafe` | Wraps the System One API: many questions in one batched call, timeouts and retries, a mock for tests. |
| `typesafe-loop-guard` | `tools/post-execute` | Judges whether each step actually makes progress, blocks dead loops and injects a corrective hint via `additionalContexts` (the near-stall a parameter-hash dedupe cannot see). |
| `typesafe-safety-guard` | `tools/pre-execute` | Reviews shell and file operations for high-risk behaviour (`rm -rf`, privilege escalation, credential leakage) in milliseconds, then blocks (`deny`) or asks for approval (`ask`). |
| `typesafe-tool-pruner` | `ctx.toolPruner` | With dozens or hundreds of tools available, injects only the top-K relevant to the intent and drops large schema blocks. |
| `jev_ask` / `jev_rank` / `jev_check` | agent tools | Hands the primitives to the model itself: ask in batches, rank against criteria, verify an assertion (holds / fails / undecidable). |
| `typesafe-skill-router` | `system-prompt/assemble` | Once the skill catalogue is large enough, names the **one** skill most worth loading and injects it as advice (never blocks, never trims). |
| `typesafe-result-shaper` | `tools/post-execute` (**off by default**) | Keeps only the informative middle of a very long, repetitive command output and drops the rest. |

Measured output of `pnpm run verify:turn` — one full turn across every module, a real model, and a real assembly:

```
assemble:       2139ms -> 12 tools to 5 (edit_file,git_commit,git_push,read_file,run_tests)
skill intent:   把这份用户调研整理成一份 PRD 文档 -> 1 advice in 979ms
post-execute:   586ms -> 32680 to 237 chars
semantic overhead this turn: 3704ms
```

In `verify:live` a real loop scores `pLoop=0.88` at confidence `0.81` and fires, while a healthy trajectory sits at `pLoop=0.00` and does not. The numbers move with request and output size; where the thresholds come from and the full calibration are in [`docs/calibration.md`](docs/calibration.md).

## Install

**Requirements**: Node `^22.19.0 || >=24.0.0`; DSH `>=0.1.5-rc.2`. The plugins mount `tools.guard()`, `tools/pre-execute`, `tools/post-execute`, `system-prompt/assemble` and `agent/pre-step`, and read the `tokenMeter` / `skills` / `toolResultPruner` services when they exist — anything missing falls back to a degraded path.

```bash
# straight from GitHub (no publish involved; you get the current source)
dsh plugin --profile <profile_name> add github:zhangxaochen/dsh-jev

# or from npm (file-write gating needs >= 0.2.0); also works for a concrete profile such as headless / web
dsh plugin --profile headless add dsh-jev
```

> ⚠️ **The `desktop` profile cannot be installed this way.** The CLI refuses outright:
> `error: profile "desktop" is managed exclusively by the Electron application`.
> Use the in-app plugin entry instead, or sync the package into
> `~/.dsh/profiles/desktop/node_modules/dsh-jev` the way "Development and verification"
> describes (`pnpm run sync` does exactly that).
>
> `dsh plugin` has no subcommands of its own: it forwards its arguments to the pnpm in
> that profile directory (observed error: `plugin needs pnpm arguments to forward
> (e.g. add <package>)`), so `add` / `remove` / `list` carry pnpm's meaning.

## Usage

Put the **API key** in `$DSH_HOME/.env` (default `~/.dsh/.env`; the desktop app and every CLI profile load it on start), or export the same variable. Without it DSH does not crash: the plugins log a warning and run against the mock, and only cloud arbitration is unavailable.

```bash
TYPESAFE_API_KEY=your_typesafe_api_key_here
```

Installed means usable — the defaults are calibrated, so **nothing has to be configured to run**:

- **Status-bar switch**: the `jev` switcher below the input box turns every module on or off with one click, no uninstall and no restart (what "off" means is in the reference).
- **Decision primitives** are registered as agent tools, so the model can call `jev_ask` / `jev_rank` / `jev_check` on its own.
- **Dashboard**: ask the agent to run `jev_stats`, or request `GET /api/dsh-jev/stats` (HTML dashboard in a browser, JSON when you send `Accept: application/json`). Metrics persist in `~/.dsh/jev-stats.json`.

To change thresholds, write your own safety rules, or embed the plugins in a non-DSH Cordis host, see [`docs/configuration.md`](docs/configuration.md) — every field with its default and the reason for it (the reference is written in Chinese).

## Division of labour with DSH built-ins

Jev only covers what DSH does not already do, so the two cannot duplicate or cancel each other:

| Situation | Owner | Why |
|---|---|---|
| Identical repeat calls (tool + arguments + output) | DSH `dsh-repeat-tool-reminder` (thresholds 3/5/8) | Exact deterministic matching is enough; dsh-jev ships `loopGuard.deferExactRepeats: true` and steps aside |
| **Near-identical or semantic stalls** | dsh-jev `loop-guard` | The built-in states it does not do near-synonym variants for lack of evidence; this plugin adds a dead-loop probability plus confidence |
| Head/tail truncation of very long results | DSH `dsh-spill-policy`, `dsh-compaction-tool-result-pruner` | Both are model-free, free, and reproducibly safe replacements |
| **Semantic selection from the middle** | dsh-jev `result-shaper` (off by default) | The built-in's Dev Note lists "semantic middle selection" as unimplemented; this plugin fills exactly that gap |
| Hard refusal of dangerous commands | dsh-jev's deterministic shell (`ctx.tools.guard()`) | Synchronous, monotonic, zero model calls; the semantic layer is never the last line of defence |
| Semantic risk verdicts / user-defined rules | dsh-jev `safety-guard` | Anything outside a pattern list can only be judged semantically |

## Development and verification

The native Node test runner; the offline cases need no network and no key (they use the built-in mock):

```bash
pnpm install --frozen-lockfile
pnpm run build && pnpm run verify:build   # lib/ is committed and the tests import it, so a src edit without a rebuild must fail
pnpm test                                 # offline unit tests (the count grows with the version; trust the output)
pnpm run verify:dsh                       # a real DSH runtime (skips and exits 0 when DSH is absent, so CI can run it)
pnpm run verify:live                      # online: replays historical false positives, checking they are gone while real loops still fire
pnpm run bench:offline                    # A/B bench over recorded answers: free, no key
pnpm run doctor                           # deployment self-check: is this machine running the current build?
```

The remaining gates — `probe` / `verify:tools` / `verify:pruner` / `verify:router` / `verify:shaper` / `verify:turn` / `verify:pack` / `verify:mutants` / `verify:solo` / `drill` / `bench` / the coverage audit — with their individual evidence are in [`docs/verification-report.md`](docs/verification-report.md); borrowed ideas and their evidence are in [`docs/research.md`](docs/research.md); behaviour history and **upgrade steps** are in [`CHANGELOG.md`](CHANGELOG.md) (breaking changes live only there; this README does not repeat them).

CI (`.github/workflows/ci.yml`) runs on Node 22 and 24: `build → typecheck:scripts → test → bench:offline → verify:dsh (skipped) → packaging check`. The bench replays recorded answers with an **input fingerprint check**, so it needs no API key, and **any case that does not behave as labelled fails the job** unless it is a documented known miss.

### Making a local change take effect

A profile holds a **copy of the build output**, so a source edit has to be synced, and then DSH restarted:

```bash
pnpm run sync              # sync into every profile that has the plugin installed (auto-discovered)
pnpm run sync:desktop      # desktop only
pnpm run doctor            # per profile: build hash, installed version, metrics schema; then ACTION: or OK:
```

`pnpm run sync` also aligns the `dsh-jev` version declared in each profile manifest with this repository's. The manifest pins an exact version while the installed copy is **replaced in place**, so once the two drift, any `pnpm install` in that profile (which every `dsh plugin add` runs) silently puts the declared version back; `doctor` reports that drift (`declaredMatch`). The verification scripts stay out of the live metrics: `verify:*` / `bench` write metrics and decision logs to `%TEMP%` (`DSH_JEV_METRICS_PATH` / `DSH_JEV_DECISIONS_PATH`), otherwise `~/.dsh/jev-stats.json` — the file `doctor` reads to decide deployment state — would be overwritten by tests.

> ⚠️ **DSH must be restarted**: the profile combination here mounts no HMR plugin, so a running process never reloads modules under `node_modules`. Sync without restarting and the session still runs the old build (`doctor` says `ACTION: restart DSH`).

## Contributing

Issues and PRs are welcome. A change has to satisfy:

- `pnpm test` green, including `verify:solo`'s order-independence check and `verify:mutants`' mutation scan.
- Behaviour changes also update [`CHANGELOG.md`](CHANGELOG.md); a new gate also updates the evidence table in [`docs/verification-report.md`](docs/verification-report.md) (that table must name every `verify:*` script, and a test enforces it).
- Adding or removing a config field also updates [`docs/configuration.md`](docs/configuration.md) (field coverage is test-enforced too).
- Releasing is one tag push; the process and the one-time npm setup are in [`docs/releasing.md`](docs/releasing.md).

Maintainer: [@zhangxaochen](https://github.com/zhangxaochen)

## License

[MIT](LICENSE)
