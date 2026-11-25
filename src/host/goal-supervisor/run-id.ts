/**
 * Run-id and ref-segment sanitizing.
 *
 * Git refs reject `: ? * [ ~ ^ \` and friends, and macOS also rejects some
 * characters in tag names. A goal's first line is free text, so every segment
 * that becomes a ref (the run id and the task id in `guard/<run>/<task>`) is
 * normalized here instead of at the call site.
 */

const MAX_TOPIC = 40
const MAX_RUN_ID = 50
const ALLOWED = /[\p{L}\p{N}_-]/u

/**
 * The only run ids the channel accepts.
 *
 * It must match what `buildRunId` can produce: `\p{L}` covers accented Latin,
 * kana and Hangul, so the older `[A-Za-z0-9\u4e00-\u9fff_]` pattern rejected the
 * very ids this module generated (a goal written as `café 重构` produced a run
 * whose `anchor.start` could never be accepted). A leading `-` stays banned so a
 * segment can never look like a flag.
 */
export const SAFE_RUN_ID = /^[\p{L}\p{N}_][\p{L}\p{N}_-]{0,49}$/u

function normalize(value: string): string {
  return value.normalize('NFC').replace(/[\u0000-\u001f\u007f]/gu, ' ')
}

/** One safe ref segment: letters, digits, `_` and `-`; never empty. */
export function sanitizeRefSegment(value: string, max = MAX_TOPIC): string {
  let cleaned = ''
  for (const char of normalize(value)) {
    if (ALLOWED.test(char)) cleaned += char
    else cleaned += '-'
  }
  cleaned = cleaned.replace(/-+/g, '-').replace(/^[-.]+|[-.]+$/g, '')
  if (cleaned === '') cleaned = 'run'
  const points = Array.from(cleaned)
  if (points.length > max) cleaned = points.slice(0, max).join('').replace(/[-.]+$/g, '')
  return cleaned === '' ? 'run' : cleaned
}

function dateStamp(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}${month}${day}`
}

/**
 * `<YYYYMMDD>-<topic>`; collisions get `-2`, `-3`, … and the whole id stays
 * within `MAX_RUN_ID` characters.
 *
 * The fallback keeps walking past 99 with a longer suffix instead of returning
 * a fixed name that may already be taken.
 */
export function buildRunId(date: Date, topic: string, taken: ReadonlySet<string> = new Set()): string {
  const stamp = dateStamp(date)
  const room = MAX_RUN_ID - stamp.length - 1
  const baseTopic = sanitizeRefSegment(topic, Math.min(MAX_TOPIC, room))
  const base = `${stamp}-${baseTopic}`
  if (!taken.has(base)) return base
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `-${suffix}`
    const candidateTopic = sanitizeRefSegment(baseTopic, Math.max(1, Math.min(MAX_TOPIC, room - tail.length)))
    const candidate = `${stamp}-${candidateTopic}${tail}`
    if (!taken.has(candidate)) return candidate
  }
  return `${stamp}-run-${Date.now().toString(36).slice(-6)}`
}
