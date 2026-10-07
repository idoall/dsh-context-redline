/**
 * 「这台机器允许多少个团队成员」—— `docs/10` **M5-13** 标题里那个分母的来源。
 *
 * 为什么这里不是一句常量（三件事决定的）：
 *
 * ① **分母不是库默认值**：官方 `maxMembers` 的**库默认是 16**，而本机由
 *    `…/@deepseek-ai/dsh-experimental-agent-team-profile/cordis.patch.yml` 配成 **8**
 *    （`docs/01` **F31** 实测）⟹ 写死任何一个数都会在另一种部署上变成假话；
 * ② **读它是一次"可能读不到"的动作**：服务可能没启用（团队未装配）、字段可能改名
 *    （TS 的 `private readonly config` 在运行时只是普通属性 `this.config`，**不是** JS `#private`，
 *    所以能读，但没有任何契约保证它一直在）⟹ **读不到就必须说"不知道"**，
 *    界面那时只写 `活跃 N`，**绝不编一个分母**；
 * ③ 通道来的值进渲染前要 **re-prove 形状**（`docs/11` D54 的教训：喂错形状曾把面板渲染炸掉）。
 *
 * 两边都用它：宿主用它读活服务（{@link capacityFromService}），客户端用它验通道回答
 * （{@link capacityOf}）—— 一个口径只有一处实现。
 */

/** 上限的两种状态：知道（`max` 是正整数）或不知道（`max` 为 null）。 */
export interface ChildCapacity {
  readonly known: boolean
  readonly max: number | null
}

/** 唯一的"不知道"取值（冻结：调用方不许就地改它）。 */
export const UNKNOWN_CAPACITY: ChildCapacity = Object.freeze({ known: false, max: null })

/** 只接受**正整数**：0 / 负数 / 小数 / `NaN` / 字符串一律算"读不到"。 */
function positiveIntOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null
}

/**
 * 从**活服务对象**上防御性读 `config.maxMembers`。
 *
 * @param service - `ctx.get('agentTeams')` 拿到的那个对象（可能是 `undefined`）。
 * @returns 读到正规正整数就是 `{known:true,max}`，其余一律 {@link UNKNOWN_CAPACITY}。
 */
export function capacityFromService(service: unknown): ChildCapacity {
  if (service === null || typeof service !== 'object') return UNKNOWN_CAPACITY
  const config = (service as { config?: unknown }).config
  if (config === null || typeof config !== 'object') return UNKNOWN_CAPACITY
  const max = positiveIntOf((config as { maxMembers?: unknown }).maxMembers)
  return max === null ? UNKNOWN_CAPACITY : { known: true, max }
}

/**
 * Re-prove 一个从通道读来的值（`child.capacity` 的回答）。
 *
 * @param raw - 通道回答里的 `value`，形状不可信。
 * @returns 形状对得上才是那个上限，否则 {@link UNKNOWN_CAPACITY}。
 */
export function capacityOf(raw: unknown): ChildCapacity {
  if (raw === null || typeof raw !== 'object') return UNKNOWN_CAPACITY
  const value = raw as { known?: unknown; max?: unknown }
  if (value.known !== true) return UNKNOWN_CAPACITY
  const max = positiveIntOf(value.max)
  return max === null ? UNKNOWN_CAPACITY : { known: true, max }
}
