/**
 * Preloaded before the test runner evaluates any spec.
 *
 * Several specs exercise code paths that record into the shared default
 * collectors. Without this, running the suite writes to the operator's
 * `~/.dsh/jev-stats.json` and `~/.dsh/jev-decisions.jsonl`: the former is the
 * signal `pnpm run doctor` uses to decide whether the host reloaded (a v2 write
 * from a test run makes a stale host look current), the latter is the dataset
 * threshold reviews read.
 *
 * Loaded through `node --import ./tests/isolate.mjs`, which runs before the spec
 * files, and both collectors resolve their path on first use, so pointing them
 * here is enough.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'jev-tests-'))
process.env.DSH_JEV_METRICS_PATH ??= join(dir, 'jev-stats.json')
process.env.DSH_JEV_DECISIONS_PATH ??= join(dir, 'jev-decisions.jsonl')
