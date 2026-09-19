/**
 * README contracts.
 *
 * The install section used to carry a hand-copied copy of the bundle config and an
 * unclosed ```ts fence. The copy kept 0.1.0's five-tool `guardedTools` list after the
 * shipped patch had been widened to eight - anyone who followed it lost the semantic
 * gate on file writes - and the missing fence turned every later section into a single
 * TypeScript code block. Neither is visible in review, and both are cheap to check.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_GUARDED_TOOLS } from '../lib/safety-guard.js'

const ROOT = process.cwd()
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const README_PATH = join(ROOT, 'README.md')
const README = readFileSync(README_PATH, 'utf8')
const LINES = README.split('\n')

test('every code fence in the README is closed', () => {
  let open = false
  let opened = 0
  const problems: string[] = []

  LINES.forEach((line, index) => {
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

  assert.deepEqual(problems, [], 'a fence line is both closing and annotated')
  assert.equal(open, false, 'the README ends inside a code fence')
  assert.ok(opened >= 6, 'expected the README to keep its examples, saw ' + opened + ' block(s)')
})

test('every dsh-jev specifier the README imports is exported by the manifest', () => {
  const specifiers = new Set(
    [...README.matchAll(/from '(dsh-jev[^']*)'/g)].map((match) => match[1])
  )
  assert.ok(specifiers.size > 0, 'expected the README to show at least one import')

  for (const specifier of specifiers) {
    if (specifier === 'dsh-jev') continue
    const subpath = './' + specifier.slice('dsh-jev/'.length)
    assert.ok(
      Object.hasOwn(pkg.exports, subpath),
      specifier + ' is not an export of package.json - readers cannot import it'
    )
  }
})

test('the README never mounts the browser panel as a plugin', () => {
  // `dsh-jev/client` is the settings panel the host loads through client-modules; it
  // exports no `apply`, so mounting it throws in cordis.
  assert.doesNotMatch(
    README,
    /from 'dsh-jev\/client'/,
    'dsh-jev/client is the browser panel and must not be presented as importable'
  )
})

test('the README points at the shipped patch instead of restating the config', () => {
  // A patch replaces the row's whole config, so a docs copy is the natural thing to
  // write down - and it drifts silently. The installed copy is the one the packaging
  // test pins to the code defaults.
  assert.match(
    README,
    /dsh-jev\/cordis\.patch\.yml/,
    'the override instructions must start from the installed cordis.patch.yml'
  )

  const inline = [...README.matchAll(/^\s*-\s*insert:/gm)]
  if (inline.length === 0) return

  // If a config is restated anyway, it must not narrow the guarded set.
  const start = LINES.findIndex((line) => line.trim() === 'guardedTools:')
  assert.ok(start >= 0, 'an inline bundle config must restate guardedTools in full')
  const keyIndent = LINES[start].length - LINES[start].trimStart().length
  const listed = new Set<string>()
  for (const line of LINES.slice(start + 1)) {
    const trimmed = line.trim()
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue
    if (line.length - line.trimStart().length <= keyIndent) break
    if (trimmed.startsWith('- ')) listed.add(trimmed.slice(2))
  }
  const missing = DEFAULT_GUARDED_TOOLS.filter((tool) => !listed.has(tool))
  assert.deepEqual(
    missing,
    [],
    'the README copy silently narrows the guarded set: ' + missing.join(', ')
  )
})
