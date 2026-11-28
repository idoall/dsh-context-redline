import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import { configureEvaluatorReasoning, EVALUATOR_TIMEOUT_MS, resolveEvaluatorRoutes, routeLabel } from './evaluator'
import { failureAction, failureLabel, isDefinitiveFailure } from './failure-policy'
import type { GuardState, GuardTask, ModelRoute } from './schema'

/** One visual observation. It is evidence, never a verdict. */
export interface VisualFinding {
  readonly criterion: string
  readonly severity: 'info' | 'warn' | 'fail'
  readonly what: string
  readonly where?: string
}

/** Path + content hash of one screenshot the witness actually saw. */
export interface VisualImageRef {
  readonly path: string
  readonly sha256: string
}

/** What the witness produced for one audit; `unavailable` is a first-class result. */
export type VisualWitness =
  | {
    readonly result: 'ok'
    readonly model: string
    readonly findings: readonly VisualFinding[]
    readonly summary?: string
    readonly images: readonly VisualImageRef[]
    readonly artifact?: string
  }
  | {
    readonly result: 'unavailable'
    readonly model?: string
    readonly reason: string
    readonly images: readonly VisualImageRef[]
  }

/** The loop context pieces the witness needs (kept structural for tests). */
export interface VisualDeps {
  readonly ctx: {
    get(name: string): unknown
  }
  readonly cwd: string
  readonly store: { evidencePath(taskId: string, name: string): string }
  readonly state: GuardState
  readonly task: GuardTask
  /** Candidate paths (changed + ignored) the audit already computed. */
  readonly paths: readonly string[]
  readonly agent: {
    readonly model?: {
      current?(): {
        provider?: string
        model?: string
      } | undefined
    }
    readonly options?: {
      readonly provider?: string
      readonly model?: string
    }
  }
  readonly timeoutMs?: number
  /** Per-image read ceiling; the default is the adapter-safe 20 MiB. */
  readonly maxReadBytes?: number
}

interface SaveImageInput {
  readonly data: Uint8Array
  readonly mediaType: string
  readonly name?: string
}

interface SavedImage {
  readonly attachmentId: string
}

interface AttachmentFace {
  saveImages?(inputs: readonly SaveImageInput[]): Promise<readonly SavedImage[]>
}

interface PreparedStream {
  readonly config: Record<string, unknown>
  /**
   * Declared input modalities of the resolved model. Absent means "unknown", NOT
   * "text only"; an array without `image` is authoritative and the adapter would
   * quietly replace the screenshot with a text placeholder.
   */
  readonly inputModalities?: readonly string[]
  stream(options: Record<string, unknown>): AsyncIterable<unknown>
}

interface LlmFace {
  prepareCall?(
    config: Record<string, unknown>,
    signal?: AbortSignal,
    configure?: (controls: Record<string, unknown>, model: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<PreparedStream>
}

interface PickedImage extends VisualImageRef {
  readonly absolute: string
  readonly bytes: Uint8Array
  readonly mediaType: string
}

const IMAGE_EXT = /\.(png|jpe?g|webp)$/i
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
}
/**
 * The adapter normalizes to its own budget (2048²/1 MiB for this profile), so a
 * typical 1080p PNG above 1 MiB is still usable: reading it whole is fine, and
 * only an unreasonable file is skipped before decoding.
 */
const MAX_IMAGES = 5
const MAX_READ_BYTES = 20 * 1024 * 1024
const WITNESS_TIMEOUT_MS = EVALUATOR_TIMEOUT_MS
const WITNESS_SYSTEM = '你是视觉取证员。你只能观察截图并列出问题，**不得给出通过/不通过的结论**。'
  + '只报告你确实看到的内容；看不清就写“看不清”，不要猜测。'
  + '输出 JSON：{findings:[{criterion,severity:info|warn|fail,what,where}],summary}。'
  + 'criterion 必须是验收条目里出现过的原句；what 描述画面里的具体现象；'
  + 'where 写画面位置（如“左下角 HUD”“中央人物腰部”）。'

function witnessRoutes(deps: VisualDeps): readonly ModelRoute[] {
  const routes: ModelRoute[] = []
  const push = (route: ModelRoute | undefined): void => {
    if (route === undefined || route.provider === '' || route.model === '') return
    if (routes.some(item => item.provider === route.provider && item.model === route.model
      && item.reasoningEffort === route.reasoningEffort)) return
    routes.push(route)
  }
  push(deps.state.visual?.route)
  if (routes.length === 0) {
    // Default: whatever the judge runs on (explicit route or session model).
    const primary = resolveEvaluatorRoutes(deps.state, deps.agent).at(0)
    push(primary)
  }
  push(deps.state.visual?.fallback)
  return routes
}

/** Pick the task's changed images, hash them, and drop anything unreadable. */
async function pickImages(deps: VisualDeps): Promise<readonly PickedImage[]> {
  const limit = deps.maxReadBytes ?? MAX_READ_BYTES
  const picked: PickedImage[] = []
  for (const path of deps.paths) {
    if (picked.length >= MAX_IMAGES) break
    if (!IMAGE_EXT.test(path)) continue
    const mediaType = (MEDIA_TYPES as Readonly<Record<string, string | undefined>>)[extname(path).toLowerCase()]
    if (mediaType === undefined) continue
    const absolute = join(deps.cwd, path)
    const bytes = await readFile(absolute).catch(() => null)
    if (bytes === null || bytes.byteLength === 0 || bytes.byteLength > limit) continue
    picked.push({
      path,
      absolute,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes,
      mediaType,
    })
  }
  return picked
}

interface ParsedFindings {
  readonly findings: readonly VisualFinding[]
  readonly summary?: string
}

function parseFindings(body: string): ParsedFindings | null {
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const bag = parsed as {
    findings?: unknown
    summary?: unknown
  }
  if (!Array.isArray(bag.findings)) return null
  const findings: VisualFinding[] = []
  for (const item of bag.findings) {
    if (item === null || typeof item !== 'object') continue
    const row = item as Record<string, unknown>
    const criterion = typeof row.criterion === 'string' ? row.criterion.trim() : ''
    const what = typeof row.what === 'string' ? row.what.trim() : ''
    if (criterion === '' || what === '') continue
    const severity = row.severity === 'fail' || row.severity === 'warn' || row.severity === 'info' ? row.severity : 'info'
    findings.push({
      criterion: criterion.slice(0, 200),
      severity,
      what: what.slice(0, 300),
      ...(typeof row.where === 'string' && row.where.trim() !== '' ? { where: row.where.trim().slice(0, 120) } : {}),
    })
  }
  return {
    findings,
    ...(typeof bag.summary === 'string' && bag.summary.trim() !== '' ? { summary: bag.summary.trim().slice(0, 300) } : {}),
  }
}

/** Write the raw findings next to the task's other evidence; best effort. */
async function writeArtifact(
  deps: VisualDeps,
  model: string | undefined,
  images: readonly VisualImageRef[],
  parsed: ParsedFindings,
): Promise<string | undefined> {
  try {
    // `evidencePath` returns the full file path; take its directory without
    // assuming a POSIX separator.
    const dir = dirname(deps.store.evidencePath(deps.task.id, 'visual.json'))
    await mkdir(dir, { recursive: true })
    const name = `visual-${Date.now()}.json`
    await writeFile(deps.store.evidencePath(deps.task.id, name), JSON.stringify({
      model,
      images,
      findings: parsed.findings,
      ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
    }, null, 2), 'utf8')
    return name
  } catch {
    return undefined
  }
}

/**
 * Run the observation-only witness for one audit.
 *
 * Returns `undefined` when the run never enabled it. A run that enabled it but
 * has no usable screenshot, no vision route, or an empty reply reports
 * `unavailable` — the caller must not turn that into a pass.
 */
export async function runVisualWitness(deps: VisualDeps): Promise<VisualWitness | undefined> {
  if (deps.state.visual?.enabled !== true) return undefined
  const images = await pickImages(deps)
  const hashes = images.map(image => ({ path: image.path, sha256: image.sha256 }))
  if (images.length === 0) {
    return { result: 'unavailable', reason: '本任务没有新增或修改的截图（png/jpg/webp）', images: hashes }
  }
  const ctx = deps.ctx
  const attachments = ctx.get('attachments') as AttachmentFace | undefined
  const llm = ctx.get('llm') as LlmFace | undefined
  if (attachments?.saveImages === undefined || llm?.prepareCall === undefined) {
    return { result: 'unavailable', reason: '视觉取证服务不可用（attachments/llm 未挂载）', images: hashes }
  }
  const routes = witnessRoutes(deps)
  if (routes.length === 0) return { result: 'unavailable', reason: '未配置视觉取证模型', images: hashes }
  let refs: readonly SavedImage[]
  try {
    refs = await attachments.saveImages(images.map(image => ({
      data: image.bytes,
      mediaType: image.mediaType,
      name: basename(image.path),
    })))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { result: 'unavailable', reason: `截图入库失败：${reason}`, images: hashes }
  }
  const text = JSON.stringify({
    task: { id: deps.task.id, title: deps.task.title, acceptance: deps.task.acceptance },
    instruction: '只列出你能在这几张截图里观察到的现象；每条挂到一条验收条目上；不要给通过/不通过结论。',
  })
  const timeoutMs = deps.timeoutMs ?? WITNESS_TIMEOUT_MS
  let lastReason = '视觉取证模型不可用'
  let lastCode: string | undefined
  let lastModel: string | undefined
  for (let index = 0; index < routes.length; index += 1) {
    const route = routes[index]
    lastModel = routeLabel(route)
    // A model whose adapter declared text-only input is unusable for the witness:
    // the runtime does not fail such a call, it swaps the images for a text
    // placeholder, so the reply would be a fabricated (imageless) observation.
    let modalityBlocked = false
    // A vision reply can hit the token ceiling before any JSON appears; raise
    // the budget once, then report a second truncation as MAX_TOKENS.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const deadline = AbortSignal.timeout(timeoutMs)
      try {
        const prepared = await llm.prepareCall(
          { provider: route.provider, model: route.model, temperature: 0 },
          deadline,
          configureEvaluatorReasoning(route.reasoningEffort),
        )
        if (Array.isArray(prepared.inputModalities) && !prepared.inputModalities.includes('image')) {
          modalityBlocked = true
          lastCode = 'UNSUPPORTED_CONTENT'
          lastReason = '模型未声明图片输入（UNSUPPORTED_CONTENT）'
          break
        }
        const assembler = new BlockAssembler()
        for await (const chunk of prepared.stream({
          ...prepared.config,
          signal: deadline,
          system: WITNESS_SYSTEM,
          messages: [
            createUserMessage({
              content: [
                { type: 'text', text },
                ...refs.map(ref => ({ type: 'image' as const, attachment: ref as never })),
              ],
              source: { kind: 'user' },
            }) as never,
          ],
          tools: [],
        })) assembler.push(chunk as never)
        const finish = assembler.finish as {
          readonly kind?: string
          readonly failure?: {
            readonly message?: string
            readonly code?: string
          }
        } | null
        if (finish !== null && (finish.kind === 'error' || finish.kind === 'aborted')) {
          // The real adapter reports an aborted call with a NON-EMPTY
          // `failure.code = 'UNKNOWN' | 'ABORTED'`, so the deadline must win:
          // otherwise the switchable TIMEOUT classification never applied and
          // the configured fallback route was never tried.
          lastCode = deadline.aborted ? 'TIMEOUT' : finish.failure?.code
          const message = finish.failure?.message
          lastReason = deadline.aborted
            ? failureLabel('TIMEOUT')
            : message !== undefined && message.trim() !== '' ? message.trim().slice(0, 200) : '视觉取证调用失败'
          if (isDefinitiveFailure(lastCode)) break
          continue
        }
        if (finish !== null && finish.kind === 'max-tokens') {
          lastCode = 'MAX_TOKENS'
          lastReason = failureLabel('MAX_TOKENS')
          break
        }
        const body = assembler.blocks().flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
        if (body.trim() === '') {
          lastCode = 'EMPTY_RESPONSE'
          lastReason = '模型未返回任何文本（EMPTY_RESPONSE）'
          continue
        }
        const parsed = parseFindings(body)
        if (parsed === null) {
          lastCode = 'UNPARSEABLE'
          lastReason = '视觉取证返回了不可解析的结果'
          continue
        }
        const artifact = await writeArtifact(deps, lastModel, hashes, parsed)
        return {
          result: 'ok',
          model: lastModel,
          findings: parsed.findings,
          ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
          images: hashes,
          ...(artifact === undefined ? {} : { artifact }),
        }
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code
        // `AbortSignal.timeout()` throws a DOMException with a NUMERIC `code`, so
        // a deadline used to look like an unclassified failure and never moved
        // on to the configured fallback route.
        lastCode = deadline.aborted
          ? 'TIMEOUT'
          : typeof code === 'string' && code !== '' ? code : undefined
        lastReason = error instanceof Error && error.message.trim() !== '' ? error.message.trim().slice(0, 200) : '视觉取证调用失败'
        if (isDefinitiveFailure(lastCode)) break
      }
    }
    if (index + 1 < routes.length) {
      const next = routes[index + 1]
      // A declared text-only route is a route problem, not a deployment problem:
      // the configured visual fallback is exactly the right next attempt, whatever
      // `failureAction` would say about UNSUPPORTED_CONTENT.
      if (!modalityBlocked && failureAction(lastCode, route.provider, next.provider) !== 'switch') break
    }
  }
  return {
    result: 'unavailable',
    reason: failureReason(lastCode, lastReason),
    ...(lastModel === undefined ? {} : { model: lastModel }),
    images: hashes,
  }
}

/**
 * One operator-facing reason line.
 *
 * Some branches already stored the exact label (`EMPTY_RESPONSE`, `MAX_TOKENS`),
 * so prefixing it unconditionally rendered the same sentence twice.
 */
function failureReason(code: string | undefined, detail: string): string {
  const label = failureLabel(code)
  if (detail === label || detail.includes(label)) return detail
  if (code !== undefined && detail.includes(`（${code}）`)) return detail
  return `${label}：${detail}`
}
