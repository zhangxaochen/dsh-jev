/**
 * Documentation contracts.
 *
 * The install section used to carry a hand-copied copy of the bundle config and an
 * unclosed ```ts fence. The copy kept 0.1.0's five-tool `guardedTools` list after the
 * shipped patch had been widened to eight - anyone who followed it lost the semantic
 * gate on file writes - and the missing fence turned every later section into a single
 * TypeScript code block. Neither is visible in review, and both are cheap to check.
 *
 * The same checks run over docs/configuration.md, which now owns the reference
 * material the README used to inline: splitting the front door from the manual must
 * not move anything outside the guards.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GUARDED_TOOLS } from '../lib/safety-guard.js'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const DOCS = ['README.md', 'docs/configuration.md'].map((name) => ({
  name,
  text: readFileSync(join(ROOT, ...name.split('/')), 'utf8'),
}))
const COMBINED = DOCS.map((doc) => doc.text).join('\n')

// One test over both documents: a `test()` inside a loop would count as two, and the
// suite total in docs/verification-report.md is compared against the declared count.
test('every code fence in the docs is closed', () => {
  for (const doc of DOCS) {
    const lines = doc.text.split('\n')
    let open = false
    let opened = 0
    const problems: string[] = []

    lines.forEach((line, index) => {
      if (!line.startsWith('```')) return
      const info = line.slice(3).trim()
      if (!open) {
        open = true
        opened += 1
        return
      }
      // A closing fence may not carry an info string, so ```bash inside a block is
      // content rather than a close - the exact shape that swallowed ~200 lines.
      if (info.length > 0) {
        problems.push('line ' + (index + 1) + ': "' + line + '" cannot close a fence')
        return
      }
      open = false
    })

    assert.deepEqual(problems, [], doc.name + ' has a fence line that is both closing and annotated')
    assert.equal(open, false, doc.name + ' ends inside a code fence')
    assert.ok(opened >= 1, doc.name + ' lost its examples, saw ' + opened + ' block(s)')
  }
})

test('the documentation keeps enough examples to be followed', () => {
  const blocks = DOCS.reduce((total, doc) => total + (doc.text.match(/^```/gm) ?? []).length / 2, 0)
  assert.ok(blocks >= 6, 'expected the docs to keep their examples, saw ' + blocks + ' block(s)')
})

test('every dsh-jev specifier the docs import is exported by the manifest', () => {
  const specifiers = new Set(
    [...COMBINED.matchAll(/from '(dsh-jev[^']*)'/g)].map((match) => match[1])
  )
  assert.ok(specifiers.size > 0, 'expected the docs to show at least one import')

  for (const specifier of specifiers) {
    if (specifier === 'dsh-jev') continue
    const subpath = './' + specifier.slice('dsh-jev/'.length)
    assert.ok(
      Object.hasOwn(pkg.exports, subpath),
      specifier + ' is not an export of package.json - readers cannot import it'
    )
  }
})

test('the docs never mount the browser panel as a plugin', () => {
  // `dsh-jev/client` is the settings panel the host loads through client-modules; it
  // exports no `apply`, so mounting it throws in cordis.
  assert.doesNotMatch(
    COMBINED,
    /from 'dsh-jev\/client'/,
    'dsh-jev/client is the browser panel and must not be presented as importable'
  )
})

test('the docs point at the shipped patch instead of restating the config', () => {
  // A patch replaces the row's whole config, so a docs copy is the natural thing to
  // write down - and it drifts silently. The installed copy is the one the packaging
  // test pins to the code defaults.
  assert.match(
    COMBINED,
    /dsh-jev\/cordis\.patch\.yml/,
    'the override instructions must start from the installed cordis.patch.yml'
  )

  const inline = [...COMBINED.matchAll(/^\s*-\s*insert:/gm)]
  if (inline.length === 0) return

  // If a config is restated anyway, it must not narrow the guarded set.
  const lines = COMBINED.split('\n')
  const start = lines.findIndex((line) => line.trim() === 'guardedTools:')
  assert.ok(start >= 0, 'an inline bundle config must restate guardedTools in full')
  const keyIndent = lines[start].length - lines[start].trimStart().length
  const listed = new Set<string>()
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (line.length - line.trimStart().length <= keyIndent) break
    if (trimmed.startsWith('- ')) listed.add(trimmed.slice(2))
  }
  const missing = DEFAULT_GUARDED_TOOLS.filter((tool) => !listed.has(tool))
  assert.deepEqual(
    missing,
    [],
    'the documented copy silently narrows the guarded set: ' + missing.join(', ')
  )
})
