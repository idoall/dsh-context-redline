/**
 * 官方 Agent Teams 那份数据的**只读归一化**（M5-07 的读半边）。
 *
 * 官方把这支队伍挂在 **Lead 会话**的 `agentTeam` 投影上（安装树
 * `@deepseek-ai/dsh-experimental-agent-team` 的 `TeamProjection`）：
 *
 * ```ts
 * interface TeamProjection {
 *   members: TeamMemberProjection[]   // { id, name, role:'lead'|'teammate', phase:'provisioning'|'active'|'failed', error? }
 *   tasks: TeamTaskView[]             // { id, revision, subject, description, status, blockedBy,
 *                                        writeScopes, ownerName?, ready, writeScopeWarnings }
 *   failure?: string
 * }
 * ```
 *
 * 我们**不自己造协作层**（`docs/11` D10）：这里只把官方那份数据**原样读出来**给界面显示，
 * 一个字段都不改、也不猜。三件事必须诚实：
 * ① **读不到就说读不到**（返回 `null`，界面写"这台运行时没有这个数据"）；
 * ② **空队伍 ≠ 没有数据**（`members: []` 是"有这块、里面没人"）；
 * ③ **官方的 `failure` 要透传**（它是"第一条被拒的团队记录"，静默掉就等于骗人）。
 */

/** 一名成员（归一化后）。认不出的 role/phase 落 `'unknown'`，不硬猜。 */
export interface TeamMemberRow {
  id: string
  name: string
  role: 'lead' | 'teammate' | 'unknown'
  phase: 'provisioning' | 'active' | 'failed' | 'unknown'
  /** 官方给的失败说明（成员级），没有就是 null。 */
  error: string | null
}

/** 一条任务（归一化后）。只保留界面要显示的那几个字段。 */
export interface TeamTaskRow {
  id: string
  revision: number
  subject: string
  status: string
  /** 谁在做；没有负责人就是 null。 */
  ownerName: string | null
  /** 官方判的"现在能不能开工"。 */
  ready: boolean
}

/** 一整块官方团队数据。 */
export interface TeamBoard {
  members: TeamMemberRow[]
  tasks: TeamTaskRow[]
  /** 官方声明的失败（"第一条被拒的团队记录"），没有就是 null。 */
  failure: string | null
}

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

function memberOf(raw: unknown): TeamMemberRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = asString(row.id)
  if (id === null) return null // 没有身份的行没法用，丢掉而不是编一个
  const role = row.role === 'lead' || row.role === 'teammate' ? row.role : 'unknown'
  const phase = row.phase === 'provisioning' || row.phase === 'active' || row.phase === 'failed' ? row.phase : 'unknown'
  return { id, name: asString(row.name) ?? '', role, phase, error: asString(row.error) }
}

function taskOf(raw: unknown): TeamTaskRow | null {
  if (raw === null || typeof raw !== 'object') return null
  const row = raw as Record<string, unknown>
  const id = asString(row.id)
  if (id === null) return null
  return {
    id,
    revision: typeof row.revision === 'number' ? row.revision : 0,
    subject: asString(row.subject) ?? '',
    status: asString(row.status) ?? 'unknown',
    ownerName: asString(row.ownerName),
    ready: row.ready === true,
  }
}

/**
 * 读官方 `agentTeam` 投影：`null` = **这台运行时没有这份数据**（老版本 / 团队未启用），
 * 其余情况返回归一化后的 {@link TeamBoard}（可能是空板）。
 */
export function teamBoardOf(raw: unknown): TeamBoard | null {
  if (raw === null || raw === undefined) return null
  if (typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  const members = Array.isArray(value.members) ? value.members.map(memberOf).filter((m): m is TeamMemberRow => m !== null) : null
  const tasks = Array.isArray(value.tasks) ? value.tasks.map(taskOf).filter((t): t is TeamTaskRow => t !== null) : null
  // 两个数组都不是数组 ⟹ 这不像官方的团队数据，按"没有"处理（不硬编一个空板骗界面）。
  if (members === null && tasks === null) return null
  return { members: members ?? [], tasks: tasks ?? [], failure: asString(value.failure) }
}
