import test from 'node:test'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
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
import { registerJevTools } from '../lib/ask-tools.js'
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

test('the test run is isolated from the operator state by the preloaded env', () => {
  // `node --import ./tests/isolate.mjs` sets these before any spec evaluates; if
  // that preload is ever dropped, the suite starts writing to the live metrics
  // and decision files and this fails instead of a deployment verdict silently
  // flipping.
  assert.ok(process.env[METRICS_PATH_ENV], 'metrics path must be redirected for tests')
  assert.ok(process.env.DSH_JEV_DECISIONS_PATH, 'decision log path must be redirected for tests')
  assert.doesNotMatch(resolveMetricsPath(), /\.dsh[\\/]jev-stats\.json$/)
})

test('applySuite registers the DSH fetch route and serves the same payload there', async () => {
  // The webServer route above was the only one exercised; the connection.fetch
  // registration DSH actually uses was never invoked, so its payload, its reset
  // and its cache headers had no gate.
  let registeredFetch: any

  const fakeCtx: any = {
    on: () => () => {},
    provide: () => () => {},
    tools: { register: () => () => {} },
    connection: {
      fetch: {
        register: (route: any) => {
          registeredFetch = route
          return () => {
            registeredFetch = undefined
          }
        },
      },
    },
  }

  const dispose = applySuite(fakeCtx, { client: { mockHandler: () => ({}) } })

  assert.ok(registeredFetch, 'the fetch route must be registered')
  assert.equal(registeredFetch.path, '/api/dsh-jev/stats')
  assert.deepEqual(registeredFetch.methods, ['GET', 'POST'])

  const getResponse = await registeredFetch.fetch({ method: 'GET' })
  assert.equal(getResponse.headers.get('cache-control'), 'no-store', 'the panel must never read a cached copy')
  assert.match(getResponse.headers.get('content-type') ?? '', /application\/json/)

  const payload = await getResponse.json()
  assert.equal(payload.version, 2)
  assert.ok(Object.hasOwn(payload, 'bench'), 'the fetch payload carries the last bench summary too')
  assert.ok(payload.systemOne && typeof payload.systemOne.totalCalls === 'number')

  // A POST with reset clears the counters instead of only reporting them.
  defaultMetrics.recordCall(120, true)
  assert.ok(defaultMetrics.getSnapshot().systemOne.totalCalls > 0)
  const resetResponse = await registeredFetch.fetch({
    method: 'POST',
    json: async () => ({ reset: true }),
  })
  assert.equal((await resetResponse.json()).systemOne.totalCalls, 0)

  // A malformed body must not throw out of the handler.
  const junk = await registeredFetch.fetch({
    method: 'POST',
    json: async () => {
      throw new Error('not json')
    },
  })
  assert.equal(junk.status, 200)

  dispose()
  assert.equal(registeredFetch, undefined)
})

test('applySuite also mounts through ctx.inject so late-loading services are picked up', () => {
  // DSH loads services dynamically; the immediate registration above covers the
  // services already present, and this path covers the ones that appear later. It
  // had no gate at all (index.js lines 238-256).
  const injected: string[][] = []
  const disposed: string[] = []
  const routes: any[] = []

  const childCtx: any = {
    get: (name: string) =>
      name === 'tools'
        ? { register: (tool: any) => { routes.push(tool); return () => {} } }
        : name === 'connection'
          ? { fetch: { register: (route: any) => { routes.push(route); return () => {} } } }
          : name === 'webServer'
            ? { register: (route: any) => { routes.push(route); return () => {} } }
            : undefined,
  }

  const fakeCtx: any = {
    on: () => () => {},
    provide: () => () => {},
    get: () => undefined,
    inject: (services: string[], callback: (child: any) => unknown) => {
      injected.push(services)
      callback(childCtx)
      return { dispose: () => disposed.push(services.join('+')) }
    },
  }

  const dispose = applySuite(fakeCtx, { client: { mockHandler: () => ({}) } })

  const awaited = new Set(injected.map((names) => names.join('+')))
  for (const service of ['tools', 'connection', 'webServer']) {
    assert.ok(awaited.has(service), service + ' must be awaited through ctx.inject')
  }
  assert.deepEqual([...awaited].sort(), ['connection', 'tools', 'webServer'], 'no other service is awaited')
  assert.ok(routes.length >= 3, 'the callbacks register what the child context provides')

  // Fibers are disposed with the plugin, so a reload cannot stack registrations.
  // (`tools` is awaited twice: the entry point mounts the primitive tool there and
  // the safety guard mounts its deterministic gate.)
  dispose()
  assert.equal(disposed.length, injected.length, 'every fiber is disposed with the plugin')
  for (const names of injected) {
    assert.ok(disposed.includes(names.join('+')), names.join('+') + ' fiber was not disposed')
  }
})

test('a host whose tools service refuses registration still gets the other mounts', async () => {
  // Each primitive is registered in its own try; one hostile service must not cost
  // the others (ask-tools.js lines 136, 206 and 262).
  const registered: string[] = []
  const fakeCtx: any = {
    on: () => () => {},
    get: (name: string) =>
      name === 'tools'
        ? {
            register: (tool: any) => {
              if (tool.name === 'jev_rank') throw new Error('host refuses this primitive')
              registered.push(tool.name)
              return () => {}
            },
          }
        : undefined,
    typesafe: new TypeSafeClient({ mockHandler: () => ({}) }),
  }

  const disposers = registerJevTools(fakeCtx, () => new TypeSafeClient({ mockHandler: () => ({}) }))

  assert.ok(registered.includes('jev_ask'), 'the other primitives still register')
  assert.ok(registered.includes('jev_check'))
  assert.ok(Array.isArray(disposers))
})

test('a false sub-config turns that module off', async () => {
  // Each module is optional, and docs/README advertise disabling them by config. The
  // pruner, router and shaper provide a service; the ask tools register tools; the two
  // guards only listen, so they are checked by driving the event they hook.
  const { Context } = await import(
    pathToFileURL(join(process.env.USERPROFILE ?? homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', '@deepseek-ai', 'cordis', 'lib', 'index.js')).href
  )

  const ctx = new (Context as any)()
  const events: string[] = []
  const originalOn = ctx.on.bind(ctx)
  ctx.on = (event: string, ...rest: any[]) => {
    events.push(event)
    return originalOn(event, ...rest)
  }
  const disabled = applySuite(ctx, {
    client: { mockHandler: () => ({}) },
    loopGuard: false,
    safetyGuard: false,
    toolPruner: false,
    skillRouter: false,
    resultShaper: false,
    askTools: false,
  })
  await new Promise((resolve) => setTimeout(resolve, 20))

  assert.equal(ctx.get('toolPruner'), undefined, 'the pruner must not provide its service')
  assert.equal(ctx.get('skillRouter'), undefined, 'the router must not provide its service')
  assert.equal(ctx.get('resultShaper'), undefined, 'the shaper must not provide its service')
  assert.equal(ctx.get('tools')?.get?.('jev_ask'), undefined, 'the ask tools must not be registered')
  assert.ok(!events.includes('tools/pre-execute'), 'the safety guard must not listen')
  assert.ok(!events.includes('system-prompt/assemble'), 'assemble listeners must not be mounted')
  // The loop guard hooks post-execute, which the shaper also hooks: with both off it is
  // the only remaining registrant, so its absence is observable here.
  assert.ok(!events.includes('tools/post-execute'), 'no post-execute listener should remain')
  disabled()
})
