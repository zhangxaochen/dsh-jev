/**
 * The runtime master switch: what it reads, what it means, and that every module obeys it.
 *
 * The button in the composer status bar flips a file; these cases pin the file semantics
 * (default enabled, corrupt file enabled, explicit off respected) and, more importantly,
 * that each listener delegates straight through while the switch is off - a module that
 * ignored the switch would keep pruning or denying behind a button that says otherwise.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isJevEnabled, readJevGate, resolveGatePath, setJevEnabled } from '../lib/gate.js'
import { apply as applyLoopGuard } from '../lib/loop-guard.js'
import { apply as applySafetyGuard } from '../lib/safety-guard.js'
import { apply as applyToolPruner } from '../lib/tool-pruner.js'
import { apply as applySkillRouter } from '../lib/skill-router.js'
import { apply as applyResultShaper } from '../lib/result-shaper.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext, ToolExecution } from '../lib/types.js'

function tempGate(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jev-gate-'))
  return join(dir, 'jev-enabled.json')
}

test('the switch defaults to enabled when the file is absent', () => {
  const path = tempGate()
  assert.equal(isJevEnabled(path), true)
  assert.deepEqual(readJevGate(path), { enabled: true })
})

test('the switch reports and persists what was set', () => {
  const path = tempGate()
  setJevEnabled(false, 'test', path)
  assert.equal(isJevEnabled(path), false)
  const state = readJevGate(path)
  assert.equal(state.enabled, false)
  assert.equal(state.changedBy, 'test')
  assert.ok(state.changedAt, 'the change is timestamped for the panel')

  setJevEnabled(true, 'test', path)
  assert.equal(isJevEnabled(path), true)
})

test('a broken or unreadable switch file leaves the plugin enabled', () => {
  // The safe direction: a filesystem problem must never silently disable a guard.
  const path = tempGate()
  writeFileSync(path, '{ this is not json', 'utf8')
  assert.equal(isJevEnabled(path), true)
  assert.equal(readJevGate(path).enabled, true)

  writeFileSync(path, JSON.stringify({ enabled: 'no' }), 'utf8')
  assert.equal(isJevEnabled(path), true, 'only an explicit false turns it off')
})

test('the switch path honours the environment override', () => {
  const previous = process.env.DSH_JEV_GATE_PATH
  process.env.DSH_JEV_GATE_PATH = tempGate()
  try {
    assert.equal(resolveGatePath(), process.env.DSH_JEV_GATE_PATH)
  } finally {
    if (previous === undefined) delete process.env.DSH_JEV_GATE_PATH
    else process.env.DSH_JEV_GATE_PATH = previous
  }
})

/** A context that records what each module asked for. The mock answers "destructive", so
 * a module that ignored the switch would deny rather than pass. */
function offContext() {
  const calls = { systemOne: 0, injected: [] as string[] }
  let preExecute: any
  let postExecute: any
  let assemble: any
  const destructive = {
    is_destructive: { type: 'noul', noul: 0.98 },
    is_exfiltration: { type: 'noul', noul: 0.02 },
    credential_kind: { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } },
    is_jailbreak: { type: 'noul', noul: 0.05 },
    risk_score: { type: 'score', score: 2, confidence: 1, probabilities: { '0': 0, '1': 0, '2': 1 } },
    has_progress: { type: 'noul', noul: 0.1 },
    stuck_severity: { type: 'score', score: 2, confidence: 0.9, probabilities: { '0': 0, '1': 0.1, '2': 0.9 } },
  }
  const client = new TypeSafeClient({
    mockHandler: async () => {
      calls.systemOne += 1
      return destructive
    },
  })
  const ctx: CordisContext = {
    on: (event: string, callback: any) => {
      if (event === 'tools/pre-execute') preExecute = callback
      if (event === 'tools/post-execute') postExecute = callback
      if (event === 'system-prompt/assemble') assemble = callback
      if (event === 'agent/pre-step') callback({ agent: { id: 'gate' } }, async () => ({ kind: 'enter' }))
      return () => {}
    },
    get: (name: string) =>
      name === 'tools'
        ? { guard: () => () => {} }
        : name === 'skills'
          ? { list: async () => [{ name: 'prd-development', description: 'PRD' }] }
          : undefined,
    typesafe: client,
  }
  return {
    ctx,
    calls,
    preExecute: (exec: ToolExecution) => preExecute(exec, async () => ({ kind: 'allow', action: 'allow' })),
    postExecute: (exec: ToolExecution, result: unknown) =>
      postExecute(exec, result, async () => ({ kind: 'accept', action: 'accept' })),
    assemble: (assembly: unknown) => assemble(assembly, {}, async () => assembly),
    inject: (name: string) => calls.injected.push(name),
  }
}

test('every module delegates straight through while the switch is off', async () => {
  const path = tempGate()
  process.env.DSH_JEV_GATE_PATH = path
  setJevEnabled(false, 'test', path)
  try {
    const harness = offContext()
    applyLoopGuard(harness.ctx, { triggerThreshold: 1 })
    applySafetyGuard(harness.ctx, {})
    applyToolPruner(harness.ctx, { maxTools: 2 })
    applySkillRouter(harness.ctx, { minCandidates: 1 })
    applyResultShaper(harness.ctx, { thresholdChars: 1000, shapeTools: ['pwsh'] })

    // Safety: the mock answers "destructive", so this call is denied while the switch is
    // on - which is what makes the off-case meaningful rather than trivially allowed.
    const guardedOff = await harness.preExecute({ name: 'bash', args: { command: 'npm test' } } as ToolExecution)
    assert.equal(guardedOff.action, 'allow', 'the safety guard does not deny while off')

    const harnessOn = offContext()
    applySafetyGuard(harnessOn.ctx, {})
    setJevEnabled(true, 'test', path)
    const guardedOn = await harnessOn.preExecute({ name: 'bash', args: { command: 'npm test' } } as ToolExecution)
    assert.equal(guardedOn.action, 'deny', 'and denies the same call while on (this is the control)')
    setJevEnabled(false, 'test', path)

    // Loop guard: a stuck-looking step produces no notice.
    const loop = await harness.postExecute(
      { name: 'bash', args: { command: 'npm test' }, agent: { id: 'gate' } } as ToolExecution,
      { content: 'same output' }
    )
    assert.equal(loop.additionalContexts, undefined, 'the loop guard stays silent while off')

    // Pruner and router: the assembly comes back untouched.
    const tools = [
      { name: 'alpha', description: 'a' },
      { name: 'beta', description: 'b' },
      { name: 'gamma', description: 'c' },
    ]
    const assembly: any = { tools, sections: [{ text: 'run the tests and fix the failure' }] }
    const out = await harness.assemble(assembly)
    assert.equal((out as any).tools.length, 3, 'nothing is pruned while off')
    assert.deepEqual((out as any).contexts ?? [], [], 'no advice is injected while off')

    // Shaper: a large repetitive result is left alone. The shaper edits the result object
    // in place rather than answering with a decision, so the check is the content itself.
    const noisy: any = { content: [{ type: 'text', text: 'progress: ok\n'.repeat(300) }] }
    const before = JSON.stringify(noisy.content)
    await harness.postExecute(
      { name: 'pwsh', args: { command: 'build' }, agent: { id: 'gate' } } as ToolExecution,
      noisy
    )
    assert.equal(JSON.stringify(noisy.content), before, 'the shaper leaves the result alone while off')

    assert.equal(harness.calls.systemOne, 0, 'and no module calls the model while off')
  } finally {
    rmSync(join(path, '..'), { recursive: true, force: true })
  }
})
