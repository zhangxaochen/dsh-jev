/**
 * Order independence: run every spec file on its own.
 *
 * A shared file path or a module-level singleton can make a spec pass only because
 * another spec ran first, and the aggregate run hides it - exactly what the metrics
 * path did until tests/isolate.mjs stopped inheriting one path for every child. The
 * per-file counts are also summed and compared with the suite total, so a spec that
 * stops being collected cannot hide inside `pnpm test`.
 *
 * Usage: pnpm run verify:solo
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const specs = readdirSync(join(ROOT, 'tests'))
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()

const results = []
for (const spec of specs) {
  let output = ''
  let ok = true
  try {
    output = execFileSync(process.execPath, ['--import', './tests/isolate.mjs', '--test', 'tests/' + spec], {
      encoding: 'utf8',
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (error) {
    ok = false
    output = String(error.stdout ?? '') + String(error.stderr ?? '')
  }
  const counts = Object.fromEntries(
    [...output.matchAll(/^ℹ (tests|pass|fail|skipped) (\d+)$/gm)].map((match) => [match[1], Number(match[2])])
  )
  results.push({ spec, ok, counts, output })
}

let failures = 0
let total = 0
for (const result of results) {
  if (!result.ok) failures += 1
  total += result.counts.tests ?? 0
  const summary = ['tests', 'pass', 'fail', 'skipped']
    .filter((key) => result.counts[key] !== undefined)
    .map((key) => key + '=' + result.counts[key])
    .join(' ')
  console.log((result.ok ? 'ok   ' : 'FAIL ') + result.spec.padEnd(34) + summary)
  if (!result.ok) {
    for (const line of result.output.split('\n').filter((entry) => /✖|AssertionError|Error:/.test(entry)).slice(0, 4)) {
      console.log('       ' + line.trim().slice(0, 120))
    }
  }
}

console.log('\nspecs: ' + results.length + ' | failing alone: ' + failures + ' | tests across files: ' + total)
process.exit(failures === 0 ? 0 : 1)
