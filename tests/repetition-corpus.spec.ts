/**
 * Corpus for the shaper's cheap pre-check.
 *
 * `looksRepetitive` decides whether an oversized result is worth one bounded model
 * request, so both mistakes cost something: firing on prose spends a request for
 * nothing, and staying silent on bulk skips the feature entirely. The cases below
 * are real output shapes, and the notes say why each verdict is the intended one -
 * two of them look like prose but differ only in a number, which is exactly the
 * structural repetition the pre-check exists to catch.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { looksRepetitive } from '../lib/result-shaper.js'

function repeated(line: string, times: number): string {
  return Array.from({ length: times }, () => line).join('\n')
}

function varied(prefix: string, times: number): string {
  return Array.from({ length: times }, (_, index) => prefix + index).join('\n')
}

interface Case {
  text: string
  expect: boolean
  note: string
}

const CASES: Case[] = [
  // Bulk: one bounded decision is worth the request.
  { text: repeated('downloading... 100%', 300), expect: true, note: 'identical progress lines' },
  { text: varied('[build] module src/feature-', 300), expect: true, note: 'numbered build log' },
  { text: varied('│   ├── pkg-1.', 300), expect: true, note: 'dependency tree' },
  { text: varied('-rw-r--r--  1 user  1234 Jan  1 file-', 300), expect: true, note: 'directory listing' },
  { text: varied('commit 4f9a2b1c8e', 200), expect: true, note: 'git log with hashes' },
  { text: repeated('x'.repeat(40), 200), expect: true, note: 'repeated long lines' },
  { text: 'y'.repeat(5000), expect: true, note: 'a single very long line' },
  { text: varied('2026-09-20T10:00:00Z INFO request id=', 150), expect: true, note: 'timestamped logs' },

  // Structurally identical lines: these read like prose but differ only by a number,
  // which the pre-check is meant to catch. The classifier still decides what lives.
  {
    text: varied('Line ', 60).replace(/(\d+)/g, '$1 of a report with distinct wording throughout'),
    expect: true,
    note: 'numbered report lines, one shape',
  },
  {
    text: Array.from({ length: 40 }, (_, i) => '  at function' + i + ' (/src/file' + i + '.ts:1:' + i + ')').join('\n'),
    expect: true,
    note: 'a stack trace, one frame shape',
  },
  {
    text: Array.from({ length: 150 }, (_, i) => '2026-09-20 INFO service ' + i + ' ready after ' + i + 'ms').join('\n'),
    expect: true,
    note: 'a service log with per-line numbers only',
  },

  // Genuinely varied or short output: a request would be wasted.
  { text: 'Build finished in 3.2s with 0 errors.', expect: false, note: 'a one-line result' },
  {
    text: Array.from({ length: 30 }, (_, i) => 'The quick brown fox jumps over the lazy dog number ' + i).join('\n'),
    expect: false,
    note: 'thirty short varied lines',
  },
  {
    // The words differ per line as well as the number, so the shapes are distinct:
    // 64 word pairs over 60 lines, and every line takes a different pair.
    text: Array.from({ length: 60 }, (_, i) => {
      const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta']
      return words[i % 8] + ' ' + words[((i * 3) % 8 + Math.floor(i / 8)) % 8] + ' item ' + i
    }).join('\n'),
    expect: false,
    note: 'sixty lines that differ in wording as well as number',
  },
  { text: '', expect: false, note: 'empty output' },
  { text: '\n\n\n', expect: false, note: 'blank lines only' },
]

test('the pre-check sorts real output shapes correctly', () => {
  const wrong = CASES.filter((entry) => looksRepetitive(entry.text) !== entry.expect).map(
    (entry) => entry.note + ': expected ' + entry.expect
  )
  assert.deepEqual(wrong, [], 'the pre-check misjudged these shapes')
})

test('the pre-check is cheap: it never needs the model', () => {
  // It runs on every oversized tool result, so it must stay a pure string check.
  const started = Date.now()
  for (const entry of CASES) looksRepetitive(entry.text)
  assert.ok(Date.now() - started < 250, 'the pre-check should not be doing real work')
})
