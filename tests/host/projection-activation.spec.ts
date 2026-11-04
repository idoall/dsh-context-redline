import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { describe, test } from 'vitest'
import { apply } from '../../src/host/index'

function activationContext(register: (definition: { key: string }) => Promise<unknown>): Context {
  return {
    fiber: { name: 'dsh-context-redline' },
    sessionProjections: { register },
    get: () => undefined,
    inject: () => () => {},
    on: () => () => {},
    effect: () => () => {},
  } as unknown as Context
}

describe('DSH asynchronous projection activation', () => {
  test('activation waits for every projection registration', async () => {
    const pending: Array<() => void> = []
    const registered: string[] = []
    const ctx = activationContext(definition => {
      registered.push(definition.key)
      return new Promise(resolve => pending.push(() => resolve({ stateOf: () => undefined, dispose: async () => {} })))
    })
    let ready = false
    const activation = Promise.resolve(apply(ctx, {})).then(() => { ready = true })
    await Promise.resolve()
    assert.equal(ready, false, 'plugin must not become active before registration resolves')
    for (let i = 0; i < 3; i++) {
      assert.ok(pending.length > 0, 'a registration is awaiting readiness')
      pending.shift()!()
      await Promise.resolve()
      await Promise.resolve()
    }
    await activation
    assert.equal(ready, true)
    assert.deepEqual(registered.sort(), ['redlineActivity', 'redlineHeaders', 'redlineTimeline'])
  })

  test('a rejected registration rejects activation, not an unhandled background task', async () => {
    const ctx = activationContext(() => {
      const registration = Promise.reject(new Error('projection registration failed'))
      void registration.catch(() => {})
      return registration
    })
    await assert.rejects(async () => { await apply(ctx, {}) }, /projection registration failed/)
  })
})
