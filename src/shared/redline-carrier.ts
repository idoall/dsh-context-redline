/** Pure durable carrier-operation state and result attribution. No I/O, no node:* imports. */

export const CARRIER_LEDGER_SCHEMA_VERSION = 1

export type CarrierTaskState =
  | 'previewed' | 'authorized' | 'creating' | 'created' | 'prompted'
  | 'running' | 'waiting-user' | 'completed' | 'failed' | 'cancelled'
export type CarrierTitleStatus = 'pending' | 'succeeded' | 'failed'
export type CarrierReturnState = 'not-prepared' | 'pending-send' | 'sending' | 'uncertain' | 'accepted' | 'failed'
export type CarrierTurnEndReason = 'completed' | 'blocked' | 'interrupted' | 'error' | 'aborted' | 'cancelled' | 'max-tokens' | 'forked'

export interface CarrierConfirmedConfig {
  readonly agentPreset: string
  readonly provider: string
  readonly model: string
  readonly reasoningEffort: string
  readonly inheritedFrom: string
}

export interface CarrierExecutionInput {
  readonly deliveryContent: string
  readonly contentFingerprint: string
  readonly workspaceId: string
  /** Exact canonical workspace path frozen with the execution input. */
  readonly cwd?: string
  readonly confirmedConfig: CarrierConfirmedConfig
  /** Source-session config used only if automatic return must cold-resume that source. */
  readonly returnConfig?: CarrierConfirmedConfig
  readonly returnConfigFingerprint?: string
  readonly attachments: readonly { readonly id: string; readonly fingerprint: string }[]
}

export interface CarrierAuthorization {
  readonly userConfirmedAt: string
  readonly manifestFingerprint: string
  readonly configFingerprint: string
  readonly sourceSessionId: string
  readonly returnSessionId: string
}

export interface CarrierPreviewInput {
  readonly opId: string
  readonly carrierId: string
  readonly mainSessionId: string
  readonly plannedTitle: string
  readonly surfaceAsOfSeq: number
  readonly surfaceFingerprint: string
  readonly manifestFingerprint: string
  readonly promptRequestId: string
  readonly returnRequestId: string
  readonly previewExecutionInput?: CarrierExecutionInput
  readonly previewDraftRevision?: string
}

export interface CarrierOperation extends CarrierPreviewInput {
  readonly schemaVersion: typeof CARRIER_LEDGER_SCHEMA_VERSION
  readonly revision: number
  readonly taskState: CarrierTaskState
  readonly titleStatus: CarrierTitleStatus
  readonly returnState: CarrierReturnState
  /** Previewed bytes/config kept durable before confirmation; never executed until copied by authorizeCarrier. */
  readonly previewExecutionInput?: CarrierExecutionInput
  /** Exact local draft version included in this preview. */
  readonly previewDraftRevision?: string
  readonly authorization?: CarrierAuthorization
  readonly executionInput?: CarrierExecutionInput
  readonly promptMessageId?: string
  readonly completedTurn?: number
  readonly sourceAssistantMessageId?: string
  readonly returnPayload?: string
  readonly returnPayloadFingerprint?: string
  readonly resultKind?: CarrierResult['kind']
}

export interface CarrierAttributionEvidence {
  readonly expectedPromptRequestId: string
  readonly promptRequestId: string
  readonly promptMessageId: string
  readonly claimedTurn: number
  readonly enteredTurn?: number
  readonly directClaimRequestIds: readonly string[]
  readonly turn: number
  readonly sourceAssistantMessageId?: string
  readonly visibleText?: string
  readonly failureCode?: string
  readonly failureMessage?: string
}

export type CarrierResult =
  | { readonly kind: 'success'; readonly completedTurn: number; readonly promptMessageId: string; readonly sourceAssistantMessageId: string; readonly payload: string }
  | { readonly kind: 'completed-no-visible-output'; readonly completedTurn: number; readonly promptMessageId: string; readonly payload: string }
  | { readonly kind: 'attribution-unknown'; readonly reason: string }
  | { readonly kind: 'blocked' | 'interrupted' | 'error' | 'aborted' | 'max-tokens' | 'forked' | 'cancelled'; readonly failureCode?: string; readonly failureMessage?: string; readonly completedTurn?: number; readonly promptMessageId?: string; readonly payload?: string }

export type ParseCarrierResult =
  | { readonly ok: true; readonly operation: CarrierOperation }
  | { readonly ok: false; readonly code: 'missing' | 'corrupt' | 'schema' | 'identity'; readonly message: string }

const TASK_TRANSITIONS: Readonly<Record<CarrierTaskState, readonly CarrierTaskState[]>> = {
  previewed: ['authorized'],
  authorized: ['creating'],
  creating: ['created'],
  created: ['prompted'],
  prompted: ['running'],
  running: ['waiting-user'],
  'waiting-user': ['running'],
  completed: [], failed: [], cancelled: [],
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

function stableHash(text: string): string {
  const lanes = new Uint32Array(8)
  for (let i = 0; i < lanes.length; i += 1) lanes[i] = (0x811c9dc5 ^ Math.imul(i + 1, 0x9e3779b9)) >>> 0
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i)
    for (let j = 0; j < lanes.length; j += 1) {
      const mixed = Math.imul((lanes[j] ?? 0) ^ code, 0x01000193) >>> 0
      lanes[j] = (mixed ^ (mixed >>> 13)) >>> 0
    }
  }
  return Array.from(lanes, lane => lane.toString(16).padStart(8, '0')).join('')
}

export function carrierContentFingerprint(content: string): string {
  return stableHash(content)
}

export function carrierConfigFingerprint(config: CarrierConfirmedConfig): string {
  return stableHash(JSON.stringify(config))
}

function next(op: CarrierOperation, patch: Partial<CarrierOperation>): CarrierOperation {
  return deepFreeze({ ...clone(op), ...clone(patch), revision: op.revision + 1 })
}

export function createCarrierPreview(input: CarrierPreviewInput): CarrierOperation {
  for (const value of [input.opId, input.carrierId, input.mainSessionId, input.promptRequestId, input.returnRequestId]) {
    if (value.trim() === '') throw new Error('carrier identities must be non-empty')
  }
  return deepFreeze({
    schemaVersion: CARRIER_LEDGER_SCHEMA_VERSION,
    revision: 1,
    ...clone(input),
    taskState: 'previewed',
    titleStatus: 'pending',
    returnState: 'not-prepared',
  })
}

export function authorizeCarrier(
  op: CarrierOperation,
  authorization: CarrierAuthorization,
  executionInput: CarrierExecutionInput,
): CarrierOperation {
  if (op.taskState !== 'previewed') throw new Error('invalid transition: carrier is not previewed')
  if (authorization.sourceSessionId !== op.mainSessionId || authorization.returnSessionId !== op.mainSessionId) {
    throw new Error('authorization session identity mismatch')
  }
  if (authorization.manifestFingerprint !== op.manifestFingerprint) throw new Error('authorization manifest mismatch')
  if (executionInput.deliveryContent === '' || executionInput.contentFingerprint !== carrierContentFingerprint(executionInput.deliveryContent)) {
    throw new Error('execution input content fingerprint mismatch')
  }
  if (authorization.configFingerprint !== carrierConfigFingerprint(executionInput.confirmedConfig)) {
    throw new Error('execution input config fingerprint mismatch')
  }
  if (executionInput.attachments.length !== 0) throw new Error('attachments are unsupported by carrier v1')
  return next(op, {
    taskState: 'authorized',
    authorization: deepFreeze(clone(authorization)),
    executionInput: deepFreeze(clone(executionInput)),
  })
}

export function transitionCarrierTask(op: CarrierOperation, target: CarrierTaskState): CarrierOperation {
  if (op.taskState === 'completed' || op.taskState === 'failed' || op.taskState === 'cancelled') throw new Error('terminal carrier cannot transition')
  if (target === 'completed' || target === 'failed' || target === 'cancelled') throw new Error('atomic result freeze is required for a terminal state')
  if (target !== 'authorized' && (op.authorization === undefined || op.executionInput === undefined)) {
    throw new Error('authorization and execution input are required')
  }
  if (!TASK_TRANSITIONS[op.taskState].includes(target)) throw new Error(`invalid transition: ${op.taskState} -> ${target}`)
  return next(op, { taskState: target })
}

export function setTitleStatus(op: CarrierOperation, status: Exclude<CarrierTitleStatus, 'pending'>): CarrierOperation {
  if (op.titleStatus !== 'pending') throw new Error('terminal title status cannot change')
  return next(op, { titleStatus: status })
}

const RETURN_TRANSITIONS: Readonly<Record<CarrierReturnState, readonly CarrierReturnState[]>> = {
  'not-prepared': [],
  'pending-send': ['sending', 'failed'],
  sending: ['accepted', 'uncertain', 'failed'],
  uncertain: ['sending', 'accepted', 'failed'],
  accepted: [],
  failed: [],
}

export function transitionCarrierReturn(op: CarrierOperation, target: CarrierReturnState): CarrierOperation {
  if (!RETURN_TRANSITIONS[op.returnState].includes(target)) {
    throw new Error(`invalid return transition: ${op.returnState} -> ${target}`)
  }
  if (op.returnPayload === undefined || op.returnPayloadFingerprint === undefined) {
    throw new Error('return payload is not frozen')
  }
  return next(op, { returnState: target })
}

export function retryDecision(state: 'exists' | 'absent' | 'unknown'):
  | { readonly action: 'accept'; readonly resend: false }
  | { readonly action: 'resend-original'; readonly resend: true }
  | { readonly action: 'wait'; readonly resend: false } {
  if (state === 'exists') return { action: 'accept', resend: false }
  if (state === 'absent') return { action: 'resend-original', resend: true }
  return { action: 'wait', resend: false }
}

export function carrierFileName(opId: string): string {
  const readable = opId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40)
  return `redline-carrier-${readable}-${stableHash(opId).slice(0, 16)}.json`
}

export function serializeCarrierOperation(op: CarrierOperation): string {
  return `${JSON.stringify(op, null, 2)}\n`
}

function isString(value: unknown): value is string { return typeof value === 'string' && value !== '' }
function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function validConfig(value: unknown): value is CarrierConfirmedConfig {
  const config = record(value)
  return config !== null && isString(config.agentPreset) && isString(config.provider) && isString(config.model)
    && isString(config.reasoningEffort) && isString(config.inheritedFrom)
}

function validExecutionInput(value: unknown, configFingerprint?: unknown): value is CarrierExecutionInput {
  const input = record(value)
  if (input === null || !validConfig(input.confirmedConfig) || !isString(input.deliveryContent) || !isString(input.contentFingerprint)
    || !isString(input.workspaceId) || !Array.isArray(input.attachments) || input.attachments.length !== 0) return false
  if (input.contentFingerprint !== carrierContentFingerprint(input.deliveryContent)) return false
  if (input.returnConfig !== undefined && (!validConfig(input.returnConfig)
    || input.returnConfigFingerprint !== carrierConfigFingerprint(input.returnConfig))) return false
  return configFingerprint === undefined || configFingerprint === carrierConfigFingerprint(input.confirmedConfig)
}

export function parseCarrierOperation(raw: string | null | undefined, expectedOpId?: string): ParseCarrierResult {
  if (raw === null || raw === undefined) return { ok: false, code: 'missing', message: 'carrier operation is missing' }
  if (raw.trim() === '') return { ok: false, code: 'corrupt', message: 'carrier operation is empty' }
  let value: unknown
  try { value = JSON.parse(raw) } catch { return { ok: false, code: 'corrupt', message: 'carrier operation is not valid JSON' } }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, code: 'corrupt', message: 'carrier operation is not an object' }
  const op = value as Partial<CarrierOperation>
  if (op.schemaVersion !== CARRIER_LEDGER_SCHEMA_VERSION) return { ok: false, code: 'schema', message: 'unsupported carrier schema' }
  if (!isString(op.opId) || !isString(op.carrierId) || !isString(op.mainSessionId)) return { ok: false, code: 'corrupt', message: 'carrier identities are invalid' }
  if (expectedOpId !== undefined && op.opId !== expectedOpId) return { ok: false, code: 'identity', message: 'carrier op identity mismatch' }
  if (!isString(op.promptRequestId) || !isString(op.returnRequestId) || !isString(op.plannedTitle)) return { ok: false, code: 'corrupt', message: 'carrier fields are incomplete' }
  if (typeof op.revision !== 'number' || !Number.isSafeInteger(op.revision) || op.revision < 1) return { ok: false, code: 'corrupt', message: 'carrier revision is invalid' }
  if (!Object.hasOwn(TASK_TRANSITIONS, String(op.taskState))) return { ok: false, code: 'corrupt', message: 'carrier task state is invalid' }
  const terminal = op.taskState === 'completed' || op.taskState === 'failed' || op.taskState === 'cancelled'
  if (terminal && (!isString(op.returnPayload) || !isString(op.returnPayloadFingerprint) || op.returnState === 'not-prepared')) {
    return { ok: false, code: 'corrupt', message: 'terminal carrier is missing its atomic return payload' }
  }
  if (terminal && op.returnPayloadFingerprint !== carrierContentFingerprint(op.returnPayload ?? '')) {
    return { ok: false, code: 'corrupt', message: 'terminal carrier return payload fingerprint mismatch' }
  }
  if (op.previewExecutionInput !== undefined && !validExecutionInput(op.previewExecutionInput)) {
    return { ok: false, code: 'corrupt', message: 'carrier preview execution input failed fingerprint validation' }
  }
  if (op.taskState !== 'previewed') {
    const authorization = record(op.authorization)
    if (authorization === null || !isString(authorization.userConfirmedAt)
      || authorization.sourceSessionId !== op.mainSessionId || authorization.returnSessionId !== op.mainSessionId
      || authorization.manifestFingerprint !== op.manifestFingerprint
      || !isString(authorization.configFingerprint)
      || !validExecutionInput(op.executionInput, authorization.configFingerprint)) {
      return { ok: false, code: 'corrupt', message: 'authorized carrier input failed integrity validation' }
    }
  }
  return { ok: true, operation: deepFreeze(op as CarrierOperation) }
}

export function classifyCarrierResult(reason: CarrierTurnEndReason, evidence: CarrierAttributionEvidence): CarrierResult {
  if (evidence.expectedPromptRequestId !== evidence.promptRequestId) return { kind: 'attribution-unknown', reason: 'request-mismatch' }
  if (evidence.directClaimRequestIds.filter(id => id === evidence.expectedPromptRequestId).length !== 1
    || evidence.directClaimRequestIds.length !== 1) return { kind: 'attribution-unknown', reason: 'multiple-direct-claims' }
  if (evidence.claimedTurn !== evidence.turn) return { kind: 'attribution-unknown', reason: 'message-not-claimed' }
  if (reason === 'completed') {
    if (evidence.enteredTurn !== evidence.turn) return { kind: 'attribution-unknown', reason: 'message-not-entered' }
    if (evidence.sourceAssistantMessageId === undefined || evidence.visibleText === undefined || evidence.visibleText === '') {
      return { kind: 'completed-no-visible-output', completedTurn: evidence.turn, promptMessageId: evidence.promptMessageId, payload: '[上下文批改] 任务已完成，但没有可回传的可见正文。' }
    }
    return {
      kind: 'success', completedTurn: evidence.turn, promptMessageId: evidence.promptMessageId,
      sourceAssistantMessageId: evidence.sourceAssistantMessageId, payload: evidence.visibleText,
    }
  }
  return {
    kind: reason,
    completedTurn: evidence.turn,
    promptMessageId: evidence.promptMessageId,
    ...(evidence.failureCode === undefined ? {} : { failureCode: evidence.failureCode }),
    ...(evidence.failureMessage === undefined ? {} : { failureMessage: evidence.failureMessage }),
  }
}

function fixedFailurePayload(result: Exclude<CarrierResult, { kind: 'success' | 'completed-no-visible-output' | 'attribution-unknown' }>): string {
  const code = result.failureCode ?? `carrier/${result.kind}`
  const message = result.failureMessage ?? result.kind
  return `[上下文批改] 承载任务未成功完成（${code}）：${message}`
}

export function bindCarrierResult(op: CarrierOperation, result: CarrierResult): CarrierOperation {
  if (op.taskState === 'waiting-user') throw new Error('waiting-user is nonterminal and cannot freeze a final result')
  if (op.taskState !== 'running') throw new Error('terminal result is already frozen or carrier is not running')
  if (result.kind === 'attribution-unknown' || result.kind === 'forked') throw new Error('result attribution is unconfirmed; hold instead of fabricating a terminal')
  const success = result.kind === 'success' || result.kind === 'completed-no-visible-output'
  const payload = success ? result.payload : fixedFailurePayload(result)
  const taskState: CarrierTaskState = success ? 'completed' : result.kind === 'cancelled' ? 'cancelled' : 'failed'
  return next(op, {
    taskState,
    returnState: 'pending-send',
    resultKind: result.kind,
    promptMessageId: result.promptMessageId,
    completedTurn: result.completedTurn,
    ...(result.kind === 'success' ? { sourceAssistantMessageId: result.sourceAssistantMessageId } : {}),
    returnPayload: payload,
    returnPayloadFingerprint: stableHash(payload),
  })
}
