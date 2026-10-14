/** Startup recovery for durable ordinary-carrier operations. */

import type { Context } from '@deepseek-ai/cordis'
import { setTitleStatus, transitionCarrierTask, type CarrierOperation } from '../shared/redline-carrier'
import { createRedlineCarrierStore, type RedlineCarrierStore } from './redline-carrier-store'
import { runCarrierToReturn } from './redline-carrier-runner'
import { redlineSessionControlFor, type CarrierSessionRequest } from './redline-session-control'

function service(ctx: Context, name: string): unknown {
  return (ctx as unknown as { get(key: string): unknown }).get(name)
}

async function advance(store: RedlineCarrierStore, opId: string, target: 'creating' | 'created' | 'prompted' | 'running') {
  return await store.mutate(opId, current => current.taskState === target ? current : transitionCarrierTask(current, target))
}

function requestOf(operation: CarrierOperation): CarrierSessionRequest | null {
  const input = operation.executionInput
  if (input === undefined || input.cwd === undefined || input.cwd === '') return null
  const config = input.confirmedConfig
  return {
    carrierId: operation.carrierId,
    cwd: input.cwd,
    agentPreset: config.agentPreset,
    agentOptions: {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    },
    workspaceId: input.workspaceId,
    title: operation.plannedTitle,
    promptRequestId: operation.promptRequestId,
    promptText: input.deliveryContent,
  }
}

export async function recoverCarrierOperation(ctx: Context, store: RedlineCarrierStore, opId: string): Promise<void> {
  const read = await store.read(opId)
  if (!read.ok) return
  let operation = read.operation
  const control = redlineSessionControlFor(ctx)
  if (operation.taskState === 'previewed') return
  if (operation.taskState === 'completed' || operation.taskState === 'failed' || operation.taskState === 'cancelled') {
    await runCarrierToReturn(ctx, opId, undefined, store, control)
    return
  }
  const request = requestOf(operation)
  if (request === null) return
  if (operation.taskState === 'authorized') operation = await advance(store, opId, 'creating')
  const started = await control.start(request)
  if (!started.ok) return
  if (operation.titleStatus === 'pending') {
    operation = await store.mutate(opId, current => setTitleStatus(current, started.titleStatus))
  }
  if (operation.taskState === 'creating') operation = await advance(store, opId, 'created')
  if (operation.taskState === 'created') operation = await advance(store, opId, 'prompted')
  if (operation.taskState === 'prompted') operation = await advance(store, opId, 'running')
  const agents = service(ctx, 'agents') as { get?(id: string): { whenIdle?(): Promise<void> } | undefined } | undefined
  const agent = control.handles.get(operation.carrierId)?.agent ?? agents?.get?.(operation.carrierId)
  if (agent !== undefined) {
    await runCarrierToReturn(ctx, opId, agent, store, control)
  }
}

export function watchCarrierRecovery(ctx: Context): void {
  const host = ctx as unknown as {
    inject(names: string[], callback: (child: Context) => void): void
  }
  host.inject(['agents', 'sessions', 'sessionQuery', 'sessionTitle', 'workspaceRegistry', 'agentPresets'], (child) => {
    const store = createRedlineCarrierStore(child)
    void (async () => {
      for (const opId of await store.listOperationIds()) {
        try { await recoverCarrierOperation(child, store, opId) } catch (error) {
          child.logger.warn('dsh-context-redline: carrier recovery held (' + (error instanceof Error ? error.message : String(error)) + ')')
        }
      }
    })()
  })
}
