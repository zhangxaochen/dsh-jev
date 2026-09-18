/**
 * Mutation sweep: break a behaviour, rebuild, and ask whether any test notices.
 *
 * Coverage says "this line ran"; this says "someone would find out if it broke".
 * The corpus is deliberately small and hand-picked - each entry targets a knob or a
 * guard whose silent removal would change user-visible behaviour.
 *
 * Usage: pnpm run verify:mutants
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const CORPUS = join(ROOT, 'bench', 'mutations.json')

function build() {
  try {
    execFileSync('pnpm', ['run', 'build'], { stdio: 'ignore', shell: true, cwd: ROOT })
    return true
  } catch {
    return false
  }
}

function testsPass() {
  try {
    execFileSync(process.execPath, ['--import', './tests/isolate.mjs', '--test', 'tests/*.spec.ts'], { stdio: 'ignore', cwd: ROOT })
    return true
  } catch {
    return false
  }
}

const mutations = JSON.parse(readFileSync(CORPUS, 'utf8'))
const results = []

for (const mutation of mutations) {
  const path = join(ROOT, mutation.file)
  const original = readFileSync(path, 'utf8')
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, caught: false, why: 'anchor not found (the code moved)' })
    continue
  }
  try {
    writeFileSync(path, original.replace(mutation.from, mutation.to), 'utf8')
    // A build failure counts as caught: the mutation cannot reach the user at all.
    const built = build()
    const caught = !built || !testsPass()
    results.push({ name: mutation.name, caught, why: !built ? 'build failed' : caught ? 'a test failed' : 'NO TEST FAILED' })
  } finally {
    writeFileSync(path, original, 'utf8')
  }
}

// Always leave the tree built for whatever runs next.
if (!build()) {
  console.error('the final rebuild failed; the tree needs attention before anything else runs')
  process.exit(2)
}

let missed = 0
for (const result of results) {
  if (!result.caught) missed += 1
  console.log((result.caught ? 'CAUGHT ' : 'MISSED ') + result.name.padEnd(46) + ' <- ' + result.why)
}
console.log('\n' + (results.length - missed) + '/' + results.length + ' mutations caught by the offline suite')
process.exit(missed === 0 ? 0 : 1)
