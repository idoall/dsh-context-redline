/**
 * The redline channel — OUR ONLY wiring file into the upstream host
 * (`docs/11` D3.1, `UPSTREAM.md` §3.3). Everything it will ever do rides the
 * single namespaced route `REDLINE_CHANNEL_ROUTE`, discriminated by `op`
 * (`docs/02` §5.1/§5.2): adding an op never adds a route, so the
 * "two plugins must not register the same path" trap (`docs/01` F1) can only be
 * sprung by editing the shared constant, which the namespace contract watches.
 *
 * ── M1 scope ────────────────────────────────────────────────────────────────
 * This file exists so the route, the namespace and the envelope are provably in
 * place before any editing logic lands. The op table is EMPTY on purpose: every
 * call answers `redline/unknown-op`. M2 fills `OPS` with the read/write ops of
 * `docs/02` §5.2 and their tests (`docs/10` M2-01 … M2-27).
 *
 * ── Why the registration is defensive ───────────────────────────────────────
 * The route arms only while the `connection` service is composed (load order is
 * never assumed), the registration rides the injected fiber (an unloaded plugin
 * withdraws it), and a registry that rejects leaves the plugin otherwise intact.
 */

import type { Context } from '@deepseek-ai/cordis'
import { REDLINE_ERROR, REDLINE_ERROR_MESSAGE } from '../shared/redline-errors'
import {
  REDLINE_CHANNEL_ROUTE,
  asRedlineCall,
  redlineFailure,
  type RedlineCall,
  type RedlineEnvelope,
} from '../shared/redline-route'

/** The host `connection` service, as far as this route consumes it. */
interface ConnectionHostFace {
  fetch?: {
    register?(route: {
      path: string
      methods: readonly string[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => void
  }
}

/** What an op handler is given. */
export interface RedlineOpContext {
  /** The host context the channel was armed on. */
  readonly ctx: Context
  /** The parsed call: `op` plus its op-specific fields. */
  readonly call: RedlineCall
}

/**
 * One op. Handlers answer with the envelope themselves, so a refusal is a
 * value (a stable code the client can map) rather than an exception.
 */
export type RedlineOpHandler = (op: RedlineOpContext) => Promise<RedlineEnvelope<unknown>>

/**
 * The op table. EMPTY in M1 — see the module header. M2 adds the entries here
 * and nowhere else.
 */
const OPS = new Map<string, RedlineOpHandler>()

/** One JSON reply on the channel. `no-store` matches every other plugin route. */
function reply(envelope: RedlineEnvelope<unknown>): Response {
  return Response.json(envelope, { headers: { 'cache-control': 'no-store' } })
}

/** Route one already-parsed call through the op table. */
async function dispatch(ctx: Context, call: RedlineCall): Promise<RedlineEnvelope<unknown>> {
  const handler = OPS.get(call.op)
  if (handler === undefined) {
    return redlineFailure(REDLINE_ERROR.unknownOp, `${REDLINE_ERROR_MESSAGE[REDLINE_ERROR.unknownOp]}: ${call.op}`)
  }
  try {
    return await handler({ ctx, call })
  } catch (error) {
    return redlineFailure(
      REDLINE_ERROR.internal,
      error instanceof Error ? error.message : String(error),
    )
  }
}

/**
 * Arm the channel while the `connection` service is composed. Returns a
 * disposer-friendly handle: the registration's own disposer rides the injected
 * fiber.
 *
 * @param ctx - the host context the plugin was applied to.
 */
export function watchRedlineChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const connection = c.get('connection') as ConnectionHostFace | undefined
    // Bind at extraction: an unbound hand-off loses `this` on the real face.
    const register = typeof connection?.fetch?.register === 'function'
      ? connection.fetch.register.bind(connection.fetch)
      : undefined
    if (register === undefined) return

    const fetch = async (request: Request): Promise<Response> => {
      let body: unknown
      try {
        body = await request.json()
      } catch {
        return reply(redlineFailure(REDLINE_ERROR.badRequest, 'body is not JSON'))
      }
      const call = asRedlineCall(body)
      if (call === null) {
        return reply(redlineFailure(REDLINE_ERROR.badRequest, REDLINE_ERROR_MESSAGE[REDLINE_ERROR.badRequest]))
      }
      return reply(await dispatch(c, call))
    }

    c.effect(() => register({
      path: REDLINE_CHANNEL_ROUTE,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch,
    }), 'dsh-context-redline: redline channel route')
  })
}
