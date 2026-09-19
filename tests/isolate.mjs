/**
 * Preloaded before the test runner evaluates any spec.
 *
 * Several specs exercise code paths that record into the shared default
 * collectors. Without this, running the suite writes to the operator's
 * `~/.dsh/jev-stats.json` and `~/.dsh/jev-decisions.jsonl`: the former is the
 * signal `pnpm run doctor` uses to decide whether the host reloaded (a v2 write
 * from a test run makes a stale host look current), the latter is the dataset
 * threshold reviews read. The runtime master switch is a file too, and a test that
 * flipped it would silently switch the operator's plugin off.
 *
 * Loaded through `node --import ./tests/isolate.mjs`, which runs before the spec
 * files, and the collectors resolve their path on first use, so pointing them
 * here is enough.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Assigned unconditionally, and the directory carries the pid: the test runner sets the
// variable in its own process, children inherit it, and `??=` would then leave every
// spec file writing to the same file - which made results order-dependent. A mutation
// sweep exposed it: two entries were caught in one run and not in the next.
const dir = mkdtempSync(join(tmpdir(), 'jev-tests-' + process.pid + '-'))
process.env.DSH_JEV_METRICS_PATH = join(dir, 'jev-stats.json')
process.env.DSH_JEV_DECISIONS_PATH = join(dir, 'jev-decisions.jsonl')
process.env.DSH_JEV_GATE_PATH = join(dir, 'jev-enabled.json')
