import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  FALLBACK_CHARS_PER_TOKEN,
  METRICS_PATH_ENV,
  MetricsCollector,
  defaultMetrics,
  resolveMetricsPath,
} from '../lib/metrics.js'
import { apply as applySuite } from '../lib/index.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'

test('MetricsCollector records measured pruning, loop, safety and call facts', () => {
  const testFile = join(tmpdir(), 'jev-test-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  const collector = new MetricsCollector(testFile)

  collector.recordPrune(10, 3, { removedChars: 700, estimatedTokens: 200, tokenSource: 'heuristic' })
  let snap = collector.getSnapshot()
  assert.equal(snap.toolPruner.evaluations, 1)
  assert.equal(snap.toolPruner.toolsPruned, 7)
  assert.equal(snap.toolPruner.toolsRetained, 3)
  assert.equal(snap.toolPruner.removedSchemaChars, 700)
  assert.equal(snap.toolPruner.estimatedTokensSaved, 200)
  assert.equal(snap.toolPruner.tokenSource, 'heuristic')

  // A different estimator must be reported as a mixed basis rather than silently.
  collector.recordPrune(5, 5, { removedChars: 10, estimatedTokens: 3, tokenSource: 'tokenMeter' })
  snap = collector.getSnapshot()
  assert.equal(snap.toolPruner.tokenSource, 'mixed')

  collector.recordLoopCheck('normal')
  collector.recordLoopCheck('warn')
  collector.recordLoopCheck('interrupt')
  collector.recordLoopCheck('uncertain')
  snap = collector.getSnapshot()
  assert.equal(snap.loopGuard.checks, 4)
  assert.equal(snap.loopGuard.warned, 1)
  assert.equal(snap.loopGuard.interrupted, 1)
  assert.equal(snap.loopGuard.notices, 2)
  assert.equal(snap.loopGuard.uncertain, 1)

  collector.recordSafetyCheck('pass')
  collector.recordSafetyCheck('ask')
  collector.recordSafetyCheck('deny')
  collector.recordHardDeny()
  collector.recordUncertainDeny()
  snap = collector.getSnapshot()
  assert.equal(snap.safetyGuard.screened, 5)
  assert.equal(snap.safetyGuard.approvals, 1)
  assert.equal(snap.safetyGuard.blocked, 3)
  assert.equal(snap.safetyGuard.hardDenied, 1)
  assert.equal(snap.safetyGuard.uncertainDenied, 1)

  collector.recordCall(50, true, { inputBytes: 400, estimatedCostUsd: 0.0000042 })
  collector.recordCall(150, true, { inputBytes: 800, estimatedCostUsd: 0.0000084 })
  collector.recordCall(0, true, { cacheHit: true })
  collector.recordCall(200, false)
  snap = collector.getSnapshot()
  assert.equal(snap.systemOne.totalCalls, 4)
  assert.equal(snap.systemOne.errors, 1)
  assert.equal(snap.systemOne.totalLatencyMs, 200)
  assert.equal(snap.systemOne.avgLatencyMs, 100)
  assert.equal(snap.systemOne.cacheHits, 1)
  assert.equal(snap.systemOne.inputBytes, 1200)
  assert.ok(Math.abs(snap.systemOne.estimatedCostUsd - 0.0000126) < 1e-9)

  collector.recordDecisionError()
  snap = collector.getSnapshot()
  assert.equal(snap.systemOne.decisionErrors, 1)

  // Only the tool surface contributes a token total; loop notices never invent one.
  assert.equal(collector.getTotalTokensSaved(), 203)

  assert.ok(existsSync(testFile))
  const reloaded = new MetricsCollector(testFile)
  assert.deepEqual(reloaded.getSnapshot(), snap)

  const md = collector.renderMarkdownDashboard()
  assert.ok(md.includes('TypeSafe Jev 守护与收益看板'))
  assert.ok(md.includes('累计可测收益'))
  assert.ok(md.includes('不做不可测的 token 折算'))

  collector.reset()
  assert.equal(collector.getSnapshot().toolPruner.evaluations, 0)
  assert.equal(collector.getTotalTokensSaved(), 0)

  try {
    rmSync(testFile, { force: true })
  } catch {}
})

test('applySuite mounts jev_stats tool and stats web route', async () => {
  let registeredTool: any
  let registeredRoute: any

  const fakeCtx: any = {
    on: () => () => {},
    provide: () => () => {},
    tools: {
      register: (tool: any) => {
        registeredTool = tool
        return () => {
          registeredTool = undefined
        }
      },
    },
    webServer: {
      register: (route: any) => {
        registeredRoute = route
        return () => {
          registeredRoute = undefined
        }
      },
    },
  }

  const dispose = applySuite(fakeCtx, {
    client: {
      mockHandler: () => ({}),
    },
  })

  assert.ok(registeredTool)
  assert.equal(registeredTool.name, 'jev_stats')
  assert.ok(registeredTool.output.render)

  const result = await registeredTool.execute({})
  assert.ok(typeof result.markdown === 'string')
  assert.ok(typeof result.tokensSaved === 'number')

  const rendered = registeredTool.output.render({}, result)
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].type, 'text')

  assert.ok(registeredRoute)
  assert.equal(registeredRoute.path, '/api/dsh-jev/stats')

  let jsonOutput = ''
  const fakeRes: any = {
    writeHead: () => {},
    end: (str: string) => {
      jsonOutput = str
    },
  }
  registeredRoute.handler({ headers: { accept: 'application/json' } }, fakeRes)
  const parsed = JSON.parse(jsonOutput)
  assert.equal(parsed.version, 2)
  assert.ok(Object.hasOwn(parsed, 'bench'), 'the stats payload carries the last bench summary')
  assert.ok(parsed.bench === null || typeof parsed.bench.total === 'number')

  dispose()
  assert.equal(registeredTool, undefined)
  assert.equal(registeredRoute, undefined)
})

test('MetricsCollector accepts a legacy v1 file by starting a fresh v2 record', () => {
  const testFile = join(tmpdir(), 'jev-legacy-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  const collector = new MetricsCollector(testFile)
  collector.recordSafetyCheck('pass')
  assert.equal(collector.getSnapshot().version, 2)
  assert.ok(FALLBACK_CHARS_PER_TOKEN > 0)
  assert.ok(defaultMetrics.getSnapshot().version === 2)
  try {
    rmSync(testFile, { force: true })
  } catch {}
})

test('the metrics path is overridable and resolved lazily', () => {
  assert.equal(resolveMetricsPath('/explicit/path.json'), '/explicit/path.json')

  const previous = process.env[METRICS_PATH_ENV]
  process.env[METRICS_PATH_ENV] = '/from/env.json'
  try {
    assert.equal(resolveMetricsPath(), '/from/env.json')
    // An explicit argument still wins over the environment.
    assert.equal(resolveMetricsPath('/explicit.json'), '/explicit.json')
  } finally {
    if (previous === undefined) delete process.env[METRICS_PATH_ENV]
    else process.env[METRICS_PATH_ENV] = previous
  }

  assert.match(resolveMetricsPath(), /jev-stats\.json$/)
})

test('constructing a collector touches nothing until it records', () => {
  const target = join(tmpdir(), 'jev-lazy-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  const collector = new MetricsCollector(target)

  assert.equal(existsSync(target), false, 'construction must not create a metrics file')
  collector.getSnapshot()
  assert.equal(existsSync(target), false, 'reading a snapshot must not create the file either')

  collector.recordSafetyCheck('pass')
  assert.equal(existsSync(target), true)
  assert.equal(JSON.parse(readFileSync(target, 'utf8')).version, 2)

  rmSync(target, { force: true })
})

test('the environment override routes a collector to a scratch file', () => {
  const target = join(tmpdir(), 'jev-env-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  const previous = process.env[METRICS_PATH_ENV]
  process.env[METRICS_PATH_ENV] = target
  try {
    const collector = new MetricsCollector()
    collector.recordLoopCheck('warn')
    assert.equal(existsSync(target), true)
    assert.equal(JSON.parse(readFileSync(target, 'utf8')).loopGuard.checks, 1)
  } finally {
    if (previous === undefined) delete process.env[METRICS_PATH_ENV]
    else process.env[METRICS_PATH_ENV] = previous
    rmSync(target, { force: true })
  }
})
