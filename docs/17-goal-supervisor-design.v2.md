# 长任务督导（Goal Supervisor）设计稿 v2

> 状态：讨论稿（未实现、未提交、未发布）。本版按 2026-11-24 评审意见修订。

## 0. 修订记录（v1 → v2）

**接受并修改：**
- P0-1 业务代码提交：DONE 时把 scope 内的业务改动与台账一起提交、在**真实提交**上打 tag；越界校验改为「相对上一个检查点的 diff」，不再扫全量工作区；BLOCKED 时保存补丁、清理工作区后单独提交台账。
- P0-2 评估触发：改为「全部必选探针 pass 且（scope 指纹变化 或 子会话声明完成）」。
- P0-3 探针命令：插件可执行受控验证命令（创建时确认清单、超时、禁网、隔离环境），不再只允许 rg/ls。
- P0-4 并行：默认 1（串行）；并行必须物理隔离（每个子任务独立 worktree+分支），并改为**独立结算**，取消整批打回。
- P1 状态源：`tasks.json` 为机器唯一状态源，`state.jsonl` 追加审计，`TASKS.md` 由插件单向渲染；人的解阻/改范围走界面按钮。
- P1 锚点：每侧 2KB，按优先级截断，硬规则/停止条件/scope 永不截断。
- P1 做法签名：机器计算（改动文件集合 + 归一化命令序列 + 失败探针向量）。
- P1 范围变更：新增 ScopeChangeRequest 通道（三审+裁决或人工批准）。
- P1 镜像：只在 DONE/BLOCKED/里程碑推送，正文折叠、失败退避。
- P1 笔误修正。

**保留意见：**
- P1 Epoch 轮转不做默认：朋友 5144 轮是单会话跑完，主会话保持轻才是主机制；Epoch 作为压缩异常时的**可选兜底**，由用户决定。

## 1. 目标与非目标

**目标**：一个会话长时间运行（目标数千轮）仍持续按同一目标推进，不漂移、不提前收工、不越界改动，产出可被外部证据验收。

**非目标**：不替代代码评审；不与 GitLab/GitHub 双向同步；不承诺具体倍数；不改变模型能力。

## 2. 角色

- **工作台**：会话 A 的「上下文批改」面板，看/改上下文、出交接卡、创建督导会话、查看 run 状态。
- **督导**：会话 B（同一插件、同一会话），冻结目标卡、维护任务表、每轮注入锚点、收尾跑探针、任务边界评估、维持 goal、拒绝提前收工、记检查点。
- **执行者**：B 派出的子会话，实际读写代码、跑命令、产出证据。

督导与工作台都在 `dsh-context-redline` 内，不拆插件。

## 3. 五件套

1. **范围冻结**：每条任务声明允许改动的路径/glob。
2. **每轮锚点**：首尾各一段 ≤2KB 的不变量，状态驱动、每轮刷新。
3. **外部探针**：文件/命令/grep/数值/扫描，插件执行，三态（pass/fail/unknown）。
4. **goal 门禁**：插件创建并持有 goal，未全 DONE 拒绝完成、拒绝改目标。
5. **状态外置 + 检查点**：任务表、证据、审查落盘；每个 DONE 提交并打 tag。

## 4. 记录目录与状态源

```
<workspace>/docs/guard/<run-id>/
  tasks.json               # 机器唯一状态源（插件读写）
  state.jsonl              # 追加式事件流（状态变更、评估、探针、提交）
  TASKS.md                 # 由 tasks.json 单向渲染，供人读
  run.json                 # run 元信息：会话 id、goal hash、并行度、阶段、镜像状态
  tasks/<TASK-ID>/notes.md      # 主会话写的说明/审查（白名单内）
  tasks/<TASK-ID>/evidence/     # 插件写的探针输出、命令输出、补丁
  probes/<TASK-ID>.json         # 探针定义（含命令白名单）
  requests/                     # ScopeChangeRequest 等请求
  review/<reviewer>-roundN.md
  review/adjudication.md
  final-regression/
  logs/                    # 大日志，gitignore
```

- `run-id` = `<YYYYMMDD>-<主题>`（主题取目标首行、去空格斜杠；同日重复加 `-2`），插件生成。
- **单一状态源**：机器只信 `tasks.json`；`TASKS.md` 永不被解析为状态。
- 人不手改上述文件；解阻、改范围、注入新方法通过界面按钮写入 `tasks.json` 并记 `state.jsonl`。
- `docs/guard/` 进 git；`logs/` 通过 `.gitignore` 或 `.git/info/exclude` 忽略。

## 5. 任务模型（tasks.json）

每条任务字段：

- `id`：`T1`、`DOC-78-01` 形式，字母开头、唯一；
- `title`：非空；
- `status`：`TODO` / `IN_PROGRESS` / `DONE` / `BLOCKED`；
- `scope`：路径或 glob 列表（范围冻结）；
- `depends_on`：依赖任务 id 列表；
- `acceptance`：文字验收（可多条）；
- `probes`：探针 id 列表，分 `required` 与 `optional`；
- `evidence`：证据链接（文件、命令输出 id、提交、审查记录）；
- `attempts`：数组，每条含时间、做法签名、方法枚举、结果、探针状态向量；
- `blocked`：`reason` + `next`（BLOCKED 必填）；
- `base_commit`：该任务开始时的提交（越界比对基线）。

状态机：`TODO → IN_PROGRESS → DONE | BLOCKED`；`BLOCKED → TODO` 由人确认或补充新方法；`DONE` 只由检查点回退改变。

## 6. 探针

类型：

- `file_exists(path)`；
- `file_contains(path, pattern)`；
- `grep(pattern, paths, expect)`；
- `number_gte(source, threshold)`；
- `command(cmd, args, timeoutMs, expectExit=0)`；
- `scan(kind)`：doclinks / todo-tbd / inline-code-path 等。

**命令探针的边界**：
- 由**插件**执行，不由模型执行；主会话仍禁止直接跑构建/测试（交子会话）；
- 命令清单在创建第①步由用户确认（或从项目配置提取后经确认），写入 `probes/<TASK-ID>.json`；
- 执行环境：任务的工作目录、超时（默认 120s）、**禁网**（代理指向不可用地址并拒绝显式联网命令）、继承最小环境变量；
- 输出原文写入 `evidence/`，并记 SHA-256 与退出码；评估器只读摘要与哈希，不读全量输出；
- 命令不得修改 tracked 源文件；构建产物走 `.gitignore`。

结果三态：`pass` / `fail` / `unknown`；**unknown 永不算 pass**。探针每轮可跑（便宜）；模型评估只在任务边界跑（贵）。

## 7. 执行循环

**每轮**：
1. 注入首尾锚点；
2. 模型干活（派子会话；主会话只规划/分派/审查）；
3. 收尾：跑当前任务探针 → 更新 `tasks.json` 与 `state.jsonl` → 写 evidence；
4. **任务边界判定**（见下）→ 通过则 DONE + 提交 + tag；不通过记尝试；满足 BLOCKED 条件则 BLOCKED。

**评估器触发条件**（修 P0-2）：
- 当前任务全部 `required` 探针为 pass；**且**
- 满足其一：`scope` 内文件指纹（内容哈希集合）较上次评估变化；或子会话/主会话在 `notes.md` 写入完成声明（`## 完成声明` 段）；
- 避免：只过部分探针就评估、探针集合不变导致永不评估。

**并行**（默认 1）：
- 并行前提：scope 不相交、无依赖、项目有 git；
- 隔离：每个子任务独立分支 + 独立 worktree（`<workspace>/.guard/worktrees/<run-id>/<task-id>`，经 `.git/info/exclude` 忽略）；
- 结算：**独立结算**——通过的合入 run 分支并 DONE；失败的留在自己 worktree 重试或 BLOCKED；不再整批打回；
- 批次里程碑仍做一次汇合审查（3 审+裁决）。

**串行→并行闸门**：scope 可机读；依赖可建图；串行 5 个完整批次无越界/改目标事故；单任务首过率 ≥80%；独立结算验证过；回滚验证过。满足后先 2 并行试跑。

## 8. 锚点

- 位置：`systemPrompt.context`，head `order 90`、tail `order 900`，`required: true`（压缩后重贴）；
- 预算：**每侧 ≤2KB**（约 600–1000 tokens），超预算按优先级截断并记事件；
- 优先级（从高到低）：硬规则 3 条 → 停止条件 → 当前任务 id 与 scope → 本任务验收 → 下一步动作 → 目标 hash → 目标首行（描述性文字，可截断）；
- 内容由插件从 `tasks.json` 实时生成，每轮刷新。

## 9. 启动时序（两段式）

**对话框阶段（A）**：
1. 校验目标卡（目标/验收/纪律/任务清单）与**探针命令清单**确认；任一非法则按钮禁用；
2. 生成 run-id，创建记录目录骨架与 `probes/*.json`（实时显示路径与已写文件数）；失败停在②，可重试，不建会话。

成功后创建会话 B 并立即切过去，对话框关闭。

**B 内启动阶段**（Agent 挂载回调）：
1. 写 `run.json.sessionId`；
2. `goals.create(agent, { objective })`；
3. 注入锚点、挂守卫、绑定探针；
4. 发送首条消息（先读 `tasks.json` / `TASKS.md`，从第一条任务开始）。

B 内状态条：目标已创建 / 锚点已注入 / 守卫已挂载 / 首条消息已发送；失败停在该步并可重试，`run.json` 记 `setup-failed` 与原因；启动期间输入框禁用。

## 10. 重试与 BLOCKED

- 允许不断换方法（十种就试十种）；不设“总尝试 3 次”；
- **做法签名**（插件计算）：`sha256(排序后的改动文件集合 + 归一化命令序列 + 排序后的失败探针 id)`；另由评估器从固定枚举打 `method` 标签（配置/重装/重写/探针/其它）；
- 无进展判定：同一做法签名重复 3 次且探针状态向量无变化；或模型声明方法空间用尽且评估器同意；
- 安全上限：单任务总尝试 50 次，触发即 BLOCKED；
- BLOCKED 必须写：试过的方法与证据、卡点、剩余候选；同时 `goals.block`；
- BLOCKED 不影响其他会话与任务；依赖它的任务保持 TODO。

## 11. 审阅分档

- 每个任务收尾：1 个评估器 + 探针，追加到 `notes.md`；
- 里程碑 / 每 N 个 DONE：3 个审阅者 + 1 裁决，落 `review/`；
- BLOCKED：裁决（带尝试记录）；
- 最终验收：3 审 + 裁决 + `final-regression/` 扫描。

裁决规则：全票 pass → DONE；分歧 → 裁决给最终判定并记录；`insufficient` → 保持未完成；返回不可解析 → 重问一次，仍失败按无进展计。

## 12. 严格模式与白名单

- **分阶段**：M1–M2 为 `warn-only`（只记录越界/违规，打回由评估器决定）；M3 起可开 `enforce`（硬拦截、打回、BLOCKED）；
- 主会话可写：`docs/guard/<run-id>/` 下的 `notes.md`、`review/*.md`、`requests/*`；其余业务写操作拒绝；
- 主会话可执行：无（只读状态用 read/glob/grep）；构建/测试命令交子会话或由插件探针执行；
- **越界校验**：取 `base_commit..当前` 的 diff（含未跟踪文件，忽略 gitignore 与 `docs/guard/<run-id>/`），与当前任务 scope 比对；越界首个即记事件，`warn-only` 下只告警，`enforce` 下 BLOCKED；
- **范围变更通道（ScopeChangeRequest）**：子会话或主会话写 `requests/scope-<task>-<n>.json`（原因、拟新增路径、证据），**不动手改越界文件**；插件暂停任务 → 三审+裁决或人工弹窗 → 批准后更新 `tasks.json.scope` 并记事件；拒绝则继续或 BLOCKED。

## 13. 检查点与回滚

**DONE**（v1，共享工作区、不切分支）：
1. 校验 `base_commit..现在` 的改动 ⊆ scope ∪ `docs/guard/<run-id>/`；
2. 只 `git add` 这些路径与台账，`git commit --only -- <paths>`（提交信息 `guard(<run-id>): <task> DONE`）；
3. 在**该提交**上打 tag `guard/<run-id>/<task>`；
4. 更新 `tasks.json`、`state.jsonl`。

**BLOCKED**：
1. `git diff`（含未跟踪文件）保存为 `tasks/<ID>/evidence/blocked-<n>.patch`；
2. `git stash push -u` 或还原工作区（可配置）；
3. 单独提交台账与补丁；
4. 不自动回滚；界面提示「可回退到最近的检查点」，由人确认。

**v1 不做自动回滚**；共享工作区里的回滚会影响其他会话，界面必须写明。需要真正隔离时启用 M3+ 的**独立 worktree 模式**（B 的 cwd 指向 run worktree）。

**Epoch（可选兜底，默认关）**：压缩次数或上下文占用超阈值、或连续多轮出现“忘记任务”信号时，提示用户「冷启动一个 Epoch」：新会话只带 `tasks.json` + 里程碑摘要 + 锚点继续；旧会话归档。

## 14. GitLab / GitHub 镜像

- 探测：`git remote get-url origin` 得 host；在 PATH 与常见目录（`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/bin`）找 `gh`/`glab`；只对该 host 校验登录；
- 行为：一个 run 一个 issue；只在 **DONE / BLOCKED / 里程碑** 追加评论（忽略 IN_PROGRESS）；正文放目标卡与记录目录，任务清单折叠已完成批次；
- 体积：issue 正文 ≤60k 字符，超长截断并链接记录目录；
- 失败：退避重试，记 `run.json.mirror`（`disabled` / `lastError`）；不阻塞、不回写、不存 token。

## 15. 界面

- 创建对话框：两步（校验目标卡 + 确认探针命令、生成记录目录），第二步实时显示路径与文件数；
- 会话 B：启动状态条 + 失败重试；守卫卡显示当前任务、探针结果、最近评估、BLOCKED 原因与已试方法；
- 上下文批改面板：run 列表与状态；「解阻 / 批准范围变更 / 回退到检查点」按钮。

## 16. 失败与恢复语义

- 探针 unknown 不算通过；评估器失败按 `insufficient`；
- 创建失败：`run.json` 标 `aborted`/`setup-failed`，不留“看起来正常”的空 run；
- 幂等：重试不重复建目录、不重复建 goal；
- 冷恢复以 `tasks.json` + `state.jsonl` 为准，会话日志不作状态源。

## 17. 验收指标与实验

指标：每 10 轮无谓停顿次数；探针首过率；越界改动次数（warn-only 阶段也统计）；回滚/打回次数；单任务成本（评估调用与 token）；同一任务连续无进展轮数。

实验：2–3 个真实任务，对比「交接卡（现状）」与「督导最小版」；督导版需 ≥3 项指标明显更好且无越界事故，才继续放大并行与 enforce。

## 18. 安全与隐私

- 不读密钥；日志脱敏（2FA/助记词/token）；
- CLI 鉴权交给 gh/glab；
- 严格模式默认 `warn-only`，`enforce` 按 run 开启。

## 19. 里程碑

1. **M1 记录与状态**：tasks.json / state.jsonl / TASKS.md 渲染、目录骨架、创建对话框两步进度、探针命令确认；
2. **M2 循环**：锚点、每轮探针、评估触发、goal 集成、拒绝收工；
3. **M3 严格模式与工单**：warn-only、scope diff、ScopeChangeRequest、enforce 开关；
4. **M4 检查点与回退**：DONE 提交+tag、BLOCKED 补丁、手动回退、独立 worktree 模式；
5. **M5 并行与镜像**：并行 worktree、独立结算、gh/glab 镜像、Epoch 兜底。

## 20. 待确认

- `enforce` 从 M3 起默认开启，还是保持默认 `warn-only`、由用户逐 run 切换（建议后者）；
- 独立 worktree 模式默认关闭（建议），仅并行与需要隔离回退时启用；
- 提交信息与 tag 命名是否采用 `guard(<run-id>): <task>` / `guard/<run-id>/<task>`。
