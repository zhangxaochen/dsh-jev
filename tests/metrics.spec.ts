import test from 'node:test'
import assert from 'node:assert/strict'
import { rmSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  MetricsCollector,
  TOKENS_PER_PRUNED_TOOL,
  TOKENS_PER_INTERRUPTED_LOOP,
  defaultMetrics,
} from '../lib/metrics.js'
import { apply as applySuite } from '../lib/index.js'
import { TypeSafeClient } from '../lib/client.js'

test('MetricsCollector tracks pruning, loop checks, safety screens, and calls', () => {
  const testFile = join(tmpdir(), `jev-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const collector = new MetricsCollector(testFile)

  // 1. Record pruning
  collector.recordPrune(10, 3) // 7 pruned
  let snap = collector.getSnapshot()
  assert.equal(snap.toolPruner.evaluations, 1)
  assert.equal(snap.toolPruner.toolsPruned, 7)
  assert.equal(snap.toolPruner.toolsRetained, 3)
  assert.equal(snap.toolPruner.estimatedTokensSaved, 7 * TOKENS_PER_PRUNED_TOOL)

  // 2. Record loop checks
  collector.recordLoopCheck('normal')
  collector.recordLoopCheck('warn')
  collector.recordLoopCheck('interrupt')
  snap = collector.getSnapshot()
  assert.equal(snap.loopGuard.checks, 3)
  assert.equal(snap.loopGuard.warned, 1)
  assert.equal(snap.loopGuard.interrupted, 1)
  assert.equal(snap.loopGuard.estimatedTokensSaved, TOKENS_PER_INTERRUPTED_LOOP)

  // 3. Record safety checks
  collector.recordSafetyCheck('pass')
  collector.recordSafetyCheck('ask')
  collector.recordSafetyCheck('deny')
  snap = collector.getSnapshot()
  assert.equal(snap.safetyGuard.screened, 3)
  assert.equal(snap.safetyGuard.approvals, 1)
  assert.equal(snap.safetyGuard.blocked, 1)

  // 4. Record System One calls
  collector.recordCall(50, true)
  collector.recordCall(150, true)
  collector.recordCall(200, false)
  snap = collector.getSnapshot()
  assert.equal(snap.systemOne.totalCalls, 3)
  assert.equal(snap.systemOne.errors, 1)
  assert.equal(snap.systemOne.totalLatencyMs, 200)
  assert.equal(snap.systemOne.avgLatencyMs, 100)

  // 5. Total tokens saved math
  const expectedTokens = 7 * TOKENS_PER_PRUNED_TOOL + TOKENS_PER_INTERRUPTED_LOOP
  assert.equal(collector.getTotalTokensSaved(), expectedTokens)

  // 6. Persistence verification
  assert.ok(existsSync(testFile))
  const reloaded = new MetricsCollector(testFile)
  assert.deepEqual(reloaded.getSnapshot(), snap)

  // 7. Markdown dashboard rendering
  const md = collector.renderMarkdownDashboard()
  assert.ok(md.includes('TypeSafe Jev 守护与收益看板'))
  assert.ok(md.includes('工具动态剪枝'))
  assert.ok(md.includes('死循环及早止损'))
  assert.ok(md.includes('执行安全护栏'))
  assert.ok(md.includes('System One 响应'))

  // 8. Reset
  collector.reset()
  const resetSnap = collector.getSnapshot()
  assert.equal(resetSnap.toolPruner.evaluations, 0)
  assert.equal(resetSnap.loopGuard.checks, 0)
  assert.equal(resetSnap.safetyGuard.screened, 0)
  assert.equal(resetSnap.systemOne.totalCalls, 0)
  assert.equal(collector.getTotalTokensSaved(), 0)

  // Cleanup
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

  // Execute tool
  const result = await registeredTool.execute({})
  assert.ok(typeof result.markdown === 'string')
  assert.ok(typeof result.tokensSaved === 'number')

  // Render check
  const rendered = registeredTool.output.render({}, result)
  assert.ok(Array.isArray(rendered))
  assert.equal(rendered[0].type, 'text')
  assert.equal(rendered[0].text, result.markdown)

  // Web route check
  assert.ok(registeredRoute)
  assert.equal(registeredRoute.path, '/dsh-jev/stats')

  let jsonOutput = ''
  const fakeRes: any = {
    writeHead: () => {},
    end: (str: string) => {
      jsonOutput = str
    },
  }
  registeredRoute.handler({ headers: { accept: 'application/json' } }, fakeRes)
  const parsed = JSON.parse(jsonOutput)
  assert.equal(parsed.version, 1)

  // Disposer check
  dispose()
  assert.equal(registeredTool, undefined)
  assert.equal(registeredRoute, undefined)
})
