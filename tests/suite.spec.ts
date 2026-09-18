import test from 'node:test'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'
import { TypeSafeClient } from '../lib/typesafe-client.js'
import type { CordisContext } from '../lib/types.js'

test('TypeSafe composite suite mounts and disposes all modules', () => {
  const listeners: Record<string, Function[]> = {}

  const fakeContext: CordisContext = {
    on: (event: string, cb: Function) => {
      if (!listeners[event]) listeners[event] = []
      listeners[event]?.push(cb)
      return () => {
        listeners[event] = listeners[event]?.filter((fn) => fn !== cb)
      }
    },
  }

  const dispose = apply(fakeContext, {
    client: { apiKey: 'test-suite-key' },
    loopGuard: true,
    safetyGuard: true,
    toolPruner: true,
  })

  // 1. Verify Client mounted
  assert.ok(fakeContext.typesafe instanceof TypeSafeClient)
  assert.equal(fakeContext.typesafe.apiKey, 'test-suite-key')

  // 2. Verify Tool Pruner mounted
  assert.ok(fakeContext.toolPruner)

  // 3. Verify event listeners registered
  assert.equal(listeners['tools/post-execute']?.length, 1)
  assert.equal(listeners['tools/pre-execute']?.length, 1)

  // 4. Dispose and verify teardown
  dispose()
  assert.equal(fakeContext.typesafe, undefined)
  assert.equal(fakeContext.toolPruner, undefined)
  assert.equal(listeners['tools/post-execute']?.length, 0)
  assert.equal(listeners['tools/pre-execute']?.length, 0)
})
