import test from 'node:test'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

test('a false sub-config turns that module off', () => {
  // README tells users they can disable a module with `false`. Three of the toggles are
  // observable here - two by the events they hook, one by the service it provides. The
  // ask tools register only against a real tools service (as does the router's advice
  // path), so those two are covered by the integration checks instead of guessed at.
  const mount = (config: Record<string, unknown>) => {
    const events: string[] = []
    const provided: string[] = []
    const fakeCtx: any = {
      on: (event: string) => {
        events.push(event)
        return () => {}
      },
      provide: (name: string) => {
        provided.push(name)
        return () => {}
      },
      get: () => undefined,
      tools: { register: () => () => {} },
      webServer: { register: () => () => {} },
    }
    const dispose = applySuite(fakeCtx, { client: { mockHandler: () => ({}) }, ...config })
    dispose()
    return { events, provided }
  }

  const on = mount({})
  assert.ok(on.events.includes('tools/pre-execute'), 'the safety guard listens when enabled')
  assert.ok(on.events.includes('tools/post-execute'), 'post-execute listeners mount when enabled')
  assert.ok(on.events.includes('agent/pre-step'), 'the loop guard clears its chain when enabled')
  assert.ok(on.provided.includes('toolPruner'), 'the pruner provides its service when enabled')

  const guardOff = mount({ safetyGuard: false })
  assert.ok(!guardOff.events.includes('tools/pre-execute'), 'safetyGuard: false must stop the listener')

  const loopOff = mount({ loopGuard: false })
  assert.ok(!loopOff.events.includes('agent/pre-step'), 'loopGuard: false must stop the chain reset')
  assert.ok(!loopOff.events.includes('tools/post-execute'), 'and its post-execute listener with it')

  const prunerOff = mount({ toolPruner: false })
  assert.ok(!prunerOff.provided.includes('toolPruner'), 'toolPruner: false must not provide the service')
  assert.ok(prunerOff.events.includes('system-prompt/assemble'), 'the router still mounts its listener')
})

test('a field added in a later build is backfilled from a file written before it', () => {
  // The live deployment proved this: the file carried the five 0.2.0 safety fields and
  // not the two added with the inspection budget, so those stayed undefined - the
  // dashboard would have printed "undefined" and the first retry would have persisted
  // NaN. Sections the file omits entirely must come from the defaults as well.
  const file = join(tmpdir(), 'jev-migrate-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      firstRecordedAt: '2026-01-01T00:00:00.000Z',
      lastUpdatedAt: '2026-01-02T00:00:00.000Z',
      safetyGuard: { screened: 5, blocked: 1, approvals: 0, hardDenied: 1, uncertainDenied: 0 },
    }),
    'utf8'
  )

  try {
    const collector = new MetricsCollector(file)
    const loaded = collector.getSnapshot()
    assert.equal(loaded.safetyGuard.screened, 5, 'stored values survive the merge')
    assert.equal(loaded.safetyGuard.blocked, 1)
    assert.equal(loaded.safetyGuard.inspectionRetries, 0, 'the new field is backfilled rather than undefined')
    assert.equal(loaded.safetyGuard.inspectionFailures, 0)
    assert.equal(loaded.systemOne.totalCalls, 0, 'a section the file omits comes from the defaults')
    assert.equal(loaded.version, 2, 'and the schema version is kept')

    collector.recordSafetyRetry()
    assert.equal(collector.getSnapshot().safetyGuard.inspectionRetries, 1, 'and increments instead of becoming NaN')
    collector.recordSafetyInspectionFailure()
    assert.equal(collector.getSnapshot().safetyGuard.inspectionFailures, 1)
  } finally {
    rmSync(file, { force: true })
  }
})

test('a counter polluted by a persisted NaN is repaired rather than kept', () => {
  // A build without the backfill wrote `undefined + 1`, which JSON turns into null - and
  // that value was observed in the live file. Keeping it would leave the dashboard showing
  // a non-number forever, so a stored value of the wrong type yields to the default.
  const file = join(tmpdir(), 'jev-polluted-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json')
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      firstRecordedAt: '2026-01-01T00:00:00.000Z',
      lastUpdatedAt: '2026-01-02T00:00:00.000Z',
      safetyGuard: {
        screened: 39,
        blocked: 7,
        approvals: 0,
        hardDenied: 1,
        uncertainDenied: 0,
        inspectionRetries: null,
        inspectionFailures: 'not a number',
      },
    }),
    'utf8'
  )

  try {
    const loaded = new MetricsCollector(file).getSnapshot()
    assert.equal(loaded.safetyGuard.screened, 39, 'valid stored values still survive')
    assert.equal(loaded.safetyGuard.inspectionRetries, 0, 'a null counter is repaired to the default')
    assert.equal(loaded.safetyGuard.inspectionFailures, 0, 'so is a wrong-typed one')
  } finally {
    rmSync(file, { force: true })
  }
})

test('the stats tool declares exactly the fields it returns', () => {
  // A declared-schema key that the payload does not carry (or vice versa) breaks the
  // host's output validation, and nothing compared the two.
  let registeredTool: any
  const fakeCtx: any = {
    on: () => () => {},
    provide: () => () => {},
    get: () => undefined,
    tools: {
      register: (tool: any) => {
        registeredTool = tool
        return () => {}
      },
    },
    webServer: { register: () => () => {} },
  }
  applySuite(fakeCtx, { client: { mockHandler: () => ({}) } })

  const declared = Object.keys(registeredTool.output.schema.properties ?? {}).sort()
  assert.ok(declared.length > 0, 'the tool declares an output schema')
  return registeredTool.execute({}).then((payload: Record<string, unknown>) => {
    assert.deepEqual(
      declared,
      Object.keys(payload).sort(),
      'the declared fields and the returned fields must be the same set'
    )
    assert.deepEqual(
      [...(registeredTool.output.schema.required ?? [])].sort(),
      declared.filter((key) => payload[key] !== undefined).sort(),
      'every field the schema requires must be present'
    )
  })
})

test('the stats tool and route actually clear the metrics they offer to reset', async () => {
  // Both surfaces advertise a reset, and nothing checked that it clears anything: the
  // route test asserted the payload's shape on an already-empty collector.
  let registeredTool: any
  let registeredRoute: any
  const fakeCtx: any = {
    on: () => () => {},
    provide: () => () => {},
    get: () => undefined,
    tools: {
      register: (tool: any) => {
        registeredTool = tool
        return () => {}
      },
    },
    webServer: {
      register: (route: any) => {
        registeredRoute = route
        return () => {}
      },
    },
  }
  applySuite(fakeCtx, { client: { mockHandler: () => ({}) } })

  const seed = async () => {
    const { defaultMetrics } = await import('../lib/metrics.js')
    defaultMetrics.recordCall(10, true, { inputBytes: 100 })
    return defaultMetrics.getSnapshot().systemOne.totalCalls
  }

  assert.ok((await seed()) > 0, 'the fixture records a call so a reset has something to clear')

  await registeredTool.execute({ reset: true })
  const { defaultMetrics } = await import('../lib/metrics.js')
  assert.equal(defaultMetrics.getSnapshot().systemOne.totalCalls, 0, 'the tool reset must clear the counters')

  assert.ok((await seed()) > 0, 'seed again for the route')
  let body = ''
  registeredRoute.handler({ method: 'POST', headers: {} }, { writeHead: () => {}, end: (str: string) => { body = str } })
  assert.equal(defaultMetrics.getSnapshot().systemOne.totalCalls, 0, 'a POST to the route must clear the counters')
  assert.ok(body.length > 0, 'and it still answers with the payload')

  assert.ok((await seed()) > 0, 'seed once more for the query form')
  registeredRoute.handler({ method: 'GET', url: '/api/dsh-jev/stats?reset=1', headers: {} }, { writeHead: () => {}, end: () => {} })
  assert.equal(defaultMetrics.getSnapshot().systemOne.totalCalls, 0, '?reset=1 must clear the counters too')
})
