/**
 * Mutation sweep: break a behaviour, rebuild, and ask whether any test notices.
 *
 * Coverage says "this line ran"; this says "someone would find out if it broke".
 * The corpus is deliberately small and hand-picked - each entry targets a knob or a
 * guard whose silent removal would change user-visible behaviour.
 *
 * Safety: a sweep edits tracked sources, so it refuses to start on a dirty tree and
 * restores every file it touched on exit, on an unhandled error and on an interrupt.
 * A transient filesystem error once aborted a run mid-mutation and left the broken
 * source behind, one `git add -A` away from being committed.
 *
 * Usage: pnpm run verify:mutants
 *
 * The name follows the verify-*.mjs convention: the evidence index maps each such
 * file to the pnpm script of the same name.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
// An exploratory sweep can point at its own corpus; the committed one stays untouched.
const CORPUS = process.env.JEV_MUTATIONS
  ? join(ROOT, process.env.JEV_MUTATIONS)
  : join(ROOT, 'bench', 'mutations.json')

/** Every file this run has edited, with the content to put back. */
const pending = new Map()

function gitStatus(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', cwd: ROOT }).trim()
  } catch {
    return undefined
  }
}

function restoreAll() {
  let restored = 0
  for (const [path, content] of pending) {
    try {
      if (readFileSync(path, 'utf8') !== content) {
        writeFileSync(path, content, 'utf8')
        restored += 1
      }
    } catch {
      console.error('could not restore ' + path + ' - restore it before committing')
    }
  }
  pending.clear()
  return restored
}

let restoredAndRebuilt = false
function restoreAndRebuild() {
  if (restoredAndRebuilt) return
  restoredAndRebuilt = true
  restoreAll()
  // Always rebuild, even when nothing needed restoring: the last entry's build output
  // still carries that mutation, and tsc skips re-emitting an unchanged source, so the
  // tree would otherwise be left with a mutated lib/.
  try {
    execFileSync('pnpm', ['run', 'build'], { stdio: 'ignore', shell: true, cwd: ROOT })
  } catch {
    console.error('the rebuild after restoring failed; run `pnpm run build` before anything else')
  }
}

// The tree is the tool's working surface: refuse to start unless it is clean, so a
// leftover mutation from an interrupted run is caught instead of swept up by a commit.
const dirty = gitStatus(['status', '--porcelain'])
if (dirty === undefined) {
  console.error('refusing to run: this is not a git working tree, so edits cannot be undone safely')
  process.exit(2)
}
if (dirty !== '') {
  console.error('refusing to run: commit or stash the working tree first\n' + dirty)
  process.exit(2)
}

process.on('exit', () => restoreAndRebuild())
process.on('SIGINT', () => {
  restoreAndRebuild()
  process.exit(130)
})
process.on('uncaughtException', (error) => {
  console.error('the sweep failed:', error instanceof Error ? error.message : String(error))
  restoreAndRebuild()
  process.exit(2)
})

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

function applyMutation(path, content) {
  pending.set(path, content)
  writeFileSync(path, content, 'utf8')
}

/** Where a source file's compiled output lands. */
function compiledPath(file) {
  return file.startsWith('src/') ? file.replace(/^src\//, 'lib/').replace(/\.ts$/, '.js') : undefined
}

function fingerprint(path) {
  try {
    return String(readFileSync(path)).length + ':' + createHash('sha1').update(readFileSync(path)).digest('hex')
  } catch {
    return undefined
  }
}

const mutations = JSON.parse(readFileSync(CORPUS, 'utf8'))
const results = []

for (const mutation of mutations) {
  const path = join(ROOT, mutation.file)
  let original
  try {
    original = readFileSync(path, 'utf8')
  } catch (error) {
    results.push({ name: mutation.name, caught: false, why: 'could not read ' + mutation.file })
    continue
  }
  if (!original.includes(mutation.from)) {
    results.push({ name: mutation.name, caught: false, why: 'anchor not found (the code moved)' })
    continue
  }
  try {
    const compiled = compiledPath(mutation.file)
    const compiledFull = compiled === undefined ? undefined : join(ROOT, compiled)
    const before = compiledFull === undefined ? undefined : fingerprint(compiledFull)
    applyMutation(path, original.replace(mutation.from, mutation.to))
    // A build failure counts as caught: the mutation cannot reach the user at all.
    const built = build()
    const after = compiledFull === undefined ? undefined : fingerprint(compiledFull)
    if (built && before !== undefined && before === after) {
      // The source changed but the emitted module did not, so the tests just ran against
      // behaviour the mutation never touched - reporting CAUGHT here would be a lie.
      results.push({ name: mutation.name, caught: false, why: 'the build did not pick up the change' })
      continue
    }
    const caught = !built || !testsPass()
    results.push({ name: mutation.name, caught, why: !built ? 'build failed' : caught ? 'a test failed' : 'NO TEST FAILED' })
  } catch (error) {
    // One entry failing (a locked file, a killed build) must not abandon the rest.
    results.push({ name: mutation.name, caught: false, why: 'the entry failed: ' + (error instanceof Error ? error.message : String(error)) })
  } finally {
    applyMutation(path, original)
    restoreAll()
  }
}

restoreAndRebuild()

const leftOver = gitStatus(['status', '--porcelain', '--', 'src', 'lib'])
if (leftOver === undefined || leftOver !== '') {
  console.error('the sweep left changes behind:\n' + (leftOver ?? '(git status failed)'))
  process.exit(2)
}

let missed = 0
for (const result of results) {
  if (!result.caught) missed += 1
  console.log((result.caught ? 'CAUGHT ' : 'MISSED ') + result.name.padEnd(46) + ' <- ' + result.why)
}
console.log('\n' + (results.length - missed) + '/' + results.length + ' mutations caught by the offline suite')
process.exit(missed === 0 ? 0 : 1)
