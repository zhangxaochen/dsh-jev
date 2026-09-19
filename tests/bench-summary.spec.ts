import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readBenchSummary, renderBenchLine } from '../lib/bench-summary.js'

function tempDir(): string {
  const dir = join(tmpdir(), 'jev-bench-' + Date.now() + '-' + Math.random().toString(36).slice(2))
  mkdirSync(dir, { recursive: true })
  return dir
}

test('readBenchSummary returns undefined when the run has not happened', () => {
  const dir = tempDir()
  assert.equal(readBenchSummary(join(dir, 'missing.json')), undefined)

  const broken = join(dir, 'broken.json')
  writeFileSync(broken, '{not json', 'utf8')
  assert.equal(readBenchSummary(broken), undefined)

  const empty = join(dir, 'empty.json')
  writeFileSync(empty, '{"note":"no totals"}', 'utf8')
  assert.equal(readBenchSummary(empty), undefined)

  rmSync(dir, { recursive: true, force: true })
})

test('readBenchSummary normalizes a written summary', () => {
  const dir = tempDir()
  const file = join(dir, 'jev-bench.json')
  writeFileSync(
    file,
    JSON.stringify({
      ranAt: '2026-09-18T19:26:32.243Z',
      offline: true,
      total: 30,
      correct: 28,
      accuracy: 0.933,
      falsePositives: 0,
      falseNegatives: 2,
      latencyMeanMs: 0,
    }),
    'utf8'
  )

  const summary = readBenchSummary(file)
  assert.equal(summary?.total, 30)
  assert.equal(summary?.falsePositives, 0)
  assert.equal(summary?.falseNegatives, 2)
  assert.equal(summary?.offline, true)

  const line = renderBenchLine(summary)
  assert.match(line, /28\/30 正确/)
  assert.match(line, /误报 0/)
  assert.match(line, /离线回放/)

  rmSync(dir, { recursive: true, force: true })
})

test('renderBenchLine explains the absence instead of inventing numbers', () => {
  const line = renderBenchLine(undefined)
  assert.match(line, /暂无记录/)
  assert.match(line, /pnpm run bench/)
})

test('the rendered bench line reports the summary it was given', () => {
  // The line is user-visible in the dashboard and the stats tool markdown, so a hardcoded
  // accuracy (or a wrong ratio) would be a claim about a run that never happened.
  const line = renderBenchLine({
    ranAt: '2026-09-20T00:00:00.000Z',
    offline: false,
    total: 40,
    correct: 20,
    accuracy: 0.5,
    knownMisses: 2,
    falsePositives: 0,
    falseNegatives: 0,
    latencyTotalMs: 1000,
    latencyMeanMs: 25,
    inputBytesTotal: 0,
    estimatedCostUsd: 0,
  })

  assert.match(line, /20\/40/, 'the ratio must come from the summary')
  assert.match(line, /50\.0%/, 'the accuracy must come from the summary')
  assert.match(line, /真实 API/, 'an online run is labelled as such')
})
