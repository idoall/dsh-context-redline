/**
 * Runtime skill: turn the current conversation into the four copy-paste fields
 * of an anchored conversation. The skill is optional — a harness without the
 * `skills` registry simply never mounts it.
 */

import type { Context } from '@deepseek-ai/cordis'

export const HANDOFF_SKILL_NAME = 'context-redline-handoff'

export const HANDOFF_SKILL_DESCRIPTION = 'Build both Context Redline handoff shapes from the current conversation: migration fields (first task + per-request runtime rule) and anchored fields (first task, goal, acceptance criteria, discipline), plus the optional Goal Guard package every time (auditable task list, plan file, evaluator choice) so the user can decide whether to enable it, with mandatory task decomposition and review gates.'

export const HANDOFF_SKILL_WHEN_TO_USE = 'Use when a conversation is long or drifting, when the user asks how to continue without losing the goal, before opening a fresh anchored conversation with Context Redline, or when the user asks about the Goal Guard, a task list for it, its evaluator, or its plan file.'

export const HANDOFF_SKILL_CONTENT = `# 上下文交接卡

当用户说“接下来怎么继续 / 别跑偏 / 帮我把任务拆成目标、验收、纪律 / 我要开新会话”时，用这个技能把当前对话压成一张可直接粘贴的交接卡。

## 先读再写

1. 读当前对话，找出：
   - 最初的目标（不是最近一句话）；
   - 已经验收 / 已完成的；
   - 还没做的、当前阻塞；
   - 用户给过的硬约束（路径、技术栈、不能做的事、合规边界）；
   - 完成标志（可执行的命令、文件、可观察结果）。
2. 先把目标拆成**任务清单**：至少每个里程碑 / 交付物一个独立任务，写清每个任务的产出与验收；不要把所有工作合成一个“完成整个项目”的任务。
3. 如果用户指的是另一个 DSH 会话：让对方先打开那个会话再执行，或把目标、最近结论、当前阻塞贴进来。不要猜。
4. 判断这次改动是否涉及**界面 / 交互 / 视觉（UI）**：
   - 涉及 → 验收标准必须写“有头 UAT”，执行纪律必须写“用有头模式打开真实界面，修正并复测到无问题才汇报”；
   - 不涉及（纯后端 / 文档 / 数据）→ 在验收标准里写“无需 UAT”及一句理由，不要硬加。
5. 在正文第一行给出推荐场景：
   - **情况 A**：新会话需要旧上下文 / 已确认的证据 → 用「上下文批改」里的「开启普通新会话」；
   - **情况 B**：新会话不需要旧上下文 → 用「新建带规则的对话」。

推荐行示例：\`推荐：情况 A（这次需要保留已确认的接口证据）。\`

## 情况 A：开启普通新会话（迁移旧上下文）

### 首条任务

\`\`\`text
（新会话第一句话：先读哪个文件；先建立任务清单并把第一个任务派给子会话；不要直接开始写代码）
\`\`\`

### 锚点（可选）· 选择「每轮运行时规则」

\`\`\`text
目标：（整个任务完成时才算达成的稳定目标）
验收：（可逐条检查的命令 / 文件 / 输出 / 用户验收；涉及 UI 时写有头 UAT 与复测证据，不涉及则写“无需 UAT”及理由）
纪律：（先拆任务：每个里程碑至少一个任务/子会话；主会话只规划/分派/审查，不直接开发；不得单会话连续做多个里程碑；即使我说“过程中不用确认”，拆分与审查不取消；有头 UAT；出错继续；每轮读计划；证据真实）
\`\`\`

### 最终发送全文

不用手填：确认框会根据首条任务和你保留 / 删除的迁移条目自动拼接；需要时再在框里微调。

## 情况 B：新建带规则的对话（不迁移上下文）

### 首条任务

\`\`\`text
（新会话第一句话：先读哪个文件；先建立任务清单并把第一个任务派给子会话；不要直接开始写代码）
\`\`\`

### 目标

\`\`\`text
（整个任务完成时才算达成的稳定目标；不要把它缩成当前里程碑）
\`\`\`

### 验收标准

\`\`\`text
（可逐条检查：任务清单 / 每个任务的子会话产物 / 主会话审查记录 / 命令 / 文件 / 输出 / 用户验收；有阶段时写“每个里程碑由用户验收后才进入下一阶段”；涉及 UI 时必须有有头 UAT 的复测证据，不涉及则写“无需 UAT”及理由；不得出现单会话连续完成多个里程碑）
\`\`\`

### 执行纪律

\`\`\`text
（先拆任务并每任务派子会话；主会话只规划/分派/审查，不直接开发；不得单会话连续做多个里程碑；即使我说“过程中不用确认”，拆分与审查不取消；有头 UAT 到无问题；出错继续；每轮读计划；证据真实；不扩范围）
\`\`\`

### 目标守卫（可选 · 要勾选就先贴这一段）

每次都给这一段，让用户自己决定要不要勾选；不勾选就直接忽略。技能只负责把格式、验收写法和注意事项给全，不替用户做决定，也不催用户开启。

\`\`\`text
T1 | M0 工具链与骨架 | 断网构建；typecheck；healthz
T2 | M1 场景与移动 | 60fps；移动端摇杆；缓存纠错
\`\`\`

- 每行格式：\`任务ID | 任务标题 | 验收项（用分号分隔）\`；一个里程碑至少一个任务，任务 ID 字母开头、不能重复。
- 验收必须“离开这段对话也能判”：评估器只看冻结目标卡 + 当前任务 + 该任务开始后的有界产出（最近几条助手正文、工具名、主会话写/执行与子会话计数），看不到完整历史。所以每条验收要写成命令、文件、可观察结果或明确的产物清单；不要写“体验良好”“按预期完成”这类只能由在场的人判断的话。
- 计划文件：对话里如果已经有明确的计划文件路径，就在交接卡里写出这个相对路径，并说明“守卫会把它的 hash 和目标卡一起冻结；文件改了会被记为阻塞（0.9.0 只记录、不阻断）”。没有就写“不填”加一句理由，不要编一个不存在的路径。
- 评估模型：默认「跟随主会话」就够；想要第二意见时建议在界面上另选一个模型，但**不要编造 provider/model 名称**，只说“建议另选一个模型”，具体由用户在界面里选。
- 0.9.0 只观察：判定和纠正建议只写进守卫卡，不拦工具、不 steer、也不替用户结束轮次。不要向用户承诺“会自动拦住”。
- 用户如果只说“三段”，仍保留四个字段：把「首条任务」和「目标」一起当作“任务目标”给出，方便直接粘贴。

## 两种场景怎么写

- **首条任务**：跨多个里程碑 / 交付物时，第一句必须是“先读计划，建立任务清单，把第一个任务派给子会话”；不要写“完成整个项目”，也不要直接让主会话开始写代码。
- **任务清单**：每个里程碑 / 交付物一个独立任务；每个任务写清产出、验收、负责的子会话。任务清单不进单独字段时，写进目标或纪律的开头。
- **目标**：用户最初要的结果，不是当前步骤；写清最终交付物和项目级成功判据。
- **验收标准**：每条都能执行或观察；区分“已确认 / 未验证”；禁止“体验良好”这类不可验收描述。必须包含任务清单、每个任务的子会话产物、主会话审查记录；不得出现“一个会话连续完成多个里程碑”的路径。**不要把“主会话审查”写成“用户逐任务批准”**：逐任务批准会把 N 个任务变成 N 次打断；需要用户点头的只有里程碑 / 全部完成，以及前提破裂时的路线选择。涉及 UI 时，验收里要有有头 UAT 的操作路径与复测结果；不涉及则写“无需 UAT”及理由。
- **执行纪律**：至少包含——
  1. **先拆任务**：每个里程碑 / 交付物一个独立任务，每个任务至少派一个子会话或团队成员；不得把所有工作合成一个连续任务。
  2. **主会话不直接开发、修改或测试**：只做规划、分派、审查；不得自己连续做多个任务 / 多个里程碑。
  3. 即使我说“过程中不用确认”，任务拆分与主会话审查也不取消；取消的只是“逐任务向用户请求批准”，不是审查。
  4. 子会话说“完成”不算通过：主会话必须审查成果，发现问题打回或重新分派，不直接代改。
  5. **涉及 UI / 交互 / 视觉的改动，必须有头模式做 UAT**：真实打开界面 / 浏览器，修正并复测到无问题才允许汇报；纯后端 / 文档改动写“无需 UAT”及理由。
  6. 出错时修正、复验、继续原目标；不得因报错 / 依赖失败改目标；
  7. 汇报节奏：主会话对照验收审查通过一个任务后**直接继续下一个**，不逐任务等用户批准；每完成一个里程碑向用户汇报一次，我明确说“过程中不用确认 / 一路做到底”时改为全部完成后汇报一次。只有这四种情况**必须**停下来问我：目标或验收需要改；实测前提被打破（环境不可用 / 许可缺失 / 需要我本人操作）；出现不可逆或外部副作用；发现安全或合规冲突；
  8. 每轮开始先读计划文件，完成一项就更新状态与证据；
  9. 不自行扩范围、不新增需求；计划变更先说明并等用户确认；
  10. 证据必须是真实命令输出 / 文件 / 截图，不能只写“已完成”；
  11. 不复制未授权素材、不泄露密钥 / 个人信息。

## 质量检查

- 新会话的模型只看这些字段，能不能知道第一件事做什么？
- 每条验收能不能被第三个人独立检查？
- 纪律有没有覆盖这次对话已经出现过的失败模式（跑偏、跳验收、假完成、上下文丢失）？
- 纪律有没有写明“先拆任务、每个任务派子会话、主会话只规划/分派/审查”？
- 任务清单的每条验收，评估器只看目标卡、当前任务和有界产出就能判定吗？判不了就改成命令 / 文件 / 可观察结果。
- 验收 / 纪律有没有把“主会话审查”误写成“用户逐任务批准”？逐任务用户确认会把 6 个任务变成 6 次打断。
- 计划文件是真的在对话里出现过路径吗？没有就写“不填”，不要编。
- 有没有一条路径会让一个会话连续做完多个里程碑？有就判不合格。
- UI 改动有没有有头 UAT 与复测证据；非 UI 改动有没有写“无需 UAT”的理由？
- 路径、命令、版本是否真实来自对话或用户？不确定就标“未验证”，不要编。
- 情况 A 的锚点控制在 2000 字符内；情况 B 每段也尽量控制在 2000 字符内（运行时规则每请求可见，越短越稳）。

## 最后一行

- 情况 A：粘贴「首条任务」+「锚点」，锚点模式选「每轮运行时规则」；最终发送全文由插件拼接。
- 情况 B：把四个字段粘贴到「新建带规则的对话」；要勾选「目标守卫」就把守卫那段的任务清单贴进守卫输入框，并按对话里的实际情况选评估模型 / 填计划文件；不勾选就忽略守卫段。
`

export interface HandoffSkillRegistration {
  readonly name: string
  readonly description: string
  readonly whenToUse: string
  /** Runtime-layer source; the registry fills invocation and provider itself. */
  readonly source: 'runtime'
  readonly content: string
}

/** The exact runtime registration; exported so the gate can pin the copy. */
export function handoffSkillRegistration(): HandoffSkillRegistration {
  return {
    name: HANDOFF_SKILL_NAME,
    description: HANDOFF_SKILL_DESCRIPTION,
    whenToUse: HANDOFF_SKILL_WHEN_TO_USE,
    source: 'runtime',
    content: HANDOFF_SKILL_CONTENT,
  }
}

interface SkillsFace {
  register?(skill: HandoffSkillRegistration): () => void
}

/**
 * Arm the handoff skill whenever the harness composes a skills registry. The
 * injected fiber owns the disposer: unloading the registry withdraws the skill.
 */
export function registerHandoffSkill(ctx: Context): void {
  ctx.inject(['skills'], (c) => {
    const skills = c.get('skills') as SkillsFace | undefined
    const register = skills?.register?.bind(skills)
    if (register === undefined) return
    try {
      c.effect(() => register(handoffSkillRegistration()), 'dsh-context-redline: handoff skill')
    } catch {
      // Skill registration is optional; a duplicate or a hostile registry must
      // never take the redline panel down with it.
    }
  })
}
