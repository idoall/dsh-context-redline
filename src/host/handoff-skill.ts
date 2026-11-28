/**
 * Runtime skill: turn the current conversation into the four copy-paste fields
 * of an anchored conversation. The skill is optional — a harness without the
 * `skills` registry simply never mounts it.
 */

import type { Context } from '@deepseek-ai/cordis'

export const HANDOFF_SKILL_NAME = 'context-redline-handoff'

export const HANDOFF_SKILL_DESCRIPTION = 'Build both Context Redline handoff shapes from the current conversation: migration fields (first task + per-request runtime rule) and anchored fields (first task, goal, acceptance criteria, discipline), plus the optional supervised-run package every time (four-column task table with required scope, probe commands, and an explicit recommendation with a reason for every run option: evaluator model and reasoning effort, executor and evaluator fallback models, the visual-evidence toggle and its multimodal witness model, strict enforce mode, and isolated worktree) so the user can decide whether to enable it, with mandatory task decomposition and review gates.'

export const HANDOFF_SKILL_WHEN_TO_USE = 'Use when a conversation is long or drifting, when the user asks how to continue without losing the goal, before opening a fresh anchored conversation with Context Redline, or when the user asks about the supervised run, its task table, its probes, or its evaluator model.'

export const HANDOFF_SKILL_CONTENT = `# 上下文交接卡

当用户说“接下来怎么继续 / 别跑偏 / 帮我把任务拆成目标、验收、纪律 / 我要开新会话”时，用这个技能把当前对话压成一张可直接粘贴的交接卡。

## 输出铁律（不可省略）

- **完整交接卡必须直接输出在当前聊天回复的代码块中**（逐段可直接复制粘贴，包括情况 A、情况 B 的四个字段、以及督导运行的 4 列任务表、探针和选项建议）。
- **禁止把完整版写入外部文件而在回复里只给「精简版 / 摘要 / 文件链接」**；除非用户明确要求另存文件，否则**不要为了交接卡调用 \`write\` 落盘**。
- **工作区一致**：任务表 scope、探针命令和交付物，必须都是**即将发起新会话的那个工作区**里的相对路径；探针会在这个目录里执行。目标在另一个仓库 / 目录时，先在交接卡最上面写一句「先切到 \`<那个目录>\` 再开新会话」，并且只给那个仓库内的任务；不要在 A 仓的任务表里写 B 仓的绝对路径，也不要让子会话自己 \`git worktree add\` 到外部目录。
- **编号不冲突**：首条任务若说「T1–T5 已完成 / 不要重跑」，新任务表就不要又从 T1 开始（换个前缀如 M1、P1，或从 T6 续编），否则锚点的「当前任务」会和首条任务互相打架。

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

### 督导运行（可选 · 要勾选就先贴这一段）

每次都给这一段，让用户自己决定要不要勾选；不勾选就直接忽略。督导运行会让插件自己推进：每个任务通过后**它自己提交、打 tag**，没有「只看不改」的档位。贴之前先确认：你愿意让这个仓库里出现 \`guard(<runId>): <任务> DONE\` 的提交和 \`guard/<runId>/<任务>\` 的 tag。有未提交改动先 \`git stash\`。

#### 任务表（每行四段；scope 必填，代码块内不要放标题行）

\`\`\`text
T1 | 实测 1.6.82 基线与云端接入面 | evidence/baseline/m5/ 有文件；报告含版本原文与 sha256 | evidence/baseline/,docs/x9-1.6.82-baseline.md
T2 | 静态差异与关键函数定位 | docs/x9-1.6.82-diff.md 存在且含旧→新地址映射 | docs/,evidence/dynamic/
\`\`\`

#### 探针（一行一条：任务ID | 命令，代码块内不要放标题行）

\`\`\`text
T1 | test -d evidence/baseline/m5
T2 | grep -q 1.6.82 docs/x9-1.6.82-diff.md
\`\`\`

#### 选项建议（七项都要给结论；每项附一句基于当前仓库/任务的理由）

\`\`\`text
- 独立评估模型：跟随主会话 / 另选跨 provider 文本模型（理由：……）｜推理等级：使用模型默认值 / High / Max（理由：……）
- 评估回退模型：不设置回退 / 另选跨 provider 文本模型（理由：……）｜等级：使用模型默认值 / High
- 对话执行模型：保持默认 / 另选（理由：……）｜推理等级：使用模型默认值 / High / XHigh（理由：……）
- 执行回退模型：不设置回退 / 另选跨 provider 文本模型（理由：……）｜等级：使用模型默认值 / High
- 启用视觉取证：不勾选 / 勾选并指定多模态视觉模型（理由：……）
- 严格模式：建议勾选 / 建议不勾选（理由：……）
- 独立 worktree：建议勾选 / 建议不勾选（理由：……）
\`\`\`

- 每行格式：\`任务ID | 标题 | 验收（分号分隔）| scope（逗号分隔的路径）[ | 依赖（可选第 5 列，逗号分隔；串行模式省略时默认按顺序依赖上一条，用 \`-\` 表示无依赖）]\`。**scope 必填**，它是「这个任务允许改哪些文件」的白名单：写漏了，任务一碰别的文件就被判越界；宁可给一个目录，也不要留空。
- 督导回合边界：「## 完成声明」**只能由主会话审查子会话产物后亲自写入** \`tasks/<ID>/notes.md\`，**禁止让子会话代写**（否则督导会在主会话审查前就触发探针/评估并提前打检查点）；主会话写入后必须**立刻结束本回合**（不要在同一回合派下一个任务），让督导跑探针、做独立评估、打检查点并切换锚点。
- 验收必须“离开这段对话也能判”：督导的评估器只看冻结目标卡、探针结果、scope 内的 diff 和 \`notes.md\`，看不到完整历史。所以每条验收要写成文件在不在 / 命令退出码 / 报告含哪个字段；不要写“体验良好”“按预期完成”。
- 探针按空白切分、**不经过 shell**：不要写引号、管道、重定向；要带空格就先包一个脚本。\`grep -q 关键字 路径\` 是最稳的写法。
- **必须明确给出七项选项建议与理由**，不要只贴任务表和探针让用户盲选；「不设置回退」「不勾选」也是结论，同样要写理由。各模型下拉的推理等级默认「使用模型默认值」，留空可以，但要在建议里写明为什么这个仓库可以留空：
  - **独立评估模型**：默认「跟随主会话」就够。主会话是 CLI 桥接型 provider（\`antigravity\` 等，对无工具的 JSON 请求容易返回空文本）→ 必须另选文本模型，否则它只会反复 \`insufficient\`。**不要编造 provider/model 名称**，用角色描述（如“另一个 provider 的文本模型”），具体由用户在界面里选。推理等级：评估是判定不是探索，\`high\` 通常够；**评估调用用模型自身的输出预算（与正常对话一致），但 \`max\` 的推理仍可能吃满它并撞上模型自身上限（\`MAX_TOKENS\`），大任务上建议 \`high\`；真要用 max 就先配好评估回退**；不要给 \`low\`。
  - **评估回退模型**：评估主模型返回空文本 / 超时 / 限流时切换；留空则评估失败按 \`insufficient\` 处理（任务卡住，但不会误判通过）。建议至少给一个跨 provider 文本模型——只有评估有回退，run 才不会因为一次空回复整夜停住。
  - **对话执行模型**：新会话与它派出的子会话真正干活的那个模型；想换风格或能力就选在这里，不要塞进「执行回退」（回退只在故障时接管）。CLI 桥接型 provider（\`antigravity\` 等）可以做执行，不要做评估；但它会把子代理留在自己的 CLI 里——DSH 的编队页和督导的「派子会话」都看不到委派，所以默认用 DSH 原生模型做执行，视觉/画面任务再显式派给 agy 子代理。
  - **执行回退模型**：主执行模型不可用时自动切换；留空只提示、不切换（运行停在阻塞态）。主模型是免费池 / 限流不稳 / 多会话共享额度 → 给一个**跨 provider** 的文本模型；官方付费直连且稳定 → 不设也行。同一 provider 的额度、鉴权类错误切了也没用，所以回退要跨 provider 才有意义。
  - **启用视觉取证**：只在验收含截图 / UI / 渲染 / 画面类证据时勾。插件对「验收需要视觉、但没拿到 witness」是**确定性否决**（探针和文本评估都过了也判 \`insufficient\`）；纯后端 / 文档任务勾了只会变慢甚至卡住 → 不勾。勾选后给 witness 选**声明支持图片输入**的多模态模型；留空跟随评估模型，若评估模型是纯文本会得到 \`UNSUPPORTED_CONTENT\`。只有本任务新增 / 修改的图片会送去观察（最多 5 张），witness 只列问题不给结论，裁决仍由文本评估器做。
  - **严格模式**：拒绝主会话的越界写和一切 shell 类工具（只能派子会话干活）。各任务 scope 明确、需要硬隔离防跑偏时 → 建议勾选；首次试跑、探索性任务或 scope 仍粗略时 → 建议先不勾选，看清提交后再开。
  - **独立 worktree**：在当前工作区的 \`.guard/worktrees/<runId>\` 建隔离检出（分支 \`guard/<runId>\`，该目录本地忽略、不会进提交），**不新建 DSH 工作区**；提交**不会自动合回**，完成后需手动 merge。检测到 git 仓库时界面已默认勾选；当前工作区有大量无关未提交改动、或希望主检出分支保持不动时 → 保持勾选；仓库干净或希望提交直接落在当前分支时 → 取消。
- **运行目录**：任务表的 scope 与探针都以**运行目录**（发起会话的那个工作区；勾选独立 worktree 时是它的 \`.guard/worktrees/<runId>\`）为根，探针会在这个目录里执行。任务要改另一个仓库，就先切到那个仓库开新会话，不要指望探针跨仓。
- 一个任务一个里程碑；任务越大越容易因为「顺手改了 scope 外的文件」而被阻塞。

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
- 任务清单的每条验收，评估器只看目标卡、当前任务、探针结果与 scope 内产出就能判定吗？判不了就改成命令 / 文件 / 可观察结果。
- 验收 / 纪律有没有把“主会话审查”误写成“用户逐任务批准”？逐任务用户确认会把 6 个任务变成 6 次打断。
- 有没有一条路径会让一个会话连续做完多个里程碑？有就判不合格。
- UI 改动有没有有头 UAT 与复测证据；非 UI 改动有没有写“无需 UAT”的理由？
- 路径、命令、版本是否真实来自对话或用户？不确定就标“未验证”，不要编。
- 督导运行的任务表给了 scope 吗？每个任务的 scope 覆盖它真要改的文件了吗（给目录比留空安全）？是否把「对话执行模型」「独立评估模型（含推理等级）」「执行回退模型」「评估回退模型」「启用视觉取证」「严格模式」「独立 worktree」六项都给了结论并写了理由？
- 每个 scope、每条探针，都能在「发起新会话的那个工作区」里直接执行吗？任务表里有没有混进另一个仓库的路径？
- 全部代码块是否完整直接输出在当前聊天回复里（没有省略成摘要或外链到外部文件）？
- 情况 A 的锚点控制在 2000 字符内；情况 B 每段也尽量控制在 2000 字符内（运行时规则每请求可见，越短越稳）。

## 最后一行

- 情况 A：粘贴「首条任务」+「锚点」，锚点模式选「每轮运行时规则」；最终发送全文由插件拼接。
- 情况 B：把四个字段粘贴到「新建带规则的对话」；不启用督导运行时直接忽略督导运行段。
- 督导运行：勾选「督导运行」，把「任务表」贴进任务表输入框、「探针」贴进探针输入框，并参照「选项建议」把七项定下来：执行模型与等级、评估模型与等级、执行/评估回退模型、是否启用视觉取证（勾了要选多模态 witness）、严格模式、独立 worktree。
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
