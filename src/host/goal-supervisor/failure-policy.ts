/**
 * Which provider failures justify trying a different model, and which must be
 * reported instead.
 *
 * DSH already classifies every model failure with a stable provider-neutral
 * code (`LlmFailure.code`), and its own README says consumers must route on the
 * code rather than on message text. This module is that routing table for the
 * supervisor: a judge that returns no text is a shape problem worth retrying on
 * another model, while an exhausted quota or a bad credential is a fact about
 * *this route* that a silently swapped judge would only hide.
 */

/** What the supervisor may do after one classified failure. */
export type FailureAction = 'switch' | 'report'

/** Codes worth trying on the next model: transport/shape, not account state. */
const SWITCHABLE = new Set([
  'EMPTY_RESPONSE',
  'MALFORMED_RESPONSE',
  'INVALID_RESPONSE',
  'TIMEOUT',
  'TRANSPORT',
  'SERVER',
  'STREAM_CLOSED',
  'RATE_LIMIT',
  'MODEL_SWITCH_COMPACTION_FAILED',
  // A verdict-shaped request that produced no JSON is a shape problem, not an
  // account problem: another model may well answer it.
  'UNPARSEABLE',
  'MAX_TOKENS',
])

/**
 * Quota failures are route-specific: an exhausted `antigravity` quota says
 * nothing about a `dimagent-oauth` fallback, so switching ACROSS providers is
 * useful while switching within one provider cannot help.
 */
const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA'])

/** Provider-neutral HTTP statuses that mean "this route cannot answer right now". */
function httpSwitchable(status: string): boolean {
  const code = Number.parseInt(status, 10)
  if (!Number.isFinite(code)) return false
  // 408/429 and every 5xx are reachability problems; 404 names a model the
  // route no longer serves, which another route may well serve.
  return code === 404 || code === 408 || code === 429 || (code >= 500 && code <= 599)
}

/**
 * Codes a retry on the SAME route cannot fix. Retrying them burns quota and
 * delays the operator-visible failure.
 */
const DEFINITIVE = new Set([
  'QUOTA',
  'ACCOUNT_QUOTA',
  'AUTH',
  'INVALID_CREDENTIAL',
  'MISSING_CREDENTIAL',
  'ACCOUNT_SIGN_IN_REQUIRED',
  'ACCOUNT_TOKEN_INVALID',
  'NO_ADAPTER',
  'UNKNOWN_MODEL',
  'MODEL_UNSUPPORTED',
  'UNSUPPORTED_REASONING_EFFORT',
  'UNSUPPORTED_CONTENT',
  'UNSUPPORTED_OPTION',
  'INVALID_REQUEST',
  // The client cannot talk to this deployment at all: asking the same route
  // again would fail identically, and another route is not the problem.
  'CLIENT_UPGRADE_REQUIRED',
  // The adapter rejected its own configuration; a retry cannot repair it.
  'INVALID_CONFIG',
  'CONTENT_REFUSED',
  'CONTEXT_WINDOW_EXCEEDED',
  'IMAGE_OFFLOAD_REQUIRED',
])

/**
 * True when retrying the same route cannot succeed.
 *
 * A `HTTP_4xx` is the provider rejecting THIS request (bad shape, missing
 * permission, unknown model). Only the reachability statuses `httpSwitchable`
 * already treats as transient (404/408/429) are worth another route; the rest
 * are definitive. 5xx never is: the provider may simply be down right now.
 */
export function isDefinitiveFailure(code: string | undefined): boolean {
  if (code === undefined) return false
  if (DEFINITIVE.has(code)) return true
  if (!code.startsWith('HTTP_')) return false
  const status = Number.parseInt(code.slice('HTTP_'.length), 10)
  return Number.isInteger(status) && status >= 400 && status <= 499 && !httpSwitchable(code.slice('HTTP_'.length))
}

/** True for codes that are about the ROUTE, not about this deployment's shape. */
export function isSwitchableFailure(code: string | undefined): boolean {
  if (code === undefined || code === '') return false
  if (SWITCHABLE.has(code)) return true
  if (code.startsWith('HTTP_')) return httpSwitchable(code.slice('HTTP_'.length))
  return false
}

/** True for quota exhaustion, which only another provider can work around. */
export function isQuotaFailure(code: string | undefined): boolean {
  return code !== undefined && QUOTA_CODES.has(code)
}

/**
 * Decide whether one failed route may be replaced by `nextProvider`.
 * @param code - `LlmFailure.code` of the failed route.
 * @param fromProvider - provider of the failed route.
 * @param nextProvider - provider of the candidate route.
 * @returns `switch` when trying the candidate is worth a call.
 */
export function failureAction(code: string | undefined, fromProvider: string, nextProvider: string): FailureAction {
  if (isQuotaFailure(code)) return fromProvider === nextProvider ? 'report' : 'switch'
  return isSwitchableFailure(code) ? 'switch' : 'report'
}

/** Short operator-facing label for one code (never replaces the code itself). */
export function failureLabel(code: string | undefined): string {
  if (code === undefined || code === '') return '未知失败'
  if (code === 'EMPTY_RESPONSE') return '模型未返回任何文本（EMPTY_RESPONSE）'
  if (code === 'UNPARSEABLE') return '模型没有给出可解析的判定（UNPARSEABLE）'
  if (code === 'MAX_TOKENS') return '输出达到 maxTokens 上限（MAX_TOKENS）'
  if (code === 'MALFORMED_RESPONSE' || code === 'INVALID_RESPONSE') return `响应格式异常（${code}）`
  if (code === 'TIMEOUT') return '调用超时（TIMEOUT）'
  if (code === 'TRANSPORT') return '网络传输失败（TRANSPORT）'
  if (code === 'STREAM_CLOSED') return '流被提前关闭（STREAM_CLOSED）'
  if (code === 'RATE_LIMIT') return '被限流（RATE_LIMIT）'
  if (code === 'SERVER') return '提供方服务端错误（SERVER）'
  if (code === 'QUOTA' || code === 'ACCOUNT_QUOTA') return `额度/余额不足（${code}）`
  if (code === 'AUTH' || code === 'INVALID_CREDENTIAL' || code === 'MISSING_CREDENTIAL') return `鉴权失败（${code}）`
  if (code === 'UNKNOWN_MODEL' || code === 'MODEL_UNSUPPORTED') return `模型不可用（${code}）`
  if (code === 'CONTEXT_WINDOW_EXCEEDED') return '超出上下文窗口（CONTEXT_WINDOW_EXCEEDED）'
  if (code === 'CONTENT_REFUSED') return '被内容策略拒绝（CONTENT_REFUSED）'
  if (code === 'UNSUPPORTED_REASONING_EFFORT') return '该模型不支持所选推理等级（UNSUPPORTED_REASONING_EFFORT）'
  if (code === 'UNSUPPORTED_CONTENT') return '该模型不接受当前内容类型（UNSUPPORTED_CONTENT）'
  if (code === 'UNSUPPORTED_OPTION') return '该模型不支持请求中的选项（UNSUPPORTED_OPTION）'
  if (code === 'NO_ADAPTER') return '没有注册该 provider（NO_ADAPTER）'
  if (code === 'ACCOUNT_SIGN_IN_REQUIRED') return '账号需要重新登录（ACCOUNT_SIGN_IN_REQUIRED）'
  if (code === 'ACCOUNT_TOKEN_INVALID') return '账号令牌失效（ACCOUNT_TOKEN_INVALID）'
  if (code === 'IMAGE_OFFLOAD_REQUIRED') return '图片需要卸载为路径（IMAGE_OFFLOAD_REQUIRED）'
  if (code === 'INVALID_REQUEST') return '请求被提供方判为无效（INVALID_REQUEST）'
  if (code.startsWith('HTTP_')) return `提供方 HTTP 错误（${code}）`
  return code
}
