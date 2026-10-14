/**
 * Capture stable migration identities and complete text from one already-read
 * session surface. Pure structural code: no platform runtime, Node, DOM, or React.
 */

/** The event-shaped subset returned by one SessionSurfaceSnapshot read. */
export interface SurfaceSnapshotEvent {
  readonly seq?: unknown
  readonly type?: unknown
  readonly data?: unknown
}

/**
 * Structural input for one atomic surface read. The host adapter must pass the
 * session id and high-water mark belonging to this exact read.
 */
export interface SessionSurfaceSnapshot {
  readonly sessionId: string
  readonly capturedThroughSeq: number | null
  readonly events: readonly SurfaceSnapshotEvent[]
}

export interface EventSourceKey {
  readonly kind: 'event'
  readonly sourceSessionId: string
  readonly seq: number
  readonly type: string
}

/**
 * Identity contract for future request-material capture. Event surfaces cannot
 * prove these fields, so this module deliberately never creates this key kind.
 */
export interface RequestMaterialSourceKey {
  readonly kind: 'request-material'
  readonly sourceSessionId: string
  readonly requestIdentity: string
  readonly headerEpochIdentity: string
  readonly section: 'system' | 'tools' | 'injection' | 'skill'
  readonly blockIdentity: string
}

export type SourceKey = EventSourceKey | RequestMaterialSourceKey
export type CapturedSourceRole = 'system' | 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

export interface CapturedToolLink {
  readonly callId: string
  readonly name: string
  readonly argsSummary: string
}

export interface CapturedEventSource {
  readonly sourceKey: EventSourceKey
  readonly sourceRole: CapturedSourceRole
  readonly order: number
  readonly text: string
  readonly reasoning?: string
  readonly isError?: boolean
  readonly toolLink?: CapturedToolLink
}

export interface EventSourceCapture {
  readonly sourceSessionId: string
  readonly capturedThroughSeq: number
  readonly surfaceFingerprint: string
  /** Image blocks intentionally omitted from the text-only delivery. */
  readonly omittedImages: number
  readonly candidates: readonly CapturedEventSource[]
}

export type SourceCaptureErrorCode =
  | 'session-id-mismatch'
  | 'invalid-snapshot-version'
  | 'invalid-identity'
  | 'duplicate-identity'
  | 'unpaired-tool-result'
  | 'unsupported-content'

export class SourceCaptureError extends Error {
  readonly code: SourceCaptureErrorCode

  constructor(code: SourceCaptureErrorCode, message: string) {
    super(message)
    this.name = 'SourceCaptureError'
    this.code = code
  }
}

/** Stable serialized identity for an event source. */
export function eventSourceKeyOf(key: EventSourceKey): string {
  return `event:${key.sourceSessionId}:${String(key.seq)}:${key.type}`
}

const FINGERPRINT_LANES = 8
const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193
const LANE_SEED_MIX = 0x9e3779b9

/** Deterministic, non-cryptographic change fingerprint. */
function fingerprintOf(value: string): string {
  const lanes = new Uint32Array(FINGERPRINT_LANES)
  for (let index = 0; index < FINGERPRINT_LANES; index += 1) {
    lanes[index] = (FNV_OFFSET_BASIS ^ Math.imul(index + 1, LANE_SEED_MIX)) >>> 0
  }
  for (let position = 0; position < value.length; position += 1) {
    const code = value.charCodeAt(position)
    for (let index = 0; index < FINGERPRINT_LANES; index += 1) {
      const mixed = Math.imul((lanes[index] ?? 0) ^ code, FNV_PRIME) >>> 0
      lanes[index] = (mixed ^ (mixed >>> 13)) >>> 0
    }
  }
  return Array.from(lanes, lane => lane.toString(16).padStart(8, '0')).join('')
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function contentOf(type: string, data: Record<string, unknown>): readonly unknown[] {
  if (type === 'user/message') return Array.isArray(data.content) ? data.content : []
  const message = recordOf(data.message)
  return message !== null && Array.isArray(message.content) ? message.content : []
}

const REJECTED_BLOCK_TYPES = new Set(['attachment', 'image_url', 'file', 'file-ref'])
const KNOWN_NON_TEXT_BLOCK_TYPES = new Set(['tool-call', 'tool-addition', 'tool-removal'])
const KNOWN_WRAPPER_BLOCK_TYPES = new Set(['tool-result'])

/** Validate rich blocks and count images that text-only delivery intentionally omits. */
function validateBlocks(blocks: readonly unknown[], identity: string): number {
  let images = 0
  for (const value of blocks) {
    const block = recordOf(value)
    if (block === null) continue
    const type = typeof block.type === 'string' && block.type !== ''
      ? block.type
      : typeof block.kind === 'string' && block.kind !== '' ? block.kind : ''
    if (type === 'image') { images += 1; continue }
    if (REJECTED_BLOCK_TYPES.has(type)) {
      throw new SourceCaptureError('unsupported-content', `${identity} contains unsupported text-only-v1 block: ${type}`)
    }
    if (type !== '' && type !== 'text' && type !== 'reasoning'
      && !KNOWN_NON_TEXT_BLOCK_TYPES.has(type) && !KNOWN_WRAPPER_BLOCK_TYPES.has(type)) {
      throw new SourceCaptureError('unsupported-content', `${identity} contains unknown content block: ${type}`)
    }
    if (Array.isArray(block.content)) images += validateBlocks(block.content, identity)
  }
  return images
}

function blockTexts(blocks: readonly unknown[], wanted: 'text' | 'reasoning'): string[] {
  const output: string[] = []
  for (const value of blocks) {
    const block = recordOf(value)
    if (block === null) continue
    if (block.type === wanted && typeof block.text === 'string' && block.text.trim() !== '') output.push(block.text)
    // Durable tool-result wrappers contain the actual result blocks in `content`.
    if (Array.isArray(block.content)) output.push(...blockTexts(block.content, wanted))
  }
  return output
}

function roleOf(type: string, data: Record<string, unknown>): CapturedSourceRole | null {
  if (type === 'system/message' || type === 'developer/message') return 'system'
  if (type === 'user/message') {
    const source = recordOf(data.source)
    const kind = typeof source?.kind === 'string' ? source.kind : 'user'
    if (kind === 'skill-invocation' || kind === 'skill-catalog' || kind === 'skill') return 'skill'
    return kind === 'user' ? 'user' : 'inject'
  }
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  return null
}

function callIdOf(data: Record<string, unknown>): string | null {
  if (typeof data.callId === 'string' && data.callId !== '') return data.callId
  const message = recordOf(data.message)
  if (message === null) return null
  if (typeof message.toolCallId === 'string' && message.toolCallId !== '') return message.toolCallId
  const source = recordOf(message.source)
  if (source !== null && typeof source.callId === 'string' && source.callId !== '') return source.callId
  const content = Array.isArray(message.content) ? message.content : []
  for (const value of content) {
    const block = recordOf(value)
    if (block !== null && typeof block.toolCallId === 'string' && block.toolCallId !== '') return block.toolCallId
  }
  return null
}

function isErrorOf(data: Record<string, unknown>): boolean {
  if (data.error !== undefined && data.error !== null && data.error !== false && data.error !== '') return true
  const message = recordOf(data.message)
  if (message === null) return false
  if (message.isError === true) return true
  const content = Array.isArray(message.content) ? message.content : []
  return content.some(value => recordOf(value)?.isError === true)
}

function canonical(value: unknown): string {
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'undefined') return '"[undefined]"'
  if (typeof value === 'bigint') return JSON.stringify(String(value))
  if (typeof value === 'symbol' || typeof value === 'function') return JSON.stringify(String(value))
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}

function argumentsSummaryOf(value: unknown): string {
  return typeof value === 'string' ? value : canonical(value)
}

interface ToolCall {
  readonly callId: string
  readonly name: string
  readonly argsSummary: string
}

/**
 * Capture event material from exactly one surface snapshot.
 *
 * Tool calls are retained only as pairing metadata; request material is not
 * inferred from event rows. Every event must nevertheless carry a valid stable
 * identity so malformed inputs cannot be silently skipped.
 */
export function captureEventSourceSnapshot(
  sourceSessionId: string,
  snapshot: SessionSurfaceSnapshot,
): EventSourceCapture {
  if (sourceSessionId === '' || snapshot.sessionId !== sourceSessionId) {
    throw new SourceCaptureError(
      'session-id-mismatch',
      `surface session ${snapshot.sessionId || '<missing>'} does not match source session ${sourceSessionId || '<missing>'}`,
    )
  }
  const capturedThroughSeq = snapshot.capturedThroughSeq ?? -1
  if (!Number.isSafeInteger(capturedThroughSeq) || capturedThroughSeq < -1) {
    throw new SourceCaptureError('invalid-snapshot-version', 'capturedThroughSeq must be null or a non-negative safe integer')
  }

  const seen = new Set<string>()
  const calls = new Map<string, ToolCall>()
  const candidates: CapturedEventSource[] = []
  let omittedImages = 0

  // Validate every event before selecting candidates, and build the call ledger
  // independently of array order so a matching call is used whenever available.
  for (const event of snapshot.events) {
    const seq = event.seq
    const type = event.type
    if (!Number.isSafeInteger(seq) || (seq as number) < 0 || typeof type !== 'string' || type === '') {
      throw new SourceCaptureError('invalid-identity', 'every surface event requires a non-negative safe seq and non-empty type')
    }
    const identity = eventSourceKeyOf({ kind: 'event', sourceSessionId, seq: seq as number, type })
    if (seen.has(identity)) throw new SourceCaptureError('duplicate-identity', `duplicate event source identity: ${identity}`)
    seen.add(identity)

    const data = recordOf(event.data) ?? {}
    if (type === 'tool/call' && typeof data.callId === 'string' && data.callId !== ''
      && typeof data.name === 'string' && data.name !== '') {
      calls.set(data.callId, {
        callId: data.callId,
        name: data.name,
        argsSummary: argumentsSummaryOf(data.arguments),
      })
    }
  }

  for (const event of snapshot.events) {
    const seq = event.seq as number
    const type = event.type as string
    if (type === 'tool/call') continue
    const sourceKey: EventSourceKey = { kind: 'event', sourceSessionId, seq, type }
    const identity = eventSourceKeyOf(sourceKey)
    const data = recordOf(event.data) ?? {}
    const sourceRole = roleOf(type, data)
    if (sourceRole === null) continue
    const blocks = contentOf(type, data)
    omittedImages += validateBlocks(blocks, identity)
    const visibleText = blockTexts(blocks, 'text').join('\n\n')
    const reasoning = blockTexts(blocks, 'reasoning').join('\n\n')
    const callId = type === 'tool/result' ? callIdOf(data) : null
    const toolLink = callId === null ? undefined : calls.get(callId)
    if (type === 'tool/result' && (callId === null || toolLink === undefined)) {
      throw new SourceCaptureError('unpaired-tool-result', `${identity} has no matching tool/call identity`)
    }
    // A pure-image message has no honest text-only representation. Count it for
    // confirmation, but do not fabricate an empty migration paragraph.
    if (visibleText === '' && reasoning === '') continue

    candidates.push({
      sourceKey,
      sourceRole,
      order: seq,
      text: visibleText,
      ...(reasoning === '' ? {} : { reasoning }),
      ...(type === 'tool/result' ? { isError: isErrorOf(data) } : {}),
      ...(toolLink === undefined ? {} : { toolLink }),
    })
  }

  candidates.sort((left, right) => (
    left.order - right.order
    || eventSourceKeyOf(left.sourceKey).localeCompare(eventSourceKeyOf(right.sourceKey))
  ))
  // Fingerprint the complete captured surface, not just migratable rows. A tool
  // call or other surface metadata change must invalidate confirmation too.
  const surfaceFingerprint = fingerprintOf(canonical({
    sourceSessionId,
    capturedThroughSeq,
    events: snapshot.events,
  }))

  return {
    sourceSessionId,
    capturedThroughSeq,
    surfaceFingerprint,
    omittedImages,
    candidates,
  }
}
