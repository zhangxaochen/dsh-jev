/**
 * The dashboard must show what the plugin measures, and must not read fields
 * that do not exist.
 *
 * Both failures are silent: a renamed metric renders as `0` in the panel, and a
 * measured dimension with no card is simply never seen. These checks read the
 * metrics shape out of the collector itself and the UI's field accesses out of
 * the source, then compare the two sets in both directions.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MetricsCollector } from '../lib/metrics.js'

/** A path no earlier run can have written, so counters never accumulate. */
function freshMetricsPath(): string {
  return join(tmpdir(), 'jev-surface-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
}

const CLIENT_SOURCE = readFileSync(join(process.cwd(), 'src', 'client.ts'), 'utf8')
const BENCH_SOURCE = readFileSync(join(process.cwd(), 'src', 'bench-summary.ts'), 'utf8')

/** Every `data?.section?.field` the settings panel reads. */
function readPaths() {
  const reads = new Set()
  for (const match of CLIENT_SOURCE.matchAll(/data\??\.(\w+)\??\.(\w+)/g)) {
    reads.add(match[1] + '.' + match[2])
  }
  return reads
}

/** The field names of the BenchSummary interface the stats route serves. */
function benchSummaryFields() {
  const block = BENCH_SOURCE.match(/export interface BenchSummary \{([\s\S]*?)\n\}/)
  assert.ok(block, 'BenchSummary interface not found')
  return [...block[1].matchAll(/^\s{2}(\w+)\??:/gm)].map((match) => match[1])
}

/** The sections and fields a live metrics snapshot actually carries. */
function snapshotPaths() {
  const snapshot = new MetricsCollector(freshMetricsPath()).getSnapshot()
  const paths = new Set()
  for (const [key, value] of Object.entries(snapshot)) {
    if (value && typeof value === 'object') {
      for (const field of Object.keys(value)) paths.add(key + '.' + field)
    } else {
      paths.add(key)
    }
  }
  for (const field of benchSummaryFields()) paths.add('bench.' + field)
  return paths
}

test('every metric the settings panel reads exists in the snapshot', () => {
  const paths = snapshotPaths()
  const unknown = [...readPaths()].filter((path) => !paths.has(path)).sort()
  assert.deepEqual(unknown, [], 'the panel reads fields the snapshot does not carry')
})

test('every measured section is surfaced in the settings panel', () => {
  const snapshot = new MetricsCollector(freshMetricsPath()).getSnapshot()
  const shown = new Set([...readPaths()].map((path) => path.split('.')[0]))
  const missing = Object.keys(snapshot).filter(
    (section) => typeof snapshot[section] === 'object' && !shown.has(section)
  )
  assert.deepEqual(missing, [], 'a measured section has no card: ' + missing.join(', '))
})

test('the markdown dashboard reports every measured section', () => {
  const collector = new MetricsCollector(freshMetricsPath())
  collector.recordPrune(5, 2, { removedChars: 100, estimatedTokens: 30, tokenSource: 'heuristic' })
  collector.recordLoopCheck('warn')
  collector.recordSafetyCheck('deny')
  collector.recordShape(500)
  collector.recordCall(120, true, { inputBytes: 900 })

  const markdown = collector.renderMarkdownDashboard()
  for (const label of ['工具动态剪枝', '死循环及早止损', '执行安全护栏', '语义结果整形', 'System One 响应']) {
    assert.ok(markdown.includes(label), 'dashboard row missing: ' + label)
  }
  // The row must report the recorded fact, not a placeholder.
  assert.match(markdown, /整形 \*\*1\*\* 次，精确移除 \*\*500\*\* 字符/)
  assert.match(markdown, /累计可测收益/)
})
