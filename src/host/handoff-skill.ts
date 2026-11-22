/**
 * Runtime skill: turn the current conversation into the four copy-paste fields
 * of an anchored conversation. The skill is optional — a harness without the
 * `skills` registry simply never mounts it.
 */

import type { Context } from '@deepseek-ai/cordis'

export const HANDOFF_SKILL_NAME = 'context-redline-handoff'

export const HANDOFF_SKILL_DESCRIPTION = 'Build a copy-paste Context Redline handoff card from the current conversation: first task, stable goal, acceptance criteria, and execution discipline with milestone gates.'

export const HANDOFF_SKILL_WHEN_TO_USE = 'Use when a conversation is long or drifting, when the user asks how to continue without losing the goal, or before opening a fresh anchored conversation with Context Redline.'

export const HANDOFF_SKILL_CONTENT = `# 上下文交接卡

当用户说“接下来怎么继续 / 别跑偏 / 帮我把任务拆成目标、验收、纪律 / 我要开新会话”时，用这个技能把当前对话压成一张可直接粘贴到「新建带规则的对话」的卡片。

## 先读再写

1. 读当前对话，找出：
   - 最初的目标（不是最近一句话）；
   - 已经验收 / 已完成的；
   - 还没做的、当前阻塞；
   - 用户给过的硬约束（路径、技术栈、不能做的事、合规边界）；
   - 完成标志（可执行的命令、文件、可观察结果）。
2. 如果用户指的是另一个 DSH 会话：让对方先打开那个会话再执行，或把目标、最近结论、当前阻塞贴进来。不要猜。
3. 判断交接方式：
   - 新会话不需要旧上下文 → 用「新建带规则的对话」，输出四段；
   - 新会话必须带旧证据 → 建议「开启普通新会话」迁移，四段仍可用（后三段填入运行时规则锚点），并在四段外说明保留 / 删除哪些条目。

## 输出格式（只输出这四段）

### 首条任务

\`\`\`text
（新会话第一句话：只做当前这一步，写清先读哪个文件 / 先跑哪条命令）
\`\`\`

### 目标

\`\`\`text
（整个任务完成时才算达成的稳定目标；不要把它缩成当前里程碑）
\`\`\`

### 验收标准

\`\`\`text
（可逐条检查：命令 / 文件 / 输出 / 用户验收；有阶段时写“每个里程碑由用户验收后才进入下一阶段”）
\`\`\`

### 执行纪律

\`\`\`text
（出错怎么处理、目标何时可变、每轮先读什么、证据要求、范围边界）
\`\`\`

用户如果只说“三段”，仍保留四个标签：把「首条任务」和「目标」一起当作“任务目标”给出，方便直接粘贴。

## 四段怎么写

- **首条任务**：一个会话能完成的具体动作；若有计划文件，第一句就是“先读 <绝对路径>”；不要写“完成整个项目”。
- **目标**：用户最初要的结果，不是当前步骤；写清最终交付物和项目级成功判据。
- **验收标准**：每条都能执行或观察；区分“已确认 / 未验证”；禁止“体验良好”这类不可验收描述。
- **执行纪律**：至少包含——
  1. 出错时修正、复验、继续原目标；不得因报错 / 依赖失败改目标；
  2. 每个里程碑结束必须停下汇报证据，用户明确“通过”后才进入下一个；
  3. 每轮开始先读计划文件，完成一项就更新状态与证据；
  4. 不自行扩范围、不新增需求；计划变更先说明并等用户确认；
  5. 证据必须是真实命令输出 / 文件 / 截图，不能只写“已完成”；
  6. 不复制未授权素材、不泄露密钥 / 个人信息。

## 质量检查

- 新会话的模型只看这四段，能不能知道第一件事做什么？
- 每条验收能不能被第三个人独立检查？
- 纪律有没有覆盖这次对话已经出现过的失败模式（跑偏、跳验收、假完成、上下文丢失）？
- 路径、命令、版本是否真实来自对话或用户？不确定就标“未验证”，不要编。
- 四段各控制在 2000 字符内（运行时规则每请求可见，越短越稳）。

## 最后一行

粘贴到「新建带规则的对话」的四个字段：首条任务 / 目标 / 验收标准 / 执行纪律。
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
