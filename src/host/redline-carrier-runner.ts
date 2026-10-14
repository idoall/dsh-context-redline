/** Durable-log attribution and automatic return for one frozen carrier operation. */

import {
  bindCarrierResult,
  classifyCarrierResult,
  transitionCarrierReturn,
  type CarrierAttributionEvidence,
  type CarrierOperation,
  type CarrierTurnEndReason,
  type ParseCarrierResult,
} from '../shared/redline-carrier'
import type { CarrierDeliveryResult, CarrierReturnRequest } from './redline-session-control'

export interface CarrierTraceEvidence extends CarrierAttributionEvidence {
  readonly turnEndReason: CarrierTurnEndReason
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function textOfContent(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined
  const texts: string[] = []
  for (const item of value) {
    const block = record(item)
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') texts.push(block.text)
  }
  return texts.length === 0 ? undefined : texts.join('\n\n')
}

function messageOf(event: Record<string, unknown>): Record<string, unknown> | null {
  const data = record(event.data)
  if (data === null) return null
  return record(data.message) ?? data
}

function rpcIdOf(message: Record<string, unknown> | null): string | undefined {
  const source = message === null ? null : record(message.source)
  return source !== null && typeof source.rpcId === 'string' ? source.rpcId : undefined
}

function turnEndOf(data: Record<string, unknown>): { reason: CarrierTurnEndReason; code?: string; message?: string } | null {
  const raw = data.reason
  const reason = typeof raw === 'string' ? raw : record(raw)?.kind
  if (reason !== 'completed' && reason !== 'blocked' && reason !== 'interrupted' && reason !== 'error'
    && reason !== 'aborted' && reason !== 'max-tokens' && reason !== 'forked') return null
  const detail = record(raw)
  const cancelCause = record(detail?.reason)
  const normalized = reason === 'aborted' && cancelCause?.kind === 'user' ? 'cancelled' : reason
  const failure = record(detail?.error) ?? record(detail?.failure) ?? record(data.error)
  return {
    reason: normalized,
    ...(typeof failure?.code === 'string' ? { code: failure.code } : {}),
    ...(typeof failure?.message === 'string' ? { message: failure.message } : {}),
  }
}

/** Derive exact prompt→turn→assistant evidence by durable log order. */
export function carrierEvidenceFromEvents(
  promptRequestId: string,
  events: readonly unknown[],
): CarrierTraceEvidence | null {
  let currentTurn: number | undefined
  let currentStep: number | undefined
  const directByTurn = new Map<number, string[]>()
  const claimedTurns = new Set<number>()
  const inbox: Record<'next-turn' | 'next-step', Record<string, unknown>[]> = { 'next-turn': [], 'next-step': [] }
  let target: { messageId: string; turn: number; step?: number } | undefined
  const assistants: { id: string; turn: number; seq: number; text?: string }[] = []
  const ends = new Map<number, { reason: CarrierTurnEndReason; code?: string; message?: string }>()

  for (const raw of events) {
    const event = record(raw)
    if (event === null || typeof event.type !== 'string') continue
    const data = record(event.data) ?? {}
    if (event.type === 'turn/start' && typeof data.turn === 'number') {
      currentTurn = data.turn
      currentStep = undefined
      continue
    }
    if (event.type === 'step/start' && typeof data.turn === 'number' && typeof data.step === 'number') {
      currentTurn = data.turn
      currentStep = data.step
      continue
    }
    if (event.type === 'agent/inbox/spliced') {
      const targetName = data.target === 'next-turn' || data.target === 'next-step' ? data.target : null
      if (targetName === null) continue
      const queue = inbox[targetName]
      const start = typeof data.start === 'number' && Number.isSafeInteger(data.start) ? data.start : queue.length
      const removeCount = typeof data.removedCount === 'number' && Number.isSafeInteger(data.removedCount) ? data.removedCount : 0
      const inserted: Record<string, unknown>[] = Array.isArray(data.inserted)
        ? data.inserted.flatMap((value): Record<string, unknown>[] => {
          const message = record(value)
          return message === null ? [] : [message]
        })
        : []
      const removed = queue.splice(start, removeCount, ...inserted)
      if (data.outcome !== 'canceled' && currentTurn !== undefined && removed.length > 0) {
        const ids = removed.flatMap((message) => {
          const rpcId = rpcIdOf(message)
          return rpcId === undefined ? [] : [rpcId]
        })
        const list = directByTurn.get(currentTurn) ?? []
        list.push(...ids)
        directByTurn.set(currentTurn, list)
        claimedTurns.add(currentTurn)
        const matched = removed.find(message => rpcIdOf(message) === promptRequestId)
        if (matched !== undefined && typeof matched.id === 'string') target = { messageId: matched.id, turn: currentTurn }
      }
      continue
    }
    if (event.type === 'user/message' && currentTurn !== undefined) {
      const message = messageOf(event)
      const rpcId = rpcIdOf(message)
      const id = message !== null && typeof message.id === 'string' ? message.id : undefined
      if (rpcId !== undefined && !claimedTurns.has(currentTurn)) {
        // Legacy/test logs without durable inbox splices: use entered direct inputs as the fallback claim evidence.
        const list = directByTurn.get(currentTurn) ?? []
        list.push(rpcId)
        directByTurn.set(currentTurn, list)
      }
      if (rpcId === promptRequestId && id !== undefined) target = { messageId: id, turn: currentTurn, step: currentStep }
      continue
    }
    if (event.type === 'assistant/message' && typeof data.turn === 'number') {
      const message = messageOf(event)
      if (message !== null && typeof message.id === 'string') {
        assistants.push({
          id: message.id,
          turn: data.turn,
          seq: typeof event.seq === 'number' ? event.seq : -1,
          ...(textOfContent(message.content) === undefined ? {} : { text: textOfContent(message.content) }),
        })
      }
      continue
    }
    if (event.type === 'turn/end' && typeof data.turn === 'number') {
      const end = turnEndOf(data)
      if (end !== null) ends.set(data.turn, end)
    }
  }

  if (target === undefined) return null
  const end = ends.get(target.turn)
  if (end === undefined) return null
  const answer = assistants.filter(item => item.turn === target.turn).sort((a, b) => b.seq - a.seq).at(0)
  return {
    expectedPromptRequestId: promptRequestId,
    promptRequestId,
    promptMessageId: target.messageId,
    claimedTurn: target.turn,
    ...(target.step === undefined ? {} : { enteredTurn: target.turn }),
    directClaimRequestIds: directByTurn.get(target.turn) ?? [promptRequestId],
    turn: target.turn,
    ...(answer === undefined ? {} : { sourceAssistantMessageId: answer.id }),
    ...(answer?.text === undefined ? {} : { visibleText: answer.text }),
    ...(end.code === undefined ? {} : { failureCode: end.code }),
    ...(end.message === undefined ? {} : { failureMessage: end.message }),
    turnEndReason: end.reason,
  }
}

interface RunnerContext { get(name: string): unknown }
interface RunnerAgent { readonly session?: unknown; whenIdle?(): Promise<void> }
interface RunnerStore {
  read(opId: string): Promise<ParseCarrierResult>
  mutate(opId: string, update: (current: CarrierOperation) => CarrierOperation): Promise<CarrierOperation>
}
interface RunnerControl {
  deliverToSession(request: CarrierReturnRequest): Promise<CarrierDeliveryResult>
}

export type CarrierRunResult =
  | { readonly kind: 'accepted' }
  | { readonly kind: 'uncertain'; readonly cause: string }
  | { readonly kind: 'pending' | 'held'; readonly cause: string }

/** Wait for the carrier to settle, freeze its exact result, then return it to the source session. */
export async function runCarrierToReturn(
  ctx: RunnerContext,
  opId: string,
  agent: RunnerAgent | undefined,
  store: RunnerStore,
  control: RunnerControl,
): Promise<CarrierRunResult> {
  const read = await store.read(opId)
  if (!read.ok) return { kind: 'held', cause: read.message }
  let operation = read.operation
  if (operation.taskState === 'running') {
    if (agent?.whenIdle !== undefined) await agent.whenIdle()
    if (agent?.session !== undefined) {
      const sessions = ctx.get('sessions') as { flush(session: unknown): Promise<boolean> } | undefined
      if (sessions === undefined) return { kind: 'held', cause: 'sessions-unavailable' }
      try { await sessions.flush(agent.session) } catch (error) {
        return { kind: 'held', cause: error instanceof Error ? error.message : String(error) }
      }
    }
    const query = ctx.get('sessionQuery') as { readSession(id: string): Promise<{ readonly events: readonly unknown[] }> } | undefined
    if (query === undefined) return { kind: 'held', cause: 'session-query-unavailable' }
    let snapshot: { readonly events: readonly unknown[] }
    try { snapshot = await query.readSession(operation.carrierId) } catch (error) {
      return { kind: 'held', cause: error instanceof Error ? error.message : String(error) }
    }
    const evidence = carrierEvidenceFromEvents(operation.promptRequestId, snapshot.events)
    if (evidence === null) return { kind: 'pending', cause: 'turn-not-terminal' }
    const classified = classifyCarrierResult(evidence.turnEndReason, evidence)
    if (classified.kind === 'attribution-unknown') return { kind: 'held', cause: classified.reason }
    if (classified.kind === 'forked') return { kind: 'held', cause: 'carrier-forked' }
    operation = await store.mutate(opId, current => bindCarrierResult(current, classified))
  } else if (operation.taskState !== 'completed' && operation.taskState !== 'failed' && operation.taskState !== 'cancelled') {
    return { kind: 'pending', cause: `state:${operation.taskState}` }
  }
  if (operation.returnState === 'accepted') return { kind: 'accepted' }
  if (operation.returnState === 'pending-send' || operation.returnState === 'uncertain') {
    operation = await store.mutate(opId, current => transitionCarrierReturn(current, 'sending'))
  } else if (operation.returnState !== 'sending') {
    return { kind: 'held', cause: `return-state:${operation.returnState}` }
  }
  const execution = operation.executionInput
  if (execution === undefined || operation.returnPayload === undefined) return { kind: 'held', cause: 'frozen-input-missing' }
  const config = execution.returnConfig ?? execution.confirmedConfig
  const request: CarrierReturnRequest = {
    sessionId: operation.mainSessionId,
    agentPreset: config.agentPreset,
    agentOptions: {
      provider: config.provider,
      model: config.model,
      ...(config.reasoningEffort.startsWith('not-') ? {} : { reasoningEffort: config.reasoningEffort }),
    },
    requestId: operation.returnRequestId,
    text: `【承载会话结果 · ${operation.plannedTitle} · ${operation.carrierId}】\n${operation.returnPayload}`,
  }
  let delivery: CarrierDeliveryResult
  try { delivery = await control.deliverToSession(request) } catch (error) {
    const cause = error instanceof Error ? error.message : String(error)
    await store.mutate(opId, current => transitionCarrierReturn(current, 'uncertain'))
    return { kind: 'uncertain', cause }
  }
  if (!delivery.ok) {
    await store.mutate(opId, current => transitionCarrierReturn(current, 'uncertain'))
    return { kind: 'uncertain', cause: delivery.cause }
  }
  await store.mutate(opId, current => transitionCarrierReturn(current, 'accepted'))
  return { kind: 'accepted' }
}
