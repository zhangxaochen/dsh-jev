/**
 * Assert that the committed build output matches the committed sources.
 *
 * `lib/` is committed in this repository, so the tests import the build rather
 * than the sources. Editing `src/` without rebuilding therefore leaves the suite
 * green against the previous build while the repository ships the old one - CI
 * rebuilds before testing, which hides the drift instead of reporting it.
 *
 * Run after `pnpm run build`; exits non-zero when the working tree's build output
 * differs from what is committed.
 *
 * Usage: pnpm run verify:build
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

const ROOT = process.cwd()

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

if (!existsSync(ROOT + '/.git')) {
  console.log('SKIP: not a git checkout, so there is nothing to compare against')
  process.exit(0)
}

let status = ''
try {
  status = git(['status', '--porcelain', '--', 'lib'])
} catch (err) {
  console.error('could not read git status:', err instanceof Error ? err.message : String(err))
  process.exit(1)
}

const drifted = status
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line.length > 0)

if (drifted.length === 0) {
  console.log('ok   the committed build output matches the sources')
  process.exit(0)
}

console.error('FAIL ' + drifted.length + ' build file(s) differ from the committed ones:')
for (const line of drifted) console.error('       ' + line)
console.error('\nThe suite imports lib/, so a stale build passes while shipping old code.')
console.error('Commit the rebuild:  pnpm run build && git add lib && git commit')
process.exit(1)
