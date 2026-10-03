// The CHANNEL lane: boot the REAL host-half entry on a REAL cordis context and
// read the routes it registers, then call ours through the real RPC envelope
// (`docs/05-test-plan.md` §1). This is the M1 route/namespace guardrail: the
// host THROWS on a duplicate exact path (`docs/01` F1), and the panel has to
// coexist with `dsh-context@0.60.0`, which owns `/api/dsh-context/*`.
//
// Reverse verification: point any route constant in `src/shared/redline-route.ts`
// back at the upstream path → "no upstream path is registered" reddens, because
// the check reads the path the plugin ACTUALLY registers rather than the
// constant it came from.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { REDLINE_ERROR } from '../../src/shared/redline-errors'
import { REDLINE_CHANNEL_ROUTE, REDLINE_ROUTES } from '../../src/shared/redline-route'

type RouteFetch = (request: Request) => Promise<Response>

interface CapturedRoute {
  path: string
  methods: readonly string[]
  fetch: RouteFetch
  /** Set when the registration's own disposer ran (the fiber unloading). */
  withdrawn?: boolean
}

/** Upstream's prefix, guarded so our own name cannot satisfy the assertion. */
const UPSTREAM_PREFIX = /^\/api\/dsh-context\/(?!redline)/

const plugin = { name, inject, apply } as never

/**
 * Boot the plugin the way the harness does — a real cordis context, the real
 * session store and projection registry (the module-level inject gate), and a
 * recording `connection` service standing in for the host's fetch registry.
 */
async function bootHost(): Promise<{ ctx: Context; routes: CapturedRoute[]; unload: () => Promise<void> }> {
  const routes: CapturedRoute[] = []
  const ctx = new Context()
  ctx.provide('connection', {
    fetch: {
      register(route: CapturedRoute) {
        routes.push(route)
        return () => { route.withdrawn = true }
      },
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(plugin, {} as never)
  return { ctx, routes, unload: async () => { await fiber.dispose() } }
}

/** POST one JSON body to a captured route and parse the reply. */
async function post(
  route: CapturedRoute,
  body: unknown,
): Promise<{ status: number; cacheControl: string | null; json: Record<string, unknown> }> {
  const request = new Request(`http://dsh.test${route.path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
  const response = await route.fetch(request)
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    json: await response.json() as Record<string, unknown>,
  }
}

describe('host route namespace', () => {
  test('module shape stays the installed identity', () => {
    assert.equal(name, 'dsh-context-redline')
    assert.deepEqual(inject, ['sessionProjections'])
  })

  test('the booted plugin registers exactly our four routes, and no upstream path', async () => {
    const host = await bootHost()
    const paths = host.routes.map(r => r.path)
    assert.deepEqual([...paths].sort(), [...REDLINE_ROUTES].sort(), 'the four namespaced routes are registered')
    for (const path of paths) {
      assert.ok(!UPSTREAM_PREFIX.test(path), `${path} must not collide with upstream's routes`)
      assert.ok(path.startsWith('/api/dsh-context-redline/'), `${path} is under our prefix`)
    }
  })

  test('every route is a no-store POST served by a fetch handler', async () => {
    const host = await bootHost()
    assert.equal(host.routes.length, REDLINE_ROUTES.length)
    for (const route of host.routes) {
      assert.deepEqual(route.methods, ['POST'], route.path)
      assert.equal(typeof route.fetch, 'function', route.path)
    }
    const reply = await post(host.routes.find(r => r.path === REDLINE_CHANNEL_ROUTE)!, { op: 'nope' })
    assert.equal(reply.cacheControl, 'no-store')
  })

  test('unloading withdraws every route (each registration owns a disposer)', async () => {
    const host = await bootHost()
    assert.equal(host.routes.length, REDLINE_ROUTES.length)
    assert.ok(host.routes.every(r => r.withdrawn !== true), 'nothing is withdrawn while the plugin is loaded')
    await host.unload()
    for (const route of host.routes) {
      assert.equal(route.withdrawn, true, `${route.path} was withdrawn by the effect disposer`)
    }
  })
})

describe('the redline channel envelope', () => {
  /** Boot and pick our channel route out of the recorder. */
  async function channel(): Promise<CapturedRoute> {
    const host = await bootHost()
    const route = host.routes.find(r => r.path === REDLINE_CHANNEL_ROUTE)
    assert.ok(route !== undefined, 'the redline channel registered')
    return route
  }

  test('an op outside the table answers the stable unknown-op code', async () => {
    const reply = await post(await channel(), { op: 'node.read', sessionId: 's1' })
    assert.equal(reply.status, 200)
    assert.equal(reply.cacheControl, 'no-store')
    assert.deepEqual(reply.json, {
      ok: false,
      error: { code: REDLINE_ERROR.unknownOp, message: 'unknown redline op: node.read' },
    })
  })

  test('a malformed body answers bad-request, never a thrown transport error', async () => {
    const route = await channel()
    const notJson = await post(route, 'not json at all')
    assert.deepEqual(notJson.json, { ok: false, error: { code: REDLINE_ERROR.badRequest, message: 'body is not JSON' } })

    for (const body of [null, 42, 'str', [], {}, { op: '' }, { op: 7 }]) {
      const reply = await post(route, body)
      assert.equal(reply.status, 200, JSON.stringify(body) ?? 'undefined')
      assert.equal((reply.json as { ok?: unknown }).ok, false, JSON.stringify(body) ?? 'undefined')
      assert.equal(
        ((reply.json as { error?: { code?: unknown } }).error?.code),
        REDLINE_ERROR.badRequest,
        JSON.stringify(body) ?? 'undefined',
      )
    }
  })
})
