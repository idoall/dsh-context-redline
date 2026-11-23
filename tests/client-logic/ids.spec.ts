// randomUuid (src/client/ids.ts): the Client half mints operation ids for the
// anchored-conversation confirm. `crypto.randomUUID` is gated on a SECURE
// CONTEXT, so a plain http:// LAN deployment throws `crypto.randomUUID is not
// a function`; this lane pins the three arms (native / getRandomValues /
// Math.random) and the v4 shape every one of them must produce.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { randomUuid } from '../../src/client/ids'

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

afterEach(() => { vi.unstubAllGlobals() })

describe('randomUuid', () => {
  test('uses the native randomUUID when the context exposes it', () => {
    const native = vi.fn(() => '11111111-2222-4333-8444-555555555555')
    vi.stubGlobal('crypto', { randomUUID: native })
    assert.equal(randomUuid(), '11111111-2222-4333-8444-555555555555')
    assert.equal(native.mock.calls.length, 1)
  })

  test('an INSECURE context (no randomUUID) still yields a v4 id via getRandomValues', () => {
    const seen: number[] = []
    vi.stubGlobal('crypto', {
      // Deterministic, but only ONE arm is under test here: the shape, not the entropy.
      getRandomValues: (bytes: Uint8Array) => {
        seen.push(bytes.length)
        for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 53 + 7) & 0xff
        return bytes
      },
    })
    const id = randomUuid()
    assert.match(id, V4, 'a version-4 UUID with the RFC 4122 variant bits')
    assert.deepEqual(seen, [16], 'one getRandomValues call over the 16-byte buffer')
  })

  test('without a crypto object at all it falls back to Math.random, never throwing', () => {
    vi.stubGlobal('crypto', undefined)
    const ids = new Set<string>()
    for (let i = 0; i < 50; i++) {
      const id = randomUuid()
      assert.match(id, V4)
      ids.add(id)
    }
    assert.ok(ids.size > 40, 'the fallback still mints distinct ids')
  })

  test('the native arm is preferred over the fallback when both exist', () => {
    const native = vi.fn(() => '00000000-0000-4000-8000-000000000000')
    const getRandomValues = vi.fn((bytes: Uint8Array) => bytes)
    vi.stubGlobal('crypto', { randomUUID: native, getRandomValues })
    assert.equal(randomUuid(), '00000000-0000-4000-8000-000000000000')
    assert.equal(getRandomValues.mock.calls.length, 0)
  })
})
