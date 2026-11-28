# 长任务督导（Goal Supervisor）设计稿 v3.1（定稿候选）

> 状态：M1–M5 已实现并通过测试（未提交、未发布，见 §21「实现状态」）。本版在 v3 基础上补齐第二轮评审的 5 处实现细节、2 处加固与 2 项待确认；v2 原文保存在同目录的 `17-goal-supervisor-design.v2.md`。

## 0. 修订记录（v3 → v3.1）

- 执行循环补上 heavy 探针的触发步骤（必选 light 全过或新增完成声明时加锁执行）。
- run-id 恢复日期前缀，最终格式 `<YYYYMMDD>-<清洗后主题>`，主题截断 40 字符、总长 ≤50。
- `baseline_dirty` 改为 `Record<filepath, sha256 | 'deleted'>`，越界校验比对当前哈希。
- 并行合入明确为**单任务串行合入队列**（merge queue），逐任务回归、零连坐。
- 轻量进展评估放行后重置计数；同一签名最多豁免 2 次，第 3 次直接 BLOCKED。
- 环境变量剔除规则扩展为大小写不敏感正则（TOKEN/KEY/SECRET/PASS/CREDENTIAL/COOKIE/DATABASE_URL）。
- DONE 提交失败时同步 `git reset -- <路径>` 复位 Index。
- 两项待确认已拍板：进展评估三态口径；合入回归 = 任务必选探针 + 项目级冒烟命令（可缺省退化）。

## 0.1 上一轮修订（v2 → v3）

**接受并修改：**
- 提交时序：DONE 改为「先把台账写成 DONE（记 tag 引用名，不记 SHA）→ 一并提交业务改动与台账 → 在提交上打 tag」；提交失败则台账回滚，不留半截状态。
- 做法签名：加入**失败输出指纹**（错误类型、首个失败断言行、失败用例 id）；同一签名 3 连击**不再直接 BLOCKED**，先触发一次轻量评估，确认「同一思路死循环或 diff 往复」才 BLOCKED。
- 并行结算：子任务 worktree **禁止写台账**；合入前 rebase 到最新 run 分支并重跑必选探针；通过 staging 分支做批次回归，全绿才快进 run 分支，否则保留现场重试。
- 里程碑：**DONE 提交与 tag 前移到 M2**（否则 base_commit 不推进，M2/M3 的越界统计会失真）；M4 只保留 BLOCKED 补丁、手动回退与独立 worktree 模式。
- 完成声明：只认「上次评估之后新增」的声明（文件偏移/段哈希），避免旧声明反复触发评估。
- 探针分级：轻量探针（file/grep/number/scan）每轮跑；重量命令探针（tsc/lint/测试）只在轻量必选全过或子会话声明本轮完成时跑，且加互斥锁。
- 隔离说明：禁网是 best-effort（代理黑洞 + 命令黑名单；有 sandbox-exec/unshare 时优先用），文档如实写明限制；环境变量保留工具链 PATH，剔除 `*TOKEN*`/`*KEY*`/`*SECRET*`。
- 共享工作区：任务开始时记录 `baseline_dirty`（既有脏文件）并豁免；BLOCKED 时 stash **限定路径**，不吞别人的改动。
- 范围变更：常规路径默认「三审 + 裁决」自动审批；只有敏感目录（`.github/`、配置根、安全模块）或单任务扩范围超过 3 次才挂起等人工——夜间长跑不会被弹窗卡死。
- run-id 清洗：按 git ref 规则过滤，避免 tag 创建失败。

**维持 v2 的结论：**
- Epoch 轮转仍为默认关闭的可选兜底；主机制保持单会话 + 主会话轻量。

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

- **run-id 生成规则**：最终格式为 `<YYYYMMDD>-<清洗后主题>`。主题取目标首行 → 只保留汉字、字母、数字、`-`、`_`，其余字符替换为 `-` → 连续 `-` 折叠 → 去掉首尾 `-` 与 `.` → 禁止 `..`、`.lock` 结尾、以 `-` 开头 → 主题截断到 40 字符 → 为空则用 `run`；总长控制在 50 字符内，同日重名加 `-2`。任务 id 进入 tag 前做同样清洗。这样 `git tag guard/<run-id>/<task>` 不会因 `: ? * [ ~ ^` 等字符失败。
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
- `probes`：探针 id 列表，分 `required` 与 `optional`，并标 `light`/`heavy`；
- `evidence`：证据链接（文件、命令输出 id、提交、审查记录）；
- `attempts`：数组，每条含时间、做法签名、方法枚举、结果、失败指纹；
- `blocked`：`reason` + `next`（BLOCKED 必填）；
- `base_commit`：该任务开始时的提交（越界比对基线）；
- `baseline_dirty`：任务开始时已存在的脏文件快照，结构为 `Record<filepath, content_sha256 | 'deleted'>`（豁免与二次篡改识别用）；
- `checkpoint_ref`：DONE 时写入的 tag 引用名（不写 SHA，避免循环依赖）；
- `last_eval_at` / `last_eval_offset`：上次评估的时间与 notes.md 偏移（完成声明去重）。

状态机：`TODO → IN_PROGRESS → DONE | BLOCKED`；`BLOCKED → TODO` 由人确认或补充新方法；`DONE` 只由检查点回退改变。

## 6. 探针

类型：

- `file_exists(path)`；
- `file_contains(path, pattern)`；
- `grep(pattern, paths, expect)`；
- `number_gte(source, threshold)`；
- `command(cmd, args, timeoutMs, expectExit=0)`；
- `scan(kind)`：doclinks / todo-tbd / inline-code-path 等。

**调度分级**：
- `light`（file/grep/number/scan）每轮收尾都跑，毫秒级；
- `heavy`（command）只在「轻量必选探针全部 pass」或「子会话声明本轮完成」时跑；同一 run 内 heavy 加互斥锁，避免并发抢构建锁；
- 默认超时 120s，可按探针配置；超时记 `unknown`。

**命令探针的边界**：
- 由**插件**执行，不由模型执行；主会话仍禁止直接跑构建/测试（交子会话）；
- 命令清单在创建第①步由用户确认（或从项目配置提取后经确认），写入 `probes/<TASK-ID>.json`；
- 执行目录：任务工作目录；环境：保留工具链 PATH（含 `/opt/homebrew/bin`、nvm/pyenv/cargo 路径），剔除大小写不敏感匹配 `/(TOKEN|KEY|SECRET|PASS|CREDENTIAL|COOKIE|DATABASE_URL)/i` 的变量；
- 禁网：设置不可用代理 + 命令黑名单（curl/wget/nc/ssh/git fetch/push 等）；有 `sandbox-exec`（macOS）或 `unshare -rn`（Linux）时优先使用，**没有时如实标注为 best-effort**；
- 输出原文写入 `evidence/`，并记 SHA-256 与退出码；评估器只读摘要与哈希；
- 命令不得修改 tracked 源文件；构建产物走 `.gitignore`。

结果三态：`pass` / `fail` / `unknown`；**unknown 永不算 pass**。

## 7. 执行循环

**每轮**：
1. 注入首尾锚点；
2. 模型干活（派子会话；主会话只规划/分派/审查）；
3. 收尾：跑 `light` 探针 → 若必选 `light` 全过或检测到新增完成声明，加互斥锁跑 `heavy` 探针 → 更新 `tasks.json` 与 `state.jsonl` 并写 evidence；
4. 任务边界判定 → 通过则 DONE + 提交 + tag；不通过记尝试；满足 BLOCKED 条件则 BLOCKED。

**评估器触发条件**：
- 当前任务全部 `required` 探针为 pass；**且**
- 满足其一：`scope` 内文件指纹（内容哈希集合）较上次评估变化；或 **上次评估之后新增**了完成声明（用 `last_eval_offset` 判断 `notes.md` 尾部新增段，旧声明不再触发）；
- 避免：只过部分探针就评估、旧声明反复触发、探针集合不变导致永不评估。

**评估调用预算**：单次调用 60s，**每次重试各自计时**（旧实现两次重试共用一个 30s 信号，第一次超时后第二次必然立刻失败）；超时在卡片上如实写成「调用超时（60s）」，不再把宿主的 `Request was aborted` 原样透出；传输错与超时同样重试一次，仍失败才记 `eval.unavailable`（不消耗 attempts、不推进游标）。

**重试期评估**：同一做法签名连续 3 次命中时，触发一次轻量「进展评估」（只读尝试记录、diff 摘要与失败指纹，1 次调用）；它确认「同一思路死循环或 diff 往复」才转 BLOCKED。

**并行**（默认 1）：
- 前提：scope 不相交、无依赖、项目有 git；
- 隔离：每个子任务独立分支 + 独立 worktree（`<workspace>/.guard/worktrees/<run-id>/<task-id>`，经 `.git/info/exclude` 忽略）；
- **台账禁止**：子任务 worktree 不得修改 `docs/guard/`；台账只由主工作区的插件维护；
- 合入流程（**单任务串行合入队列**）：子任务通过 → 拿合入锁 → rebase 到最新 run HEAD → 在子 worktree 重跑必选探针 → 通过后以「最新 run HEAD + 当前任务」形成 staging 快照 → 跑该任务必选探针 + 项目级冒烟命令（创建 run 时可配置，缺省则退化为仅任务探针）→ 全绿才快进 run 分支并写台账 DONE；红则留在子分支现场重试或 BLOCKED，不动 run 分支，也不影响其他已完成任务；
- 后完成的子任务自动基于更新后的 run HEAD 重新 rebase 与验证；
- 独立结算：不再整批打回；
- 并行批次结束时做一次汇合审查（3 审 + 裁决）。

**串行→并行闸门**：scope 可机读；依赖可建图；串行 5 个完整批次无越界/改目标事故；单任务首过率 ≥80%；合入回归验证过；回滚验证过。满足后先 2 并行试跑。

## 8. 锚点

- 位置：`systemPrompt.context`，head `order 90`、tail `order 900`，`required: true`（压缩后重贴）；
- 预算：**每侧 ≤2KB**（约 600–1000 tokens），超预算按优先级截断并记事件；
- 优先级（从高到低）：硬规则 3 条 → 停止条件 → 当前任务 id 与 scope → 本任务验收 → 下一步动作 → 目标 hash → 目标首行（描述性文字，可截断）；
- **运行目录**：固定输出一行 `运行目录：<cwd>`（路径超过 120 B 截断），硬规则同步声明「所有写入与命令只限运行目录（勿跨工作区施工、勿自建外部 worktree，只读参考可以读）」。探针与任务 scope 都以这个目录为根；锚点不写这一行时，模型只能从账本反推运行根（2026-11-26 真机：一个写错工作区的交接卡让首回合空转 29 步、58 次只读调用，还去翻插件源码）。
- 内容由插件从 `tasks.json` 实时生成，每轮刷新。

## 9. 启动时序（两段式）

**对话框阶段（A）**：
1. 校验目标卡（目标/验收/纪律/任务清单）与**探针命令清单**确认；任一非法则按钮禁用；可选勾选「在独立 worktree 中运行」，在当前工作区建 `.guard/worktrees/<run-id>` 隔离检出与 `guard/<run-id>` 分支：该目录写进 `.git/info/exclude` 本地忽略（不入提交），且**不注册新的 DSH 工作区**——会话 header 仍指向源项目（因此在侧栏仍归属原工作区，不会掉进「未分组」），运行目录由 Host 的 `workingDirectory.set` 切到 worktree；
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
- **做法签名**（插件计算）：
  `sha256(排序后的改动文件集合 + 归一化命令序列 + 排序后的失败探针 id + 失败输出指纹)`
  失败输出指纹 = `sha256(归一化后的 stderr 前 2KB + 失败用例 id 集合 + 首个失败断言位置)`；
- **进展判定**：签名变化（尤其是失败指纹变化）即视为有进展；签名连续 3 次相同且探针状态向量无变化 → 触发轻量进展评估；
- 轻量评估判定「同一思路死循环 / diff 往复」→ BLOCKED；判定「仍在推进、只是换了写法」→ **重置连续相同计数**后继续，并把结论写入 attempts；
- 同一签名最多被轻量评估豁免 **2 次**，第 3 次命中同一签名直接 BLOCKED；
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

- **分阶段**：M1–M2 为 `warn-only`（只记录越界/违规，打回由评估器决定）；M3 起可开 `enforce`（硬拦截、打回、BLOCKED）；默认 `warn-only`，逐 run 切换，界面提供「实验达标后记住偏好」。
- 主会话可写：`docs/guard/<run-id>/` 下的 `notes.md`、`review/*.md`、`requests/*`；其余业务写操作拒绝；
- 主会话可执行：无（只读状态用 read/glob/grep）；构建/测试交子会话或由插件探针执行；
- **越界校验**：取 `base_commit..当前` 的 diff（含未跟踪文件，忽略 gitignore 与 `docs/guard/<run-id>/`），先剔除任务开始时的 `baseline_dirty` 快照，再与当前任务 scope 比对；越界首个即记事件，`warn-only` 下只告警，`enforce` 下 BLOCKED；
- **共享工作区的初始脏文件**：任务开始时把已存在的未跟踪/已修改文件记入 `baseline_dirty`，不参与本任务越界判定；这些文件若在本任务期间被改动，仍按越界处理；
- **BLOCKED 的 stash**：只 `git stash push -u -- <本任务改动路径>`，不吞其他会话或人工的新文件；无 git 时存补丁 + 快照；
- **范围变更通道（ScopeChangeRequest）**：子会话或主会话写 `requests/scope-<task>-<n>.json`（原因、拟新增路径、证据），**不动手改越界文件**；插件暂停任务 → 常规路径走三审 + 裁决自动审批；敏感路径（`.github/`、配置根、安全模块）或单任务扩范围超过 3 次才挂起等人工；批准后更新 `tasks.json.scope` 并记事件，拒绝则继续或 BLOCKED。

## 13. 检查点与回滚

**DONE（v1，共享工作区、不切分支）**：
1. 校验 `base_commit..现在` 的改动 ⊆ scope ∪ `docs/guard/<run-id>/`（剔除 `baseline_dirty`）；
2. **先写台账**：`tasks.json` 置 DONE，`checkpoint_ref` 写 `guard/<run-id>/<task>`（引用名，不写 SHA），追加 `state.jsonl`，渲染 `TASKS.md`；
3. 只 `git add -A -- <业务路径> docs/guard/<run-id>` 并 `git commit -- <这些路径>`（提交信息 `guard(<run-id>): <task> DONE`）——台账的 DONE 状态因此包含在这个提交里；
4. 在该提交上打 annotated tag `guard/<run-id>/<task>`；
5. 若提交失败：台账回滚为 IN_PROGRESS、执行 `git reset -- <相同路径>` 复位 Index，并记事件，不留下“看起来 DONE”的状态；若 tag 已存在或非法：拒绝并记录，等待人工。

**BLOCKED**：
1. `git diff`（含未跟踪文件）保存为 `tasks/<ID>/evidence/blocked-<n>.patch`；
2. `git stash push -u -- <本任务改动路径>`（可配置为保留现场不清理）；
3. 单独提交台账与补丁；
4. 不自动回滚；界面提示「可回退到最近的检查点」，由人确认。

**回滚**：`git reset --hard`/`revert` 由用户确认后执行；共享工作区里的回滚会影响其他会话，界面必须写明。需要真正隔离时启用 M4 的**独立 worktree 模式**（B 的 cwd 指向 run worktree）。

**Epoch（可选兜底，默认关）**：压缩次数或上下文占用超阈值、或连续多轮出现“忘记任务”信号时，提示用户「冷启动一个 Epoch」：新会话只带 `tasks.json` + 里程碑摘要 + 锚点继续；旧会话归档。

## 14. GitLab / GitHub 镜像

- 探测：`git remote get-url origin` 得 host；在 PATH 与常见目录（`/opt/homebrew/bin`、`/usr/local/bin`、`~/.local/bin`、`~/bin`）找 `gh`/`glab`；只对该 host 校验登录；
- 行为：一个 run 一个 issue；只在 **DONE / BLOCKED / 里程碑** 追加评论（忽略 IN_PROGRESS）；正文放目标卡与记录目录，任务清单折叠已完成批次；
- 体积：issue 正文 ≤60k 字符，超长截断并链接记录目录；
- 失败：退避重试，记 `run.json.mirror`（`disabled` / `lastError`）；不阻塞、不回写、不存 token。

## 15. 界面

- 创建对话框：两步（校验目标卡 + 确认探针命令、生成记录目录），第二步实时显示路径与文件数；提供「在独立 worktree 中运行」勾选（在当前工作区建 `.guard/worktrees/<run-id>` 隔离检出，主检出分支保持不动，也不新建 DSH 工作区；会话仍归原工作区的侧栏分组，工作目录切到隔离检出）；
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
2. **M2 循环与检查点**：锚点、每轮探针、评估触发、goal 集成、拒绝收工、**DONE 提交与 tag**（推进 base_commit）；
3. **M3 严格模式与工单**：warn-only、scope diff、baseline_dirty、ScopeChangeRequest、enforce 开关；
4. **M4 阻塞与回退**：BLOCKED 补丁、路径限定 stash、手动回退界面、独立 worktree 模式；
5. **M5 并行与镜像**：并行 worktree、staging 合入回归、gh/glab 镜像、Epoch 兜底。

## 20. 已拍板与待确认

**已拍板：**
- `enforce` 默认关闭，保持 `warn-only`，由用户逐 run 切换；
- 独立 worktree 模式默认关闭（串行时）；并行强制开启；创建时检测到脏工作区会提示勾选；
- 提交信息 `guard(<run-id>): <task> DONE`，tag `guard/<run-id>/<task>`；run-id 与任务 id 按第 4 节规则清洗。

**进展评估口径（已拍板）：**
- 复用同一 JSON 解析器与重试外壳，但判定口径与枚举独立于任务评估；
- 输出三态：`advancing`（失败面实质缩小或确实换思路，重置连续计数并继续）、`spinning`（同一思路打转或 diff A→B→A 往复，立即 BLOCKED）、`scope_blocked`（卡点源于上游文件不在 scope 内，引导发起 ScopeChangeRequest 而不是盲试）；
- 同一签名最多豁免 2 次，第 3 次直接 BLOCKED。

**合入回归范围（已拍板）：**
- 当前合入任务的必选探针 + 1 条项目级快速编译/冒烟命令（创建 run 时可选配置，如 `tsc --noEmit`、`cargo check`、`go build ./...`）；
- 目标仓库没有全局检查命令时（如纯文档任务），自动退化为仅跑合入任务的必选探针。

## 21. 实现状态（2026-11-24）

已落地并通过测试：

- 契约与存储：`schema.ts` / `store.ts`（同目录原子写、`state.jsonl` 追加、单 run 串行锁、`TASKS.md` 纯渲染、冷启动重绘）。
- 创建流程：`guard.prepare` 通道、run-id 清洗、目录骨架、探针文件、两段式对话框进度、`guardRunId` 传入会话创建。
- 督导循环：首尾锚点（≤2KB）、light/heavy 探针、任务边界评估（全部必选探针通过 + scope 指纹变化或新增完成声明）、轻量进展评估（3 连击，advancing/spinning/scope_blocked）、DONE 先写台账再提交并打 tag、goal 门禁（未全 DONE 拒绝 complete/edit）。
- 里程碑审阅（`milestone.ts`）：每完成 `milestoneEvery` 个任务跑 3 个独立审阅者 + 分歧时 1 个裁决者，结论写 `review/round-<n>.md` 并发 `review.milestone` 事件；`fail` 停 run（`status: blocked` + `goals.block`），`insufficient` 只记录；审阅者不可解析一律按 `insufficient` 记，绝不当 pass。
- 严格模式：主会话写记录目录放行、越界写与命令拒绝（enforce）、范围变更请求（常规自动批准、敏感或超 3 次转人工）、BLOCKED 补丁留证。
- 镜像：PATH + 常见目录探测 gh/glab、按 remote host 校验登录、单 run 单 issue、DONE/BLOCKED 评论、失败降级；CLI 调用一律非交互（gh `GH_PROMPT_DISABLED`、glab `--yes`）并带 60s 超时，超时按失败降级，绝不挂住收尾审计。
- 界面：督导状态卡（进度、当前任务、阻塞原因、镜像链接、两段确认的回退按钮）、创建对话框第二步入库进度。
- 回退：`guard.rollback` 通道 + 界面上「再点一次确认」；用 `git revert` 撤销检查点之后的提交，保留历史，不重写分支。
- 隔离 worktree（可选）：创建时勾选「在独立 worktree 中运行」，run 在 `.guard/worktrees/<run-id>` 的独立分支 `guard/<run-id>` 上执行，完成后由用户合入；`.guard/` 写入 `.git/info/exclude`，不污染业务提交。

评审回归修复（2026-11-24 第二轮自审后补齐）：

- 建 goal 从 `setup` 回调移到 `agents.create`/`resume` 之后（`armSupervisorGoal`）：goal 服务对未进入注册表的 agent 抛 `GOAL_AGENT_NOT_LIVE`，在 `setup` 里调用会让会话创建 100% 失败。
- 督导 worktree 只能属于本次 run：`realpath(<source>/.guard/worktrees/<run-id>)` 精确比对后才切换运行目录。**不再为 worktree 登记 DSH 工作区**（登记会让侧栏多出一个 run 目录分组，且 run 结束即变成 missing-dir）：会话以源项目为 header 创建并挂到源工作区，再由 `workingDirectory.set` 把有效目录切到检出（`workspace-root/change` 事件持久化，重开仍在检出里）。
- DONE 提交或打 tag 失败时台账回滚为 `IN_PROGRESS` 并记录 `commit.failed` + `task.reopened`；同名 tag 已存在则在提交前 BLOCKED，不写一个没有 tag 的 DONE。
- 完成声明偏移只在评估真正跑过时推进，避免「探针未过 → 偏移被吃掉 → 永远不再评估」的死锁。
- 50 次上限改用 `attempts.at(-1).index + 1`（原按窗口长度判断，永远到不了）；`advancing` 会重置连击计数；豁免满 2 次后不再调用评估器。
- 无任务可跑时用合法的 `{ code, message }` 调 `goals.block`（`supervisor-blocked`），并把原因写进 run；任务重新可跑时清除该标记，保证幂等且可被人工重新 arm。
- 并行批次共享 worktree 时，同批次其他任务的 scope 不算「本任务越界」；glob 相交判定改为静态目录前缀比较。
- 记录目录只放行 `tasks/<ID>/notes.md`、`review/*.md`、`requests/*.json`；`create_goal`、`apply_patch`、`str_replace_editor`、`pwsh` 在严格模式下一律拒绝，字符串形式的工具参数也会解析。
- 探针：`rg` 退出码 2（非法正则/路径不存在）判 `unknown` 而不是 `pass`；超时与超缓冲判 `unknown` 而不是退出码 127；声明路径不得越出工作区；网络命令一律拒绝；`probeEnv()` 增加死代理与 `GIT_TERMINAL_PROMPT=0`，冒烟命令同样使用脱敏环境；失败探针与 heavy 探针的输出写入 `tasks/<ID>/evidence/<probe>-<ts>.log`（每任务最多保留 20 条证据）。
- 创建对话框补上探针命令行（`任务 ID | 命令`，一行一条）：插件自己执行、退出码 0 才算通过；不填则该任务只靠评估器判定，此时 `TASKS.md` 不列探针。
- 回退（`rollback.ts`）：无新增提交时不再报错；先留补丁证据，再把被重开任务 scope 内的脏文件恢复到检查点，最后重开任务并按需清除运行级阻塞（里程碑失败且本次未重开 DONE 任务时保留闸门）；同一检查点二次回退会被拒绝，避免把上一次 revert 再 revert 回去。
- 冷启动：`watchGoalSupervisors` 在 `agent/created` 时按 `run.json.sessionId` 重挂锚点、门禁与收尾审计。
- 第二轮评审修复（安全与正确性）：
  - 范围变更请求不再把 `id` 当文件名（`id: "../../tasks"` 曾可覆写台账），就地回写原文件；`addedPaths` 必须是安全的相对路径；`**`、`*`、`.`、`**/*.ts` 等整仓通配一律转人工。
  - 审批后的 `scope` / `scopeApprovedCount` 不再被同一轮审计覆盖（旧代码 `...base` 把它抹掉，扩范围实际从未生效）。
  - 回退分两种语义：在途任务 revert `最后检查点..HEAD` 并把自身 scope 恢复到该检查点；重开已 DONE 任务**不重写历史**，只把 scope 恢复到上一检查点/自身 base commit 并删除该任务的 tag（否则重试会撞「tag 已存在」死锁）。未声明 scope 的任务在回退中不删除任何文件（`pathInScope([])` 等于“全部”），并在报告里列 `skipped`；`baselineDirty` 里的文件永不触碰。
  - worktree run 的 run-id 冲突检测补上 `.guard/worktrees` 扫描；`run already exists` 不再被 worktree 模式绕过。
  - 挂载会保留 `run.json.mirror` 的 `issueNumber`/`issueUrl`/`nextRetryAt`（重启不再重复建单）；`agent/disposed` 释放挂载槽位，同进程重开会话能重新挂载；冷启动重绘 `TASKS.md`。
  - `notes.md` 骨架里的「## 完成声明」不再被当成首轮完成声明（初始 `lastEvalOffset` = 骨架长度），首轮不会强跑 heavy 探针或评估。
  - 里程碑三审：`insufficient` 不再被裁决翻盘；裁决理由（字符串 `why`）能正确落盘；最后一个批次（任务数是 `milestoneEvery` 整数倍）也会审阅，且在 goal 完成之前。
  - 冒烟命令改为在必选探针通过后每轮执行（失败不再被 `lastEvalScopeHash` 锁死），并拒绝联网命令；评估失败分支同样走 3 连击与 50 次上限。
  - `GuardStore` 按 run 目录共享锁（attach / rollback / arm 不再各自持锁交错）；`guard.rollback` 加 turn-open 门禁与 run-id 校验；探针 id / spec / timeoutMs、scope map、`guardRunId` 与 `guard.tasks` 互斥都在通道层校验。
  - 对话框探针输入改为多行 textarea，命令探针标为 heavy；`run already exists` 后允许用新 runId 重试。
- 第三轮评审修复：
  - `changedPaths` 先消费 `git status -z` 的 rename/copy 源路径记录再过滤，且重命名同时报告目标与被删源路径（此前 `git mv` 出 scope 不报越界）；新增 `changedPathsSince(baseCommit)`，收尾审计改为「工作区脏改动 ∪ `base..HEAD` 提交差集」，子会话自行 `git commit` 的越界改动也能被 `enforce` 拦下。
  - `matchesGlob` 的 `**/` 支持零级目录：`src/**/*.ts` 现在能匹配 `src/a.ts`（此前只匹配 `src/x/a.ts`）。
  - 回退：重开已 `DONE` 任务时把「该任务已提交的改动」也纳入恢复范围（`base..HEAD` 差集），并跳过与创建时基线字节一致的 `baselineDirty` 文件（此前只按工作区脏文件筛，DONE 任务实际恢复 0 个文件、且会删掉用户运行前的脏文件）；重开后 `lastEvalOffset` 置为 `notes.md` 当前长度，历史完成声明不再触发首轮误判。
  - 回退后按宿主 goal 当前相位恢复：`blocked`/`paused`/disarmed 调 `goals.resume`，`complete` 或无 goal 用 `armSupervisorGoal` 重建（否则宿主不会再驱动续轮）。
  - 提交失败回滚态不再推进 `lastEvalScopeHash`（否则无完成声明的任务在环境修好后不再重试提交）；`doneState` 补齐 `lastEvalOffset`。
  - 冒烟命令失败也走三次连击判定；自动批准的范围变更若与同批并行任务 scope 相交，转人工审批。
  - 创建期探针若指向不存在的任务直接拒绝（此前静默丢弃，任务退化为只靠评估器）；重写同一 run 时清理已删除任务的 `tasks/<ID>/` 与 `probes/<ID>.json`。
  - 客户端探针行格式错误或指向未知任务时禁用确认（不再静默丢弃）；命令探针标为 heavy；清空 prepared runId 时同步换 `operationId`。
  - 新增回归：`goal-supervisor-channel.spec.ts`（3 个新通道 op 的正向/拒绝分支）与 contextView 督导卡 5 条（渲染、阻塞原因、两段确认、换会话复位、失败可见）。
- 第四轮评审修复：
  - `guard.rollback` 恢复 goal 时传**注册表里的原对象**（宿主 GoalService 按引用校验 `ctx.agents.get(id) !== agent`），此前浅拷贝会让 `resume`/`create` 全部 `GOAL_AGENT_NOT_LIVE`，并把 `run.json` 写成 `setup-failed`。
  - `changedPathsSince` 会跳过插件为**其他任务**写的 `guard(<runId>): <task> DONE` 提交：并行批次里先完成的兄弟任务在同一 `baseCommit..HEAD` 区间内提交的文件，不再被算成当前任务越界（`enforce` 下不再误 BLOCK 跨轮完成的并行任务）。
  - 任务表第 4 列的内联 scope 与 `scopes` 映射走同一套校验（相对路径、无 `..`、非整仓通配、长度上限）；此前对话框唯一的 scope 入口完全未校验。
  - 回退：首个任务被“子会话自行 commit”卡住时，按 `baseCommit..HEAD` 中**非插件提交**逐个 revert 并恢复 scope（此前既不 revert 也不 restore，坏提交原样留在 HEAD）；`rollbackToCheckpoint` 在区间顶部已是 revert 提交时按幂等 no-op 处理（此前二次回退直接报错，脏改动永远清不掉）。
  - `changedPaths` 只在**重命名**时计入被删源路径；复制（`C`）的源文件未改动，不再计入。
  - 对话框任务表即时校验 ID 格式（`^[A-Za-z][A-Za-z0-9_-]*$`）与重复 ID，与后端解析保持一致。
- 第五轮评审修复：
  - `changedPathsSince` 改用 `isOwnCommitSubject` 字面量判定：上一版用 `new RegExp(escapeRegExp('… .+ DONE'))`，`\\.+` 被转义成字面量，兄弟任务的插件提交**从未**被跳过（`enforce` 下跨轮完成的并行任务依旧必然 BLOCKED）；回归测试同时补成「两任务共享同一 `baseCommit`」的真实时序，并做过变异验证。
  - `revertCommits` 取消 `.reverse()`，按 `commitsAfter` 的 newest-first 顺序回退（旧实现反序，同一文件两次提交必冲突）；首任务分支补 `^Revert "` 防重入。
  - `baseCommit` 只在任务**首次**启动时记录：重开首个 `DONE` 任务后再启动，不会把基线挪到刚被撤销的 `DONE` 提交上，二次回退不再复活旧代码。
  - `armSupervisorGoal` 对非 `active` 的 run 直接返回：冷启动打开一个已 `completed` 的督导会话不会再凭空建出永不完成的 goal。
  - scope 校验收口：`isBroadScopePath` 把首段含通配符的模式（如顶层星号加 `/**`）判为整仓授权，`isSafeScopePath` 改为段级 `..` 判定并剥离多层 `./`。
  - 测试污染：`git config status.renames` 补上 `{ cwd }`（此前会改写真实检出共享的 `.git/config`）；复制用例改成真正的 `C` 记录（git 只有在源文件同时被改动时才报 copy），并断言后续条目不被破坏。
  - 非 git 工作区不再跳过里程碑三审；`syncMirror` 首次建单成功但首评失败时保留 `issueUrl`；回退二次失败的原因里写明「scope 内文件已恢复」。
- 第六轮评审修复：
  - `restorePaths` 先校验 `ref` 是否存在：缺失的检查点不再被当成「文件原本不存在」而把整个 scope `rm -rf` 删除。
  - `rollbackRun` 以 `hasRef` 过滤 `restoreRef` / `revertFrom`：tag 被手删、或非 git 工作区留下的虚构 ref 一律按「无参考点」处理；二次重试仅在「scope 内有脏文件且确实有检查点」时才先恢复再 revert。
  - `finishTask` 在无 git 的仓库不再把 `guard/<run>/<task>` 写进台账（此前必然导致之后每次回退 `checkpoint ... does not exist`）。
  - 回退真正重写历史后，重开任务的 `baseCommit` 前移到新的 `HEAD`；`changedPathsSince` 的提交级归因与 `base..HEAD` 净差集求交——被 revert 的越界文件不再被终身追责（此前 `enforce` 下任务回退后永久死锁）。
  - 进展评估返回 `unknown`（模型不可用/超时/无法解析）时直接 BLOCKED，不再静默放行空烧 50 轮尝试。
  - 工具门禁与首尾锚点改用「所有在途任务」：`parallel > 1` 时兄弟任务的 scope 不再被误拒，锚点也会列出每条在途任务及其 scope；没有在途任务时只放行依赖已满足的可启动任务。
  - `armSupervisorGoal` 对 `goalBlocked` 的运行同样拒绝建 goal；挂载成功会清除 `setup.failedStep` / `errorMessage`，红色「挂载未完成」不再永久驻留。
  - 通道 `specOf` 补齐 `number_gte` 的 `args` 与 `scan` 的 `paths` 类型校验；修正 `commitsAfter` 的排序注释（newest-first）。
- 第七轮评审修复：
  - 回退二次重试只在「确有 scope 内脏文件 + 失败可重试」时执行，且只恢复这些脏路径：此前用包含已提交路径的 `scoped` 判断，混合回退区间失败时会无备份删除/覆写已提交文件。
  - 回退重开任务清空 `attempts` 与 `probeResults`：因 50 次上限或豁免用尽而阻塞的任务，重开后第一轮不再立即再次 BLOCKED（审计记录仍留在 `state.jsonl`）。
  - `enforce` 补齐宿主真实终端工具（`terminal_open` / `terminal_send` / `terminal_signal`，按 `^terminal` 前缀匹配）；写路径与探针路径都加 `realpath` 校验，工作区内指向台账或工作区外的软链不再能穿透。
  - `SAFE_RUN_ID` 统一由 `run-id.ts` 导出并与 `sanitizeRefSegment` 对齐（`\p{L}` 覆盖重音拉丁、假名、谚文），禁止前导 `-`：此前 `café 重构` 这类目标生成的 run id 会被自己的通道拒绝。
  - 敏感路径判定统一走 `normalizeScopePath`，目录规则改为 `(?:\/|$)`、全部加 `i`、通配符按静态前缀比对：`infra`、`config/.env*`、`src/package.jso*`、`.GITHUB/...` 不再能自动审批。
  - 「全部完成」只在所有任务确实 DONE 时渲染（此前所有任务 BLOCKED 也报完成）；阻塞纠正提示改从台账里真实 BLOCKED 的任务收集。
  - 回退优先选 `BLOCKED` 任务（并行批次里卡片正在展示的那条），前置 tag 缺失时回退到 `target.baseCommit`。
  - 插件自身提交的识别改用**插件自己打的 annotated tag**（`for-each-ref %(*objectname)`），并给 `git show` 加 `-m --first-parent`：子会话伪造 `guard(<runId>): FAKE DONE` 主题或 merge 进来的越界改动不再被跳过。
  - 客户端切换会话立刻清空 `supervisor` 卡并用代次号丢弃迟到的回退响应；`guard.prepare` / `guard.rollback` 用会话锁串行化整个「读台账 → git → 写回」事务。
  - 模型不能再自行把宿主 goal 标为 `blocked`（只有督导循环能判定并记录原因）；`detectMirror` 在挂载路径上有 5s 独立预算；冷启动的 `armSupervisorGoal` 延后到 `agent/created` 串行派发之后，避开 `GoalService` 自身的 disarmed 监听。
  - 依赖环在建盘前拒绝；`setup.firstMessage` 在首条任务投递成功后置真；里程碑批次按完成顺序（`doneOrder`）而非任务表顺序切片；`status.currentTaskId` 复用 `runningTasks`。
  - 对话框外层容器由 `<label>` 改为 `<div>`：点击说明文字不再误关督导面板。
- 客户端：首次点击即携带 worktree 路径（不再读旧 state）；督导字段变更会作废已建目录并用同一 runId 重写台账；回退二段确认随会话切换复位；回退失败原因照原文展示；旧 Goal Guard 与新督导互斥。

已知偏差（未完成，后续补齐）：

- 并行任务仍共享同一个 run worktree（互斥 scope + 逐任务 pathspec 提交 + 项目冒烟命令）；**per-task worktree 合入队列**尚未实现，要真正隔离每个任务需要把子会话的 cwd 指到各自的 worktree，属于下一阶段。并行默认仍建议 `parallel = 1`。
- 镜像的真机结论：**GitLab（自建 `lionm4:30005`，`glab` 1.131.0）已跑通真实建单 + 评论并回读校验**（一次性私有项目，测完已删除）；**GitHub（`gh` 2.105.0）只验证到"认证 + argv 通过 + 目标仓库不存在时干净降级"**——当前 token 作用域 `gist/read:org/repo/workflow` 不含 `delete_repo`，无法建一次性仓库并清理，所以 GitHub 的成功写入路径要等你指定一个可以留一张 issue 的仓库。
- 里程碑三审只在单元层验证过（3 审 + 裁决 + `review/round-<n>.md`），未在真机上跑过一整轮。
- **独立 worktree 不会自动合入**（`worktree: true` 时 `createRunWorktree` 建 `.guard/worktrees/<runId>` 与分支 `guard/<runId>`，但代码里没有任何 merge 实现）。提交落在隔离分支上，需要人工 `git merge`。弹窗文案、`TASKS.md` 与督导卡都会点名该分支并写明「不会自动合入」，不再暗示自动合回。
- 探针命令行按空白切分 argv、**不经过 shell**。已知偏差：要带空格或复杂参数时先包一层脚本再写进探针。
  这条约束现在**在建盘前强制**（`probes.ts:shellishProbeArg`）：参数以引号开头/结尾、引号个数为奇数、出现 `>(重定向)`/`|`/`;`/`&&` 作为独立 token、或含 `$( ` 时，`prepareGuardRun` 直接拒绝并指出是哪个参数。
  判定刻意放行「引号出现在参数内部」的写法（`node -e 'console.error("x")'` 是合法程序输入），只有「边缘引号或奇数引号」才算用户以为有 shell。

### 第十五轮：真实运行暴露的三处问题

真机跑了一轮 2 任务督导，`state.jsonl` 记录到：

1. **P0 · 越界判定误伤「提前准备下一个任务文件」**。T1 scope 是 `src/math.ts`，agent 顺手建了 T2 声明的 `src/math.test.ts`，审计把后者算成 T1 的越界，在评估器刚返回 `pass` 的同一毫秒把 T1 置为 `BLOCKED`，整轮停下。原因是「兄弟豁免」只覆盖 `batchIds`（并行批次），`parallel: 1` 时批次里只有 T1。
   **修法**：把**尚未开始**（`status === 'TODO'` 且 `baseCommit === undefined` 且 `reopenedAt === undefined`）的其它任务所声明的 scope 也计入豁免——那些路径本来就归后面的任务，它自己的审计会判定。
   **刻意不放宽**：`DONE` 任务的 scope 不豁免（改已完成的工作仍是越界）；被回退重开的任务不豁免（它重新拥有自己的文件，兄弟任务不能借重试之便覆盖）。
2. **P1 · 锚点不告诉模型别的任务要哪些文件**。模型没有任何信息能判断 `src/math.test.ts` 属于 T2。
   **修法**：锚点新增一行「其他任务 scope（不是你的）：…」，只列 `TODO` 任务（`DONE` 的 scope 已关闭，不是邀请）。
3. **P2 · 阻塞时模型回头问用户**。该会话调了 `ask_user_question`（「T1 被督导阻塞，如何恢复」），与「过程不打断、最后一次性汇报」的期望相反。
   **修法**：硬规则补上「不要中途向用户提问、也不要逐任务等确认 —— 遇到阻塞就把原因写进 `tasks/<ID>/notes.md` 后停下，全部结束后一次性汇报」。

另记：这一轮评估器在**同一份工作区**上先后给出 `insufficient / insufficient / fail / fail / insufficient / pass` 六次判定，其中一次是 `model: ""`、`latencyMs: 0` 的「评估模型不可用」；探针 5 次全 `pass`。判定摇摆让一个 30 秒的任务跑了 25 分钟，是下一版要治的质量问题（不属于本轮修复范围）。
- 第八轮（第七轮修复的核验 + 补齐）：
  - 已逐条核验第七轮 12 条修复均生效；为 1、2、7、8、11、12 条补齐了此前缺失的回归，并对 8 处修复做了变异验证（把修复临时改坏 → 对应测试变红 → 还原）。
  - **跨任务回退残留（本轮修复）**：连续回退两条 `DONE` 任务后，第二条任务被恢复成检查点内容的文件仍是工作区的未提交改动，第一条任务重启时 `changedPathsSince` 会把它（脏改动 + 未打 tag 的提交归因）算成自己的 `scope 外改动` 并卡死。修法选「归因侧」：`rollbackRun` 记录 `rollbackResidue`（路径 → 回退后的内容 hash，删除记 `'deleted'`）；`taskPaths` 只有在「路径不在本任务 scope、且内容仍与记录一致」时才把它归给那个仍未完成的任务。内容一变（真的有人写了它）立刻恢复归因，`enforce` 仍会拦下；全程不写文件，`baselineDirty` 与用户运行中的脏文件都不会被误删。
  - 不采用 `git checkout HEAD -- <path>` 归位：`HEAD` 仍是该任务自己的提交，checkout 只清掉工作区脏改动，`changedPathsSince` 的提交级归因仍会再次列出该路径，卡死不解除。
  - 任务再次 `DONE` 时清空 `rollbackResidue`；重开任务再次回退时合并旧记录（只有 hash 仍匹配才生效）。
  - 新增回归：`goal-supervisor-loop.spec.ts`「cross-task rollback residue」正/负 2 条与「milestone batch order」1 条；`goal-supervisor-rollback.spec.ts`「rollback retry」3 条 + BLOCKED 优先 + 检查点 tag 兜底；`goal-supervisor-git.spec.ts`「plugin commit authorship」2 条（伪造 subject 不跳过、merge 提交按 first-parent 审计）；`goal-supervisor-attach.spec.ts` 新文件 realpath 允许、`update_goal blocked` 拒绝、冷启动 `setImmediate` 延后 arm；`goal-supervisor-anchor.spec.ts` 全 BLOCKED 不报完成/纠正行；`goal-supervisor-create.spec.ts` `firstMessage` 幂等；contextView 迟到回退响应丢弃。
  - 本轮仍存偏差：① 工作区内软链（即使指向工作区内）在 `enforce` 下会被 `realpath` 校验一律拒绝——安全优先，但符号链接源码树会被误拒；② 并行批次的「上一个 DONE」按任务表顺序取检查点，兄弟任务乱序完成时重开可能恢复到比目标任务更新的 ref（并行默认 1，per-task worktree 未实现，暂记为已知限制）；③ `guard.prepare` / `guard.rollback` 的会话锁与 `detectMirror` 5s 预算没有专门回归（靠代码审查 + 现有挂载测试覆盖）。

- 第九轮评审修复（P0×3 + P1×6 + P2×4，逐条变异验证）：
  - **P0-1 回退按完成顺序**：`rollbackRun` 不再按 `state.tasks` 声明顺序过滤 `DONE`，而是按 `state.doneOrder` 排序（缺项视为早于该字段、按表顺序排在最前）；重开 `DONE` 任务时同步从 `doneOrder` 移除该任务 id。并行批次乱序完成且有在途任务时，`last`/`previous` 现在取真正的最后完成者：不会再把健康兄弟的提交一起 `revert`，也不会选错 target/previous 导致「台账改了却没恢复/删除任何文件」。旧台账（无 `doneOrder`）做在途回退时，若 `last..HEAD` 中含其他仍为 `DONE` 的检查点提交，直接拒绝并给出人工处理原因，绝不跨检查点整段 `revert`。
  - **P0-2 悬空软链**：`realPathOrNull`（attach）与 `realPathInside`（probes）在回退父目录前先 `lstatSync`：只有 ENOENT 才继续向上，软链（含悬空）与其他 stat 错误一律拒绝。此前 `src/escape.txt -> ../escaped-target.txt` 与「文件尚不存在」同形，`write` 会以 `O_CREAT` 跟随软链在工作区外建文件。
  - **P0-3 残留绑定 HEAD/blob**：`rollbackResidue` 从 `{path: hash}` 改为 `{path: {headBlob, worktreeHash}}`，`explainedByRollbackResidue` 必须同时匹配当前 `HEAD:<path>` 与磁盘内容；任一任务 `DONE` 提交某路径后，从**所有其他任务**的残留中删除该路径（`clearResidueForCommitted`，提交成功后落盘）；每次回退按本次 `dirtyAfter` **重建**该任务残留（为空显式 `undefined`），不再累加；已有残留或曾重开过的任务，在途回退优先用早于旧提交的 `target.baseCommit` 作为恢复 ref，且不再把 `baseCommit` 前移到 revert 提交，避免重开后复活旧坏代码。
  - **P1-1 冷启动 arm**：`armSupervisorGoal` 发现 `phase === 'active' && activation === 'disarmed'` 时调用 `goals.resume(id, revision)` 重新 arm；`paused` 保持人工暂停、不自动 resume；resume 失败按 `setup-failed` 记录；`setImmediate` 里的 arm 补 `.catch`。
  - **P1-2 敏感路径与 scope 规范化**：通配符改为 `matchesGlob` 反向匹配代表文件名/目录名（`config/?env`、`config/*env*`、`src/?ackage.json`、截断目录名 `vend*`/`node_mod*`/`docs/g*` 命中，`src/s*.ts`/`src/p*.ts`/`src/d*.ts` 不再误判）；目录规则改为 `(?:^|/)(?:.github|.git|.guard|infra|vendor|node_modules|.husky)(?:/|$)` 并拒绝自动批准 `docs/guard`；`normalizeScopePath` 收敛到 `git.ts` 由 `matchesGlob`/`globsOverlap` 共用，`create.ts`、通道 `scopesOf`、`processScopeRequests` 入库前统一规范化（`././src/a.ts`、`src\a.ts` 不再「批准了却永不命中」）。
  - **P1-3 空提交消息**：`changedPathsSince` 与外来回退提交过滤只跳过空 sha，`--allow-empty-message` 提交的越界改动不再对审计隐身。
  - **P1-4 retryable 收紧**：只匹配真实脏工作区提示（`local changes` / `would be overwritten` / `uncommitted` / `unstaged`），`git revert` 的 stderr 原样透传；merge 冲突等不可重试错误不再先恢复/删除 scope 内文件。重试路径改为把脏文件重置到 HEAD（而非检查点）：`git revert` 只在被回退提交触达的文件有本地改动时拒绝，恢复到检查点会让 index 与 HEAD 不一致、第二次仍失败。
  - **P1-5 已提交删除的收尾**：`finishTask` 只用当前 `changedPaths` 中仍脏的 scope 路径（加台账目录）做 `commitPaths`；子会话已 `git rm && git commit` 的任务不再因 `pathspec did not match` 每轮回退 `IN_PROGRESS`。
  - **P1-6 run.json 更新竞态**：`GuardStore.updateMeta(fn)` 在运行锁内基于最新 meta 合并落盘；`syncMirror` 的 CLI 调用留在锁外、结果回填走 `updateMeta`，不再抹掉并发的 `setup.firstMessage` 或 `mirror.provider/host`；`markFirstMessageDelivered`、`markSetupFailed`、挂载与 arm 的 meta 写入一并改用该原语。
  - **P2**：`pluginCommitShas` 查询前先 `sanitizeRefSegment(runId, 50)`（`my--run` 的 tag 实际在 `guard/my-run/`）；`SENSITIVE_STEMS` 静态前缀判定删除；cwd 自身含软链时按 `realpath(cwd)` 与原始 cwd 双根比较（工具返回 canonical 绝对路径不再被误拒）；`detectMirror` 挂载预算可注入并补超时降级回归，`guard.prepare` 串行化补并发 epoch 回归。
  - 新增回归 31 条：rollback「completion order」3 条 +「residue binding」3 条；loop「finish and meta races」2 条 + cross-task residue 2 条；scope「sensitive path hardening」5 条；git「attribution edge cases」3 条；attach「arming and path hardening」4 条 + 悬空软链 1 条 +「mirror probe budget」1 条；probes「path hardening」2 条；store「run meta updates」2 条；create 首消息标记 1 条；channel 串行化 1 条 + scope 规范化 1 条。全量 `vitest run`：126 文件 / 1920 条通过（+31）。
  - 变异验证共 20 处（把修复临时改坏 → 对应测试红 → 还原）：19 处一次命中；P1-6 第一版改法（把 `readMeta` 移到锁外）没有复刻旧实现而保持绿色，改成「回写 CLI 调用前的快照」后仅 mirror 竞态用例变红。

  - 仍存偏差：① 工作区内软链（即使指向工作区内且目标存在）在 `enforce` 下仍一律拒绝（安全优先，符号链接源码树会被误拒）；② 旧台账（无 `doneOrder`）无法还原真实完成顺序时，跨兄弟检查点的在途回退会显式拒绝并提示人工处理，而不是猜测；③ 并行任务仍共享同一个 run worktree（per-task worktree 合入队列未实现，`parallel` 默认 1）。

- 第十轮评审修复（P0×2 + P1×5 + P2×5，逐条 TDD + 变异验证）：
  - **P0-1 大小写不敏感文件系统上的 guard 目录绕过**：`attach.ts` / `probes.ts` 的 `realpath` 统一改为 `realpathSync.native`（返回磁盘真实大小写）。APFS 默认大小写不敏感，而普通 `realpathSync` 会保留调用方拼写，于是 `docs/GUARD/<runId>/tasks.json` 与真正的 `docs/guard/<runId>/tasks.json` 是同一个文件却逃过了大小写敏感的 `guardDir` 比较，`scope: []` 或 `docs/**` 时模型可直接覆写 `tasks.json`/`run.json`/`state.jsonl`/`probes/*.json`。`guardDir` 前缀判定再加一层小写比较，覆盖文件尚未创建（`realpath` 按最近存在祖先回溯、尾部保留调用方拼写）的场景。
  - **P0-2 部分回退被误判为「已完成」**：`git revert` 逐条提交、不是原子的。首次尝试成功 revert 最新一条、随后因脏文件失败时，第二次尝试重算 `base..HEAD` 会看到顶部是 `Revert "..."`，旧代码直接返回 `ok: true, reverted: []`——`subagent-1`（含越界文件）永远留在 HEAD，`advancedBase` 不推进，重试永久死锁。新增 `revertCommitsProgress()` 返回 `{reverted, remaining, failure}`；`rollbackRun` 在首次尝试前把「非插件提交」清单算好一次，重试只继续 `remaining` 并合并 `reverted`，最终失败如实报告「已回退 N 条、其余未回退，请手动处理」。后续点击也能续做：按 `Revert "<subject>"` 识别已回退项，只对剩余 SHAs 操作；同标题歧义时显式拒绝而不是赌一把。
  - **P1-1 敏感路径通配符残余绕过**：`wildcardHitsSensitivePath` 改为按路径段检查目录：任一非末段（裸 `*` 也算，纯 `**` 是目录授权、排除）能以大小写不敏感方式匹配 `.github`/`.git`/`.guard`/`infra`/`vendor`/`node_modules`/`.husky`，或 `docs` + 下一段匹配 `guard` → 转人工；文件名样本比较两侧统一 `toLowerCase()`；`normalizeScopePath` 折叠 `//` 与 `/./`（保留前导 `/`，绝对路径仍被 `isSafeScopePath` 拒绝）。`docs/g*/**`、`docs/guar?/**`、`docs/g*/other-run/tasks.json`、`packages/node_mod*/**`、`sub/.g*/**`、`sub/.g*/config`、`sub/inf*/prod.tf`、`src/Package.jso*`、`docs//guard/...`、`docs/./guard/...` 全部转人工；`src/**`、`docs/**`、`docs/**/*.txt`、`src/*.ts`、`src/s*.ts` 仍自动批准（不误伤常规目录授权）。
  - **P1-2 staleCheckpoint 双向缺陷**：不再用任务级布尔对整组路径一刀切。当 `ownBase` 早于上一检查点且该任务曾重开过时，按路径比较 `ownBase` 与 `previousRef` 的 blob，并用新增的 `foreignPluginCommitPaths()`（以插件 tag 证明归属，非本任务）判断 `ownBase..previousRef` 内是否有其他任务的插件提交改过该路径：有 → 恢复到 `previousRef`（保住兄弟刚提交的 `T1-v2`）；没有 → 恢复到 `ownBase`（丢弃继承来的旧坏 blob，`T2-BAD` 不再复活）。`advancedBase` 仍只按「曾重开/有残留」不前进，保留原语义。
  - **P1-3 子会话自提交路径的残留漏清**：`finishTask` 改用本任务 `changed`（含子会话已提交、`staged` 为空的路径）清理其他任务的 `rollbackResidue`，`changed.length > 0` 即执行；否则后续 scope 外删除仍会命中旧残留被豁免。
  - **P1-4 补丁漏 staged、重置解不开暂存新增**：`captureBlockedPatch` 有 HEAD 时用 `git diff HEAD --binary`（staged 改动也进补丁，无 HEAD 时回退到 `git diff`）；`restoreTrackedToHead` 对「不在 HEAD 但在暂存区」的路径执行 `git reset --`（保留工作区文件，交给 `restorePaths` 按检查点清理），二次 `git revert` 不再被 staged 新增文件永久卡住；二次失败文案改为如实说明「已重置到 HEAD」与实际备份文件路径（无补丁时说明没有备份）。
  - **P1-5 旧台账重开 DONE 缺顺序校验**：`reopeningDone` 且 `target.checkpointRef` 存在时也调用 `siblingCheckpointsInRange()`；`checkpointRef..HEAD` 里还有仍 DONE 的兄弟检查点就显式拒绝并提示先回退谁。不再出现「零恢复 + 删 tag + 返回成功」。
  - **P2**：`syncMirror` 的 `updatedAt` / `nextRetryAt` / 事件时间改为 CLI 返回后取（60s 超时不再让 `updatedAt` 倒退、重试窗口不再提前消耗）；挂载探测成功（`mode: 'auto'`）时显式清空 `mirror.reason`（冷启动失败过的 `'remote probe timed out'` 不再永久驻留）；`commitPaths` 按 `git diff --cached --name-only` 过滤实际要提交的路径，`AD` 状态（`git add` 后又 `rm`）不再 `pathspec did not match`；`update_goal(action: 'pause')` 一并拦截（暂停只能由用户在宿主界面发起）；`doneTasksInOrder` 对重复 id 取最后一次出现的位置（最后一次完成才是最新检查点）。
  - 新增回归 19 条：scope「round-10 wildcard hardening」3 条 + 折叠分隔符 1 条 +「blocked patch」staged 1 条；attach「case-insensitive guard paths」2 条 +「mirror probe budget」成功清 reason 1 条 + `update_goal pause` 断言；probes「case-insensitive path」1 条；rollback「partial revert and stale checkpoints」7 条；loop「finish and meta races」时间戳 1 条 +「self-committed residue」1 条；git「staged-then-deleted commit」1 条。全量 `vitest run`：126 文件 / 1939 条通过（+19）。
  - 变异验证 6 处（把修复临时改坏 → 对应测试红 → 还原）：native realpath 与小写前缀同时改坏 → 2 条 attach 用例红；顶部 revert 直接 no-op → 2 条回退续作用例红；`splitBase = null` → 复活旧 blob 用例红；`foreignPluginCommitPaths` 恒空 → 共享 scope 用例红；残留清理退回 `staged` → 自提交残留用例红；补丁退回不带 HEAD 的 `git diff` → staged 补丁用例红。
  - 仍存偏差：与第九轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。

- 第十一轮评审修复（P1×4 + P2×3，逐条 TDD + 变异验证）：
  - **P1-1 重命名提交只提交一半、后续任务死锁**：`stagedNames()` 补 `--no-renames`（`git diff --cached` 默认做重命名检测，`git mv a.ts b.ts` 只报目标 `b.ts`，源路径被 `commit --` 过滤掉，检查点里源、目标同时存在且 `D a.ts` 残留在暂存区）；`commitPaths()` 在 `git add -A` 前用 `--diff-filter=D` 识别「已暂存删除且工作区已不存在」的路径并跳过它（`git mv` / `git rm` 之后该路径只存在于 HEAD，`git add -A -- a.ts` 会 `fatal: pathspec did not match` 把任务弹回 `IN_PROGRESS`，重试正好落入前一个缺陷）。工作区仍有同名文件时照常 `git add`，已暂存的索引删除加真实改动不会被当成删除提交。
  - **P1-2 `changed` 为空时陈旧 residue 不清、可绕过 `enforce`**：清理从「仅按 `changed` 命中删除」改为 `settleResidue()` 双证据——提交归属（`changed` 命中即注销）或「路径在本任务 scope 内，且当前磁盘内容/HEAD blob 已不再等于记录值」。回退删掉的文件被重试任务**原样写回 HEAD 同一 blob** 时，git 视角无任何变化（`baseCommit === HEAD`、工作区干净），`changed` 为空；旧实现的 `changed.length > 0` 短路让 residue 永驻，后续越界删除同时命中 `headBlob` 与 `worktreeHash: 'deleted'` 即被豁免。内容仍匹配的记录一律保留，不被误清。
  - **P1-3 纯根路径丢前导斜杠、`isSafeScopePath('/')` 为真**：`normalizeScopePath` 对绝对路径无条件保留前导 `/`（`/`、`///`、`/.`、`/./` → `/`，不再退化为空串）；`isSafeScopePath` 在归一化后增加空串拒绝（`.`/`./` 归一化为空，旧代码放行后 `matchesGlob(path, '')` 接受整个仓库）。`parseRequest` 因此直接丢弃这类请求，不再把 `addedPaths: ['']` 写回请求文件等人工批准；`isBroadScopePath` 仍把 `'/'` 判为整仓授权。
  - **P1-4 提交删除 + 工作区重建同名文件时回退死锁**：`restoreTrackedToHead()` 对「`HEAD` 中不存在、但磁盘仍有副本」的 scope 内脏路径，除 `git reset` 外再删除该副本——否则第二次 `git revert` 还原删除提交要 checkout 同名文件，必然撞上 `untracked working tree files would be overwritten`，反复点击都无法解锁。删除前必须已由 `captureBlockedPatch` 落盘备份；没有备份时路径进入 `refused`，二次失败文案如实写明「未删除」与被移除副本数。
  - **P2-1 `core.quotepath` 下中文路径被转义**：`stagedBefore()` 改 `git diff --cached --name-only --no-renames -z` 并按 NUL 切分。此前 `中文.ts` 被转义成八进制，`staged.has('中文.ts')` 恒假，补丁捕获对用户已暂存的文件执行 `git add -N` 后再 `git reset --`，把用户已暂存的内容静默取消暂存。
  - **P2-2 里程碑批次未对 `doneOrder` 去重**：`orderedByCompletion()` 移入 `schema.ts`，按「同一 id 取最后一次出现」排序，回退与里程碑共用同一口径；重复 id 不会再让同一任务占两个审阅席位、或把真正完成的任务挤出批次。
  - **P2-3 回退失败文案重复/英文界面全角冒号**：客户端存**原始** message（空串也照存），渲染时空串只显示标题，非空走新增 i18n 模板 `supervisor.rollbackFailedDetail`（中文「回退失败：{reason}」、英文 `Rollback failed: {reason}`），不再出现 `Rollback failed：Rollback failed`。
  - 新增回归 12 条：git「same-content rename」1 条、「`git rm` deletion」1 条、「staged index deletion with a real edit」1 条、根路径归一化 1 条；scope「staged non-ASCII filename」1 条、「root path hardening」2 条；rollback「committed deletion + re-created file」1 条；loop「stale residue on a clean retry」1 条、「milestone duplicate doneOrder」1 条；contextView「empty failure message」1 条、「localized failure template」1 条。
  - 变异验证 10 处（把修复临时改坏 → 对应测试红 → 还原）：`stagedNames` 去掉 `--no-renames`、去掉已暂存删除跳过、`changed` 为空时短路清理、根路径丢前导斜杠、放行空串 scope、重建副本不删除、`stagedBefore` 退回无 `-z`、里程碑退回原样映射 `doneOrder`、客户端退回存标题、渲染退回硬编码分隔符——10 处均精确命中对应用例。
  - 仍存偏差：与第九、十轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。

- 第十二轮评审修复（P1×3 + P2×2，逐条 TDD + 变异验证）：
  - **P1-1 大小写重命名 / 文件被同名目录替换时提交必败**：`git commit -m msg -- <paths>` 隐含 `--only`，会从 HEAD 重建临时索引再按 pathspec 重扫工作区。APFS 上 `git mv a.ts A.ts`（索引 `D a.ts` + `A A.ts`）因别名冲突报 `will not add file alias 'a.ts' ('A.ts' already exists in index)`；`git rm a.ts && mkdir a.ts && echo sub > a.ts/sub.ts` 报 `error: 'a.ts' does not have a commit checked out / fatal: updating files failed`；交换参数顺序同样失败。`finishTask` 中该错误会让 `failCommit` 把已通过探针与评估的任务弹回 `IN_PROGRESS`，之后每轮重复。修法：① 新增 `inspectEntry()`（`lstat` + 逐段 `readdir` 精确大小写 + `isDirectory`），只有「已暂存删除且同名文件仍在、拼写一致」才重新 `git add`；大小写别名命中或同名目录一律跳过（不把别名路径交给 `git add -A` / pathspec）。② 提交阶段新增 `commitTargets()`：索引里若没有本次 `targets` 之外的无关暂存条目，直接执行**不带 pathspec** 的 `git commit -m message`（绕开 `--only` 的临时索引重扫）；若存在无关暂存（人工 `git add` 的其他文件），把真实索引复制到临时 `GIT_INDEX_FILE`，在副本里把无关条目 `reset` 回 HEAD（无 HEAD 时 `update-index --force-remove`）后提交，人工暂存内容在真实索引里原样保留。`core.ignorecase=true` 时索引中仅大小写不同的条目仍算本任务所有：别名对不可拆，否则提交树会同时含两种拼写。`AD`（暂存后删除）路径仍按索引实际条目过滤。
  - **P1-2 回退重置按「全局布尔」删文件、补丁并未覆盖**：`rollbackRun` 以前把 `backupCaptured: patch !== null` 传给 `restoreTrackedToHead`，而补丁由整个 `dirty` 集合生成——任意无关脏文件就能让布尔为真，`dirtyScoped` 里未被补丁覆盖的 HEAD 不存在路径（典型：悬空软链；`patch.ts` 的 `access()`/`stat()` 会跟随链接把它当成缺失而跳过）仍被 `rm`，二次失败文案还声称已备份。修法：① `existing()` 改用 `lstat`，悬空软链本身进入补丁（`git add -N` 记 120000，`git diff` 记录链接目标）；② `captureBlockedPatch()` 返回 `{ path, coveredPaths }`，`coveredPaths` 由与补丁**同一次参数**的 `git diff --name-only --no-renames -z` 得出（不解析二进制补丁头）；③ `restoreTrackedToHead()` 选项改为 `backedUpPaths`，逐路径 `has(path)` 决定是否允许 `rm`，未覆盖的进入 `refused` 并保留磁盘文件；`rollbackRun` 只传本次捕获的覆盖集合，无补丁时为空集。
  - **P1-3 scope 外的陈旧 residue 漏注销**：`settleResidue()` 原先只对 `pathInScope(path, taskScope)` 的路径检查「磁盘 hash / HEAD blob 已变」。T2 的回退残留 `b.ts`（`worktreeHash: 'deleted'`）被 `git checkout HEAD -- b.ts`（或 warn-only 回退）恢复后，T3（scope 只有 `c.ts`）完成时不会清理它；随后 T4 越界删除 `b.ts`，`headBlob` 仍等于记录值、`worktreeHash` 又变回 `'deleted'`，`explainedByRollbackResidue` 误判豁免，越界删除被放行并把 T4 标 `DONE`。修法：去掉 scope 限制，任何 residue 只要与记录不再完全一致（当前内容 ≠ `worktreeHash` 或 `HEAD` blob ≠ `headBlob`）就无条件注销；两半仍匹配的合法残留照旧保留（内容而非意图），不会误注销刚重开任务仍拥有的路径；`settleResidue` 因此不再需要 `taskScope` 参数。
  - **P2-1 归一化根路径不再敏感**：`normalizeScopePath('/')` / `'//'` / `'/.//'` 返回 `'/'` 后，`isSensitivePath` 仍只判 `''`，导致 `isSensitivePath('/')`、`isSensitivePath('//')`、`isSensitivePath('/.//')` 全为 `false`，而 `isBroadScopePath('/') === true`、`isSensitivePath('.') === true`。改为 `normalized === '' || normalized === '/' || isAbsolute(normalized)`，导出函数语义一致（现有调用点仍有 `isSafeScopePath`/`isBroadScopePath` 兜底）。
  - **P2-2 Windows 盘符根路径被当作安全 scope**：`normalizeScopePath('C:/')` / `'C:\\'` 过滤尾斜杠后是 `'C:'`，旧的 `/^[A-Za-z]:\//` 不再命中（POSIX 上 `isAbsolute('C:')` 也为 false），`isSafeScopePath('C:/')` 与 `isSafeScopePath('C:\\')` 均返回 `true`。正则改为 `/^[A-Za-z]:(?:\/|$)/`。
  - 新增回归 13 条：git「case-only rename」2 条、「file → same-name directory」2 条、「unrelated staged entry / unborn HEAD」2 条、「restore tracked to head per-path」2 条；scope「dangling symlink capture」1 条、「root sensitive」1 条、「Windows drive root」1 条；rollback「failed retry coverage」1 条；loop「residue outside finishing scope」1 条。全量 `vitest run`：126 文件 / 1964 条通过（+13）。
  - 变异验证 9 处（把修复临时改坏 → 对应测试变红 → 还原）：强制回到带 pathspec 的提交 → 4 条红；去掉「无关暂存」分支（总是无 pathspec 提交）→ 2 条红；去掉大小写别名归属 → 1 条红；补丁捕获退回 `access`/`stat` → scope + rollback 各 1 条红；重置忽略逐路径覆盖 → 2 条红；回退不传 `coveredPaths` → 2 条红；residue 恢复 scope 限制 → 1 条红；`isSensitivePath` 退回空串判断 → 1 条红；盘符正则退回 → 1 条红。另有 1 处「已暂存删除 + 大小写别名/同名目录就跳过 `git add`」单独改坏不会变红：新提交策略本身已绕开 `--only`，该判断保留为纵深防御（当前可复现形状下不是唯一防线）。
  - 仍存偏差：与第九～十一轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。

- 第十三轮评审修复（P1×1 + P2×2，逐条 TDD + 变异验证）：
  - **P1-1 文件→同名目录替换会误提交目录下未声明的文件**：HEAD 的已追踪文件 `a.ts` 被同名目录替换时，旧实现把 `a.ts` 当目录目标。① 已暂存删除（`git rm a.ts`）分支不把它交给 `git add`，但 `ownedByTarget('a.ts/secret.ts', ['a.ts', …])` 仍按 `${target}/` 前缀把它判成本任务条目，`unrelated` 因此漏掉人工预暂存的 `a.ts/secret.ts` 并把整目录提交；② 未暂存删除（`rm a.ts && mkdir a.ts`）时 `a.ts` 不在 `stagedDeletions`，直接进入 `stageable`，`git add -A -- a.ts` 递归暂存目录内全部文件（含 `a.ts/secret.ts`），提交阶段再按前缀归属一并提交。修法：① 新增 `trackedFileAt()`（`cat-file -t HEAD:<path>` 非 `tree`，或未提交仓库下 `ls-files` 有精确文件条目）识别「文件→同名目录」替换；这类路径是**文件删除项**而非目录目标——已暂存删除保持原样，未暂存删除只用 `git update-index --force-remove -- <path>` 记录删除，绝不把该路径交给 `git add -A`。② `ownedByTarget()` 新增 `exactTargets`（`stagedDeletions` ∪ 新识别删除项）：删除项只按精确路径（含 `core.ignorecase` 下的精确大小写等价）归属，禁止 `${target}/` 前缀展开；合法目录目标兼容尾随 `/`，与 `presentInIndex` 对齐。③ `commitTargets()` 透传 `exactTargets`。
  - **P2-1 回退重试失败文案把 `refused`/`removed` 也算进「已重置到 HEAD」**：`restoreTrackedToHead()` 返回值新增 `reset`（只记录 `checkout HEAD` 成功的已追踪路径，checkout 失败不计入）；`rollback.ts` 的重试失败文案改为三类独立展示——「N 个已追踪脏文件已重置到 HEAD」「N 个 HEAD 中不存在的脏副本已移除」「<path> 没有备份，未删除」，`reset` 为空时不再出现「已重置」。可复现形状（未声明的嵌套仓库目录 `sub/`：git 只报 `?? sub/`，`git add -N` 拒绝、补丁无法覆盖）：旧文案「本任务 scope 内 1 个脏文件已重置到 HEAD；sub/ 没有备份，未删除」自相矛盾，新文案只报「1 个已追踪脏文件已重置到 HEAD；sub/ 没有备份，未删除」。
  - **P2-2 已确认存在无关暂存时，索引定位失败会回退为无 pathspec 提交**：`commitTargets()` 执行到 `rev-parse --git-path index` 时，`unrelated.length > 0` 已证明索引里有别人的暂存条目；旧代码在命令失败或返回空时回退 `commitIndex()`（无 pathspec），会把无关暂存一并提交。改为直接返回失败（失败时透传 `rev-parse` 的 `GitResult`；空输出时构造 `{ code: 1, stderr: 'unable to locate git index' }`），由 `commitPaths()` 抛错、任务回到 `IN_PROGRESS`。
  - 新增回归 7 条：git「file → same-name directory with an undeclared child」3 条（已暂存删除 + 人工预暂存、已暂存删除 + 未跟踪、未暂存删除 + 未跟踪）、「directory target with a trailing slash」1 条（与 `presentInIndex` 对齐；改坏后任务自己的 `tasks.json` 会被当成无关暂存重置出临时索引）、「index location fallback」1 条（`rev-parse` 失败与空输出两种形态，用只拦截 `rev-parse --git-path index` 的 PATH 包装脚本）、「restore tracked to head」新增「只有成功 checkout 才算 reset」1 条并给既有 2 条补 `reset` 断言；rollback「retry failure message」1 条。全量 `vitest run`：126 文件 / 1971 条通过（+7）。
  - 变异验证 7 处（把修复临时改坏 → 对应测试变红 → 还原）：去掉 `entry.directory`（文件删除项判定）→ 2 条「未声明子文件」用例红；关闭文件→目录检测（`trackedFileAt` 恒 false）→ 未暂存删除用例红；`exactTargets` 置空（删除项按前缀展开）→ 人工预暂存用例红；`ownedByTarget` 去掉尾随 `/` 归一化 → 尾随斜杠目录目标用例红；回退到旧的「dirtyScoped.length 个脏文件已重置」文案 → 2 条 rollback 用例红；`reset` 直接返回全部入参 → 4 条用例红；索引定位失败回退无 pathspec 提交 → P2-2 用例红。
  - 仍存偏差：与第九～十二轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。另：文件→同名目录替换时，目录内的子文件必须由任务单独声明（`paths`/scope 命中）才会进入检查点；删除项目标本身绝不按目录前缀授权。

- 第十四轮评审修复（P0×1 + P1×1 + P2×1，逐条 TDD + 变异验证）：
  - **P0-1 已追踪 submodule 被误判为「文件被同名目录替换」，提交时会整体删除子模块**：`trackedFileAt()` 原先用 `git cat-file -t HEAD:<path>`（gitlink 的 commit 在子模块 ODB 里，父仓查不到 → code 128；恰好存在时返回 `commit`）并以 `git ls-files -z` 的同名条目兜底，而已检出的 submodule 在工作区本来就是目录，于是任务正常推进子模块版本（`M sub`）被当成「文件→目录替换」，`commitPaths()` 跳过 `git add`、改跑 `git update-index --force-remove -- sub`，静默提交 `D sub`（删除整个子模块）并留下未追踪目录 `?? sub/`。修法：先 `git ls-tree -z HEAD -- <path>` 解析 `<mode> <type> <sha>\t<name>`，仅当精确同名且 `type === 'blob'`（`100644`/`100755`/`120000`）才算文件，`type === 'commit'` / mode `160000`（gitlink）与 `tree` 一律 false；只有无 HEAD（unborn）或 `ls-tree` 无精确匹配时才回退 `git ls-files -s -z`，解析 `<mode> <sha> <stage>\t<name>`，同名且 mode `160000` 仍为 false。`ls-tree` 不访问子模块 ODB，比 `cat-file -t` 安全。
  - **P1-1 `presentInIndex()` 未与 `ownedByTarget()` 对齐尾随 `/` 语义，未追踪嵌套仓库被丢弃并残留在暂存区**：生产上唯一带尾随 `/` 的路径是未追踪嵌套仓库 `nested/`（`git status` 只报 `?? nested/`），`git add -A -- nested/` 以 gitlink 条目 `nested`（无尾随 `/`）入索引，`presentInIndex(index, 'nested/')` 恒 false → 该路径在进入 `commitTargets()` 前即被过滤，只提交 `tasks.json`，`A nested` 永久残留在真实暂存区（`paths` 只有它时返回 `{created: false}`），`enforce` 下后续任务持续把它当越界改动。修法：同步剥离尾随 `/` 并先判 `index.has(base)`，空 base 直接 false，其余走子项前缀；`ownedByTarget()` 上一轮的归一化注释从此名副其实。
  - **P2-1 `restoreTrackedToHead()` 吞掉 `git checkout HEAD` 失败项，二次失败文案失真**：某路径存在于 HEAD 但 checkout 失败（权限受限 / 文件被锁 / 同名目录占位）时，旧实现既不计入 `reset`，也不进 `removed`/`refused`；若 `dirtyScoped` 只有这类路径，文案会拼出「本任务 scope 内没有可重置的脏文件」，掩盖「实际有脏文件且重置失败」。修法：`RestoreTrackedResult` 新增 `failed?: readonly string[]`，checkout 失败即记入；`rollback.ts` 如实展示「`x.ts` 重置到 HEAD 失败」，并把兜底文案改为「本任务 scope 内没有成功重置的脏文件」。
  - 新增回归 7 条：git「advancing a tracked submodule commits M sub, never D sub」1 条、「an unborn branch does not mistake a staged gitlink for a replaced file」1 条、「a committed directory target is not a replaced file」1 条、「an untracked nested repository reported with a trailing slash is committed」1 条、「a failed checkout is reported instead of being silently dropped」1 条；rollback「a checkout failure is reported as a failed reset」1 条、「the fallback text does not claim there was nothing dirty to reset」1 条。全量 `vitest run`：126 文件 / 1978 条通过（+7）。
  - 变异验证 7 处（把修复临时改坏 → 对应测试变红 → 还原）：`trackedFileAt` 退回 `cat-file -t` + `ls-files -z` 旧实现 → submodule 用例红；索引回退去掉 `160000` 排除 → unborn gitlink 用例红；`ls-tree` 分支把 tree 也当文件 → 已提交目录用例红；`presentInIndex` 退回字面比较 → 嵌套仓库尾随 `/` 用例红；checkout 失败不记 `failed` → git 级用例与 rollback「重置失败」用例同红；`rollback.ts` 略过 `failed` 展示 →「重置失败」用例红；兜底文案退回「没有可重置的脏文件」→ 兜底文案用例红。
  - 仍存偏差：与第九～十三轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。另：submodule 按 gitlink 精确提交（`M sub`），子模块内部未提交内容不进入父仓检查点；文件→同名目录替换仍只按任务声明的子路径提交，删除项目标本身绝不按目录前缀授权。

- 第十五轮评审与真机复查修复（评估器可靠性/证据面 + 锚点与未来任务范围收口，TDD + 变异验证）：
  - **评估器低推理强度与错误透明化**：`evaluateTask`、`evaluateProgress` 与 `milestone.ts` 统一通过 `prepareCall(..., configureLowestReasoning)` 选取适配器最低推理强度（`model.reasoning.efforts[0].id`），并将主评估 `maxTokens` 提升至 `4000`，避免推理 token 吃满输出上限导致空文本/截断触发「不可解析」；同时检查 `assembler.finish` 的终态 `error`/`aborted` 块；`:179`/`:189`/`:191` 如实回填真实 `model`、`latencyMs` 与截断后的真实异常消息，缺失路由时细分 `llm.prepareCall` / `provider` / `model`。
  - **评估器补齐确定性证据面**：`buildEvalCandidate()` 将探针定义与结果摘要、scope 内变更路径与有界 diff/文件摘录（`scopeDiffExcerpt`，上限 4000 字节）以及 `tasks/<ID>/notes.md` 尾部摘录一并传给评估器，解决「只看 `{ C1: pass }` 与最后三条文本导致盲判 `insufficient`」的根因。
  - **拆出 `unavailable` 第三态与目标 hash 异常直阻**：评估器自身故障（缺路由 / 超时 / 传输错 / 不可解析）不再伪装成有效判定，写入带 `reason`/`streak` 的 `eval.unavailable` 事件，**不消耗 `attempts`**、**不推进 `lastEvalScopeHash` 与 `lastEvalOffset`**；`evalUnavailableStreak` 落盘到 `GuardTask`，连续 3 次不可用即阻塞并展示真实原因，任一有效判定或 `rollbackRun` 重开任务时清零。`goal_hash` 不匹配（`goalHashMismatch: true`）归为完整性异常直接阻塞，不走故障重试。
  - **状态签名收敛**：有效 `fail`/`insufficient` 判定记录 `eval.done.reason`（`missing[0]` → `violations[0].why` → 未满足 `criteria` → `correction`）；阻塞签名改为 `digest({ kind: 'eval-not-pass', scopeHash, probeVector })`，去掉模型措辞与 `fail`/`insufficient` 交替差异，同一工作区连续三次未通过稳定进入 `progressDecision`。
  - **修补 `d127f78` 两处缺陷**：① `anchor.ts` 的「其他任务 scope（不是你的）」排除 `runningTasks` 自身，首轮/切换轮不再把当前 `TODO` 任务列为「不是你的」；② `loop.ts` 的未开始任务豁免仅限工作区未提交文件，已提交进 `baseCommit..HEAD` 的未来任务路径（`committedPathsSince`）不再豁免，避免破坏后续任务的 `baseCommit` 与回退链路。
  - **大脏工作区 `baselineDirty` 截断与补丁性能修复**：① `git.ts` 移除 `dirtyHashes()` 的默认 `limit = 200` 静默截断，改为 32 并发全量采集，并将 git 命令 `maxBuffer` 提至 32 MB，避免存在数千个未跟踪构建缓存文件时超 200 条的既有文件在 `enforce` 下全部误判为 `scope 外改动`；② `schema.ts` 增加 run 级共享 `GuardState.baselineDirty`（>50 条时仅存一份，不再复制到每个任务行），`matchesTaskBaseline()` 兼容旧台账逐任务 `baselineDirty`；③ `blockTask` 与 `rollbackRun` 在调用 `captureBlockedPatch` 前过滤未变化的基线文件，避免阻塞/回退补丁扫入数千个既有缓存。
  - **交接 Skill 补齐督导选项建议**：`src/host/handoff-skill.ts` 在督导运行段新增「选项建议」模板块与判断准则，要求每次明确给出「严格模式」与「独立 worktree」两项勾选建议及理由。

- 第十六轮真机缺陷修复（worktree 会话掉进「未分组」+ 上一轮 Code Review 收口，逐条 TDD + 变更验证）：
  - **P1 真机缺陷：勾选「在独立 worktree 中运行」后，新建的锚定会话在侧栏被归到「未分组」**。根因不是插件少写了一次登记，而是**归组规则**：DSH 只把会话算进某个工作区，当且仅当 `session.header.cwd` 的 `realpath` 精确等于该工作区的 `path`（`Workspace.entity.attachSession` 与 `candidateMatches` 同一条规则）；旧实现为了隔离把 header `cwd` 直接建成 `<源项目>/.guard/worktrees/<run-id>`，于是「不在任何工作区」是必然结果。修法（不再登记工作区，仍满足「不新建 DSH 工作区」的约束）：① 新建会话的 header `cwd` 取**源项目**，并照常 `attachSession` 到源工作区——侧栏分组回到项目下面；② 建会话后立刻用 Host 的 `ctx.workingDirectory.set(agent, <worktree>)` 把**有效目录**切到隔离检出，DSH 会落一条 `workspace-root/change`（持久化、重开沿用），模型看到的 `Current working directory`、写边界、文件视图与探针根目录都是检出；③ `workingDirectory` 服务缺失时**在建会话之前**失败（`working-directory-unavailable`），绝不留下一个未归组的孤儿会话；④ 台账/回退/冷启动定位改用新的 `effectiveCwdOf()`（`workingDirectory.get` 优先，header 兜底），否则改完 header 后 `guard.supervisor`、`guard.rollback`、`agent/created` 冷启动恢复都会去源项目找台账而「找不到 run」。相应地 `CarrierSessionRequest` 新增 `projectCwd`（header 目录），`cwd` 继续表示有效目录，所以探针、guard 写边界、台账路径等既有调用点语义不变。
  - **上一轮 Code Review 收口（同批落地）**：① 切换「独立 worktree」开关时清空 `preparedRunId`，且 `anchorStart` 优先认 `<源项目>/docs/guard/<runId>`，重试不会沿用旧 worktree；② `excludeRunWorktreeRoot` 先建 `.git/info` 再写 exclude 并显式抛错，且排在建 worktree 之前；③ `guardWorktreePath` 统一 `realpath` 规范化，兜底候选同样校验 `.git`；④ `prepareGuardRun` 在 `worktree: true` 时不再在主检出创建空 `docs/guard/`，并同时检查两侧 `runId` 冲突；⑤ 从无工作区归属的旧 worktree 会话发起新对话时给出可操作提示。
  - 新增/更新回归：channel「worktree 运行把 header 留在源项目、把有效目录切到检出、并挂到源工作区」1 条、「缺 `workingDirectory` 时在建会话前失败」1 条、「`guard.supervisor`/`guard.rollback` 走有效目录而不是 header」1 条、attach「冷启动按有效目录重挂 worktree run」1 条；`carrier.spec` 的 worktree 用例改为断言 `meta.cwd === 源项目` + 一次 `workingDirectory.set(<worktree>)` + `attachSession(新会话)`。
  - 变更验证 4 处（临时改坏 → 对应用例红 → 还原）：header 改回 worktree 路径 → 归组用例红；跳过 `workingDirectory.set` → 有效目录用例红；`effectiveCwdOf` 退回 header → supervisor/rollback 与冷启动用例红；缺少服务时改为建完再报错 → fail-closed 用例红。
  - 仍存偏差：与第九～十五轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。另：本次变更前创建的旧 worktree 会话 header 仍在检出差目录里，仍显示为「未分组」，只读可用但不再新建同类会话（新建一律走新路径）。

- 第十七轮真机复查修复（锚点预算优先级与记账 + 入参默认值 + 评估证据面，逐条 TDD + 变异验证）：
  - **P1 锚点预算把「进度/纠正/目标」挤掉，且截断记账恒等于 2048**：zenspace 真机会话的头/尾锚点里，`其他任务 scope（不是你的）` 把预算吃满后 `目标：` 被拦腰截断、`进度：0/7；状态：active` 整行消失，而 `state.jsonl` 只记下 `originalBytes: 2048 / keptBytes: 2046`，看起来像「只截了 2 B」。根因是两处：① `buildBody` 先整块写入任务块（含未来任务 scope）再轮到 `目标/进度/纠正`，顺序即优先级，次要信息反而先占额度；② `renderAnchorDetailed` 用 `budget - keptBytes` 反推 `dropped`，内部裁切后 `originalBytes` 恒等于预算值，把真实规模藏起来了。修法：把渲染拆成有优先级的段（`当前任务/scope/验收` → `纠正` → `进度` → `目标` → `其他任务 scope`），按优先级分配预算、按固定顺序输出；新增 `renderAnchorUnclipped()` 产出未裁切全文，`originalBytes` 直接取它的真实字节数，`truncated` 以「裁切后是否等于全文」判定。拥挤台账下现在是：运行任务、进度、纠正、目标全部保留，只有 `其他任务 scope` 让位。
  - **P2 对话框默认值不安全（真机两轮都漏勾 worktree）**：`supervisorWorktree` 默认恒为 `false`，即使工作区是 git 仓库、卡片纪律还写着「严禁直接提交到 main」，也没有任何默认或提示，两次真机运行都成了 in-place（其中 zenspace 那次在 `main` 上，靠模型自己切到 `dev` 才没污染）。修法：新增只读 op `guard.repo`（`git rev-parse`/`symbolic-ref`/`config`，不写任何东西、不建 run）返回 `{ isGit, branch, defaultBranch, remoteKind, remoteHost }`；对话框打开时读一次，**`isGit` 为真则默认勾选「在独立 worktree 中运行」**（人工取消后不再自动改回，`worktreeTouched` 记住选择）；GitLab/GitHub 远端在提示里点名；若取消且当前分支等于默认分支，显示「督导提交会直接落在 main」的告警。非 git 目录保持原默认，独立渲染（无 `readRepo`）行为不变。
  - **P2 评估器看不到 `agy_tool` 的写入路径**：`antigravity` provider 把外部 CLI 的每个工具活动回放成一次 `agy_tool`，参数是 `{ run, step, tool, input }`，而 `candidateOf` 只认 `write`/`edit` 的 `file_path`，于是这类会话的 `main_write_paths` 始终为空（只靠 git diff 与 notes 兜底）。修法：抽出 `toolArguments()`，对 `agy_tool` 按 `tool` 名称（`write|edit|patch|create|replace`）解包 `input.Path/path/file_path/FilePath/TargetFile` 后再截断入列；读取与 `run_command` 仍不入列。
  - 新增/更新回归 9 条：anchor「拥挤台账保留运行任务/进度/纠正/目标」1 条、「`originalBytes` 等于未裁切全文」1 条、「不裁切时三者相等」1 条；channel「`guard.repo` 报告分支/默认分支/GitLab 远端」1 条、「非仓库 answers `isGit:false`」1 条；client-ui「检测到 git 仓库默认勾选并说明原因」1 条、「默认分支取消后告警且尊重取消」1 条、「非 git 保持不勾选」1 条；候选证据「解包 agy_tool 写路径」1 条、「只读/命令不冒充写入」1 条。四 lane 53 文件 / 768 条全绿。
  - 变异验证 4 处（临时改坏 → 对应用例红 → 还原）：恢复「先写任务块再写 extras」顺序 → 优先级用例红；`originalBytes` 退回 `budget - kept` → 记账用例红；`isGit` 默认不勾选 → 默认勾选用例红；删掉 `agy_tool` 的解包分支 → 写路径用例红。
  - 仍存偏差：与第九～十六轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。另：`guard.repo` 的远端类型按 **host** 判断（自建 GitLab 域名不含 `gitlab` 时归 `other`），它只影响提示文案；是否默认勾选只看 `isGit`。

- 第十八轮真机闭环复查修复（已完成会话守卫退场 + 里程碑审阅可观测与超时预算，TDD + 变异验证）：
  - **P1 督导全部完成后，严格模式工具守卫未退场，导致已完成会话永久只读锁死**：x9Copy 完整跑通 T1–T7（`status: completed`、宿主目标 `complete`）12 秒后，主会话想更新 `tmp/x9-re-189/README.md` 仍被守卫连拦 3 次（`不在当前任务 scope 内`），因为 `checkTool` 未对 `live.status === 'completed'` 放行且完成后 `runningTasks(live)` 恒为空数组。修法：`attach.ts` 的 `checkTool` 在 `live.status === 'completed'` 时立刻返回 `undefined` 退场；`status === 'blocked'` 期间保持拦截；人类通过回退重开任务（`rollbackRun` + `refresh()` 回到 `active`）后守卫自动重新生效。
  - **P2 里程碑审阅（`review.milestone`）在两条真机会话里 3/3 静默退化为 `insufficient` 且 `review/` 空目录**：`milestone.ts` 之前对 3 位并行审阅者硬编码 30s 超时且无重试、`maxTokens` 仅 1200/800，且任意 1 位超时或返回非 JSON 即整体返回 `null`、不写 `review/round-<n>.md`、`state.jsonl` 不记原因。修法：`MILESTONE_TIMEOUT_MS` 对齐 `EVALUATOR_TIMEOUT_MS`（60s），`maxTokens` 提至 2500/1500；每次审阅/裁决失败自动重试一次（独立超时信号并检查 `assembler.finish`）；仅当无 LLM 路由时返回 `null`（且 `loop.ts` 记 `reason: '审阅模型不可用'`），单个审阅者或裁决者超时/不可解析不再丢弃其余结果，而是保留已得结论、把具体失败原因写入 `review/round-<n>.md` 与 `state.jsonl`（`review.milestone` 新增可选 `path`/`reason` 字段）。
  - 新增/更新回归 3 组：attach「完成后守卫退场、阻塞态保持拦截、回退重开后重新生效」；evaluator「60s 预算 + 瞬时失败重试转 pass + 单审阅者超时落盘诊断报告 + 裁决者超时落盘诊断报告」；loop「不可解析里程碑同样写入 `review/round-1.md` 与 `state.jsonl` 的 `path`/`reason`」。
  - 变异验证 2 处（临时改坏 → 对应用例红 → 还原）：移除 `live.status === 'completed'` 放行 → attach 退场用例红；将 `milestone.ts` 失败审阅者退回 `return null` → evaluator 与 loop 诊断报告用例红。

- 第十九轮真机复查修复（收口后的会话必须能继续工作，run 级护栏不等于会话终身锁）：
  - **P1 收口后锚点仍在发号施令，模型因此拒绝用户的新需求**：x9Copy 真机 `7/7 completed` 之后，用户提出新需求（「A，逆向后的程序还是放在 M4…」），模型先调 `create_goal` 被守卫拦（`这次运行已经有督导目标；不要另建 goal`），随后判定「本次 run 已收口，guard 不允许再新建 goal，需要开新 run」并只输出交接卡，不再执行——即使工具守卫已退场，`renderAnchor` 在 `status: completed` 时仍在注入 `不要中途向用户提问`/`只改本任务 scope 内的文件`/`完成声明只能由主会话写`/`工具守卫已硬拦` 等 run 级硬规则，且「当前任务：（全部完成）」没有任何「新需求怎么办」的出口。修法：`anchor.ts` 在 `state.status === 'completed'` 时改渲染**收口锚点**——`当前任务：（全部完成 n/m）` + 「任务表、scope、探针与逐任务提交规则不再生效」+「新需求按普通会话处理：可以直接改文件、执行命令，也可以新建 goal 或新的督导运行」+「台账只作历史」+ 停止条件，不再出现 scope/完成声明/工具守卫字样；`checkTool`（上一轮）与 `auditTurn`（`status !== 'active'` 直接返回）本就已退场，三者一起保证收口后会话恢复为普通会话。
  - 新增回归 2 条：`anchor.spec`「收口后不得再出现 scope/完成声明/工具守卫硬规则，且必须写明可以直接改文件/新建 goal」与「`blocked` 运行仍保留任务规则与纠正行，不被收口分支误伤」。
  - 变异验证 1 处：把 `state.status === 'completed'` 分支去掉 → 两条收口用例红。
  - 仍存偏差：与第九～十八轮相同（工作区内软链在 `enforce` 下一律拒绝；旧台账跨兄弟检查点回退显式拒绝而非猜测；并行任务仍共享 run worktree，`parallel` 默认 1）。另：收口后不再自动提交/打 tag，新需求产生的改动需要用户自己 commit。

- 第二十轮：评估器失败可见 + 阻塞后一键继续（模型回退链的第 1 步）。
  - **评估器失败按 DSH 失败码透出，不再统一写成“不可解析”**：`evaluator.ts` 的 `finishFailure` 保留 `LlmFailure.code`（`EMPTY_RESPONSE`、`QUOTA`、`RATE_LIMIT`、`AUTH`、`TIMEOUT`、`TRANSPORT` 等），终态错误与两侧评估分别给出 `模型未返回任何文本（EMPTY_RESPONSE）` / `评估调用失败（<code>）`；这正是 zenspace 真机阻塞的原因——agy 桥接型 provider 对“一次性、无工具、严格 JSON”的请求返回零内容块，而旧文案把它和“JSON 写坏了”混为一谈。
  - **新增只读以外的恢复动作 `guard.continue`**（通道 op + 卡片按钮「继续运行」）：清除 `goalBlocked`、把 `BLOCKED` 任务改回 `IN_PROGRESS`、清空 `evalUnavailableStreak`，**保留全部 attempts 与 `baseCommit`**，随后 `refresh()` 并 `resumeSupervisorGoal` 让下一回合继续同一任务；与 `guard.rollback` 的语义区别写进代码注释与卡片文案（回退会重开任务并恢复 scope，继续只清阻断）。事件新增 `run.resumed` 与既有 `task.unblocked`。
  - 回归 4 组：evaluator「空回复必须报 `EMPTY_RESPONSE` 而不是不可解析」；channel「`guard.continue` 清阻断且保留 attempts / 未阻断时拒绝」；client「阻塞卡片出现「继续运行」、单击即调用且不触发回退」。

- 第二十一轮：模型角色拆分（执行/评估各自主+回退，含推理等级）与视觉取证。
  - **数据模型**：新增 `ModelRoute { provider, model, reasoningEffort? }`；`GuardState` 增加 `evaluatorFallback`、`executor`（创建时冻结）、`executorFallback`、`activeExecutor`（运行期当前值）、`visual { enabled, route?, fallback? }`。全部可选，旧台账零迁移。
  - **失败按码路由**（`failure-policy.ts`）：`EMPTY_RESPONSE / MALFORMED_RESPONSE / INVALID_RESPONSE / TIMEOUT / TRANSPORT / SERVER / STREAM_CLOSED / RATE_LIMIT` 以及 `HTTP_404/408/429/5xx` 换下一个模型；`AUTH / INVALID_CREDENTIAL / MISSING_CREDENTIAL / UNKNOWN_MODEL / MODEL_UNSUPPORTED / CONTENT_REFUSED / CONTEXT_WINDOW_EXCEEDED` 只报清楚。`QUOTA / ACCOUNT_QUOTA` 仅在**跨 provider** 回退时切换——同 provider 换模型救不了额度。
  - **评估器与里程碑**：`resolveEvaluatorRoutes` 给出有序路由链，每个路由保留原有的两次尝试；发生切换写 `eval.fallback{role, from, to, code}`，`eval.done`/审阅结论仍记录真正裁决的模型。推理等级过高时 `max-tokens` 会被识别并升一次输出预算，而不是报成“不可解析”。
  - **执行模型**：`anchor.start` 记录 `activeExecutor`；新增 `guard.switch{role:'executor'|'evaluator', route?, resume?}`。执行角色走 `agent.model.select`（字段是 `reasoningEffort`），评估角色写台账；两者都只在回合空闲时接受、失败时不清理阻塞，并分别写 `executor.switched` / `evaluator.switched`。卡片在阻塞时提供「继续运行」「换执行回退模型并继续」「换评估回退模型并继续」。
  - **对话框**：执行/评估各增回退 picker（含推理等级），评估“跟随主会话”时也可选等级（同模型不同推理）；评估选到 CLI 桥接型 provider（`antigravity`）时显示硬提示；视觉取证默认关闭，启用后可选 witness 模型（默认跟随评估模型）。
  - **视觉取证（P3）**：`visual.witness` 只做观察，不给结论——`runVisualWitness` 从本任务相对 `baseCommit` 新增/修改的 png/jpg/webp 中取最多 5 张（单图 ≤1 MiB，经 `attachments.saveImages` 入库），以 `{type:'image'}` 块随判据发给 witness 模型，要求输出 `findings[{criterion,severity,what,where}]`；结果落 `tasks/<ID>/evidence/visual-<ts>.json` 并写 `visual.witness` 事件（含图片路径与 sha256）。witness 未启用→不加证据；启用但无截图/无模型/空回复→`result:'unavailable'`，评估器据此只能判 `unknown/insufficient`，**绝不可 pass**。prepare 阶段用 `resolveModelInfo().inputModalities` 预检 witness 是否声明图片输入。

- 第二十二轮：按 Code Review 修复 P0/P1/P2（视觉取证接线、评估回退战术、切换竞态）。
  - **视觉取证真正接入裁决**：`promptOf()` 现在序列化 `visual_witness`（`result/model/images/findings/summary`，不可用时带 `reason`），评估器因此能区分“有观察记录”和“没检查过”；`loop.ts` 另加**确定性否决**——任务验收含视觉条目且 witness 缺失/不可用时，即使模型判 `pass` 也强制改判 `insufficient`（插件拥有这条规则，不交给提示词）。
  - **视觉取证不再误伤非 UI 任务**：只在任务验收含视觉判据（截图/UAT/画面/渲染/贴图/穿模/HUD/preview/render…）或本任务改动了图片时才取证；run 级开关不再把纯重构任务变成永远无法通过。
  - **截图采集修正**：`buildEvalCandidate` 返回独立的未截断 `imagePaths`（git 可见改动优先，其次 ignored），读盘上限放宽到 20 MiB 交给附件服务归一（1080p 截图常 >1 MiB，旧的 1 MiB 硬丢弃会误报“无截图”）；`ignoredScopePaths` 的 `(N B)` 后缀不再污染路径匹配；`visitor` 目录/文件名改用 `dirname`/`basename`。
  - **评估回退更可靠**：`UNPARSEABLE` 与 `MAX_TOKENS` 纳入可切换码；空文本归类为 `EMPTY_RESPONSE`；`max-tokens` 只在首次升预算、二次仍明确报 `MAX_TOKENS`（不再落成“不可解析”）；确定性失败（额度/鉴权/未知模型等）**不再同路由重试第二次**；里程碑任一评审者失败即可切回退，裁决者失败也可换路由；`evaluateProgress` 同样接入路由链。
  - **卡片与状态**：`evaluatorFallbackModel` 不再被“没有独立主评估模型”遮蔽；阻塞卡片在**没有预设回退**的 run 上提供显式评估模型下拉（`carrier.models` + `guard.switch` 显式 route）——这是 zenspace 这类旧 run 的唯一界面出口；失败提示按动作区分「回退失败 / 继续运行失败 / 切换模型失败」，不再一律写成回退失败。
  - **切换与写台账竞态**：`guard.switch` 的读、校验、`model.select`、写台账全部收进会话锁；`store.mutate()` 提供锁内 read-modify-write；`recordActiveExecutor` 改走 `mutate`；`resumeSupervisorGoal` 只在 `resume: true` 时调用；`resumeBlockedRun` 不再往 `GuardTask` 写不存在的 `updatedAt`，并保留并行批次里其他 `activeTaskIds`。
  - **对话框**：评估“跟随主会话 + 指定推理等级”现在作为显式评估路由提交（此前静默丢弃）；`prepared` 缓存依赖补齐（执行模型/两级回退/视觉开关与路由）；桥接型警告覆盖“执行模型是 antigravity 且评估跟随主会话”以及回退/视觉路由；视觉取证新增回退模型选择。
  - 回归：evaluator「prompt 携带 visual_witness」「空回复→EMPTY_RESPONSE 回退」「二次截断→MAX_TOKENS 回退」；status「跟随模式仍暴露评估回退」；channel「witness 路由未声明图片输入时 prepare 拒绝」；loop「只有视觉验收才要求取证」；client「继续失败不写成回退失败」「阻塞且无回退时可选模型切换」「桥接执行模型+跟随评估仍告警」「跟随模式等级随显式路由提交」。

- 第二十三轮：按第二轮 Code Review 修复 P0/P1/P2（默认关闭的视觉取证不得否决、超时识别、阻塞中途下拉、切换锁边界、文案去重）。
  - **默认关闭的视觉取证不再否决任务**：`loop.ts` 的 `visualRequired` 现在同时要求 `state.visual?.enabled === true`；未启用的 run 即使验收含 `UAT/render` 也不会把模型 `pass` 改判 `insufficient`。验收词表同步收紧：英文词加词边界（`\brender\b`/`\bpreview\b`/`\bscreenshot\b`/`\bvisual\b`/`\bUAT\b`/`\bHUD\b`），`mock` 改为 `mockup`，不再把“mock 数据单测”误判成截图验收。
  - **超时按 TIMEOUT 归类**：`AbortSignal.timeout()` 抛的是 `DOMException{name:'TimeoutError', code: 23}`，`typeof code === 'string'` 会把超时看成“无失败码”，导致 `tryEvaluatorRoute` / `evaluateProgress` / `milestone.callModel` / `runVisualWitness` 四处都不切回退。四处 catch 改为 `attempt.aborted ? 'TIMEOUT' : …`（变量名按各处实际写法），`tryEvaluatorRoute` 的 catch 也补 `isDefinitiveFailure` 短路。
  - **阻塞中途出现时加载显式评估下拉**：`contextView` 的 `carrier.models` effect 依赖 `blockedRun`（run status 或任一 `BLOCKED` 任务）而不是只看 run status；下拉补推理等级选择（随 `guard.switch` 的 route 提交），已配置回退时也不再隐藏该入口，切会话时重置所选目标与等级。
  - **`guard.switch` 的锁边界**：`anchorGate` 在会话锁内复查；`resumeBlockedRun` 未真正清除阻断时不再调用 `resumeSupervisorGoal`，避免唤醒人工暂停的 goal。
  - **对话框**：切换执行模型清空评估推理等级（旧等级可能不被新模型支持）；视觉路由只在视觉取证启用时参与桥接告警；视觉回退 picker 独立成行并补标题/说明（中英双语）。
  - **判定证据与文案**：`validatePrepareRoutes` 的视觉主路由在“视觉与评估都跟随”时落到执行模型；`visual_witness` 移入 `CANDIDATE` 并在未启用时省略；`eval.fallback` 与失败模型名改用 `routeLabel`（同模型不同等级不再 `from===to`）；视觉取证 `EMPTY_RESPONSE`/`MAX_TOKENS` 文案去重、`max-tokens` 先升预算到 5000 再重试；里程碑裁决失败文案按 `includes(code)` 去重。
  - 回归：loop「视觉取证关闭 + UAT/render 验收仍可 pass」「mock 单测不算视觉验收」；evaluator「AbortSignal 超时→TIMEOUT 切回退」（任务/进度/里程碑）「回退标签含推理等级」「prompt 的 visual_witness 在 candidate 内且未启用时省略」「裁决失败码不重复」；visual「超时切回退」「EMPTY_RESPONSE 不重复」「首次截断升预算」；channel「视觉跟随评估再跟随执行时校验图片模态」「未阻断时 resume 不唤醒 goal」「锁内复查回合门」；client「任务中途 BLOCKED 时下拉加载」「下拉提交推理等级」「已配置回退仍显示下拉」「切换执行模型清空评估等级」「视觉关闭不再触发桥接告警」「视觉回退独立行」。

- 第二十四轮：按第三轮只读 Code Review（Gemini，0 P0 / 5 P1 / 5 P2）修复。
  - **里程碑闸门不可被绕过**：`GuardState` 新增 `goalBlockKind: 'milestone' | 'unrunnable'`；`maybeMilestoneReview` 写 `milestone`，`settle()` 写 `unrunnable`（恢复 runnable/完成时两者一起清）。`resumeBlockedRun` 的判定抽成纯函数 `canResume(state)`：无 BLOCKED 任务的 run 级阻断里，`milestone`、旧台账的「里程碑审阅未通过」文案、或全 DONE，一律返回 `milestone-pending`——多任务 run 在第 1 轮审阅失败（T4-T6 仍 TODO）时不能再用「继续运行」清阻断跑过去。
  - **`guard.switch{resume:true}` 先预检后落盘**：锁内读到 state 后先用 `canResume` 判定，milestone-pending 在任何副作用（`model.select`、写台账）之前拒绝；写入后的 resume 若仍被拒（审计并发写入了失败审阅），回复带 `resumeRefused` 而不是报「切换模型失败」，且无论成败都 `refresh()` 活动附件，避免 UI 显示旧快照。
  - **`goalResumed` 前端可见**：`guard.rollback` 也返回 `goalResumed`；卡片把 `goalResumed:false` 存进独立状态（不被 3 秒轮询覆盖，切会话或下次成功动作清除）并显示「台账已恢复，但宿主 goal 未恢复（可能已达轮次上限）」；`resumeRefused` 单独显示「模型已切换，但 run 仍无法继续」。中英双语新增键。
  - **评估器全路由失败保留 `fallbacks`**：`insufficient()` 透出 `fallbacks`，主 + 回退都失败时 `loop.ts` 仍能写 `eval.fallback`。失败策略补 `CLIENT_UPGRADE_REQUIRED`、`INVALID_CONFIG` 与不可切换的 `HTTP_4xx`（404/408/429 除外）为确定性失败；`describeEvalFailure` 与两处 catch 按 `includes(code)` 去重。
  - **写台账不再盲写**：`store.mutate` 的回调可返回 `{ state, events } | null`，在同一次锁内完成 tasks.json → state.jsonl → TASKS.md；无变化且无事件时短路不写盘。`loop.ts` 的落盘统一走 `mergeRuntimeConfig(next, current)`（`evaluator`/`evaluatorFallback`/`executor`/`executorFallback`/`activeExecutor`/`visual` 以锁内最新台账为准），耗时审计不再覆盖并发热切；`resumeBlockedRun` 的 `run.resumed` / `task.unblocked` 与状态同一次提交。
  - **视觉链路**：`guard.prepare` 先解析源会话，把 `source.config` 作为视觉主路由的最后兜底校验 `inputModalities`；`guard.switch` 在「执行模型切换 + 未配置独立评估模型 + 视觉跟随」时同样校验图片输入。git 可见截图也按 `mtimeMs` 降序后再交给 witness（最多 5 张）。
  - **归属与台账安全**：`ownershipGate` 对缺失的 `run.json` 返回明确错误而不是放行；`anchor.start` 在 `recordActiveExecutor` 之前校验 `run.json` 存在、未被其他会话挂载（同一 operationId 的重试除外）且 phase 可启动。
  - **卡片**：切会话重置 `switchModels`；操作区与模型下拉统一用 `blockedRun`（`status: blocked` 但无 BLOCKED 行也会出现「继续运行/回退」）；初始即 `agentLive:false` 不拉模型目录；评估回退说明改为「同 provider 额度/鉴权只报清楚、跨 provider 额度不足允许切换」。
  - 回归：loop「中途里程碑失败不可 continue」「旧台账仅凭文案同样拒绝」「resume 清除 goalBlockKind」「运行时配置合并不覆盖并发热切」「git 可见截图 newest-first」；store「mutate 同锁写 state+events」「无变化/null 短路不写盘」；evaluator「主+回退全失败仍带 fallbacks」「失败码不重复」；failure-policy「CLIENT_UPGRADE_REQUIRED/INVALID_CONFIG/HTTP 4xx」；channel「里程碑阻断时 switch 预检零副作用」「run.json 缺失显式拒绝」「prepare 视觉主路由落会话模型」「执行模型切换校验图片输入」；carrier「anchor.start 拒绝他人挂载的 run 与不可启动 phase 且不改台账」；client「goalResumed:false 提示跨轮询保留（continue/switch）」「resumeRefused 不写成切换失败」「status blocked 无 BLOCKED 行也有操作区」「初始 agentLive:false 不拉目录」「切会话丢弃旧目录」。

- 第二十五轮：按第四轮只读 Code Review（Gemini，0 P0 / 1 P1 / 4 P2）修复。
  - **并行态里程碑闸门**：`canResume` 的里程碑判定移出「无 BLOCKED 任务」分支——`goalBlockKind === 'milestone'`（或旧台账文案、或全 DONE）无论是否存在 BLOCKED 兄弟都返回 `milestone-pending`；`status: 'blocked'` 且既无 `goalBlocked` 也无 BLOCKED 行的台账不再判 `not-blocked`，与前端「继续运行」口径一致。
  - **回退不清里程碑闸门**：只回退 BLOCKED 兄弟（`reopeningDone === false`）时保留 `goalBlocked` / `goalBlockKind` / `status: 'blocked'`；只有重开 DONE 任务（审阅对象回到在途）才清除。
  - **写台账失败显式中止**：`persist()` 返回 `GuardState | null`；`store.mutate` 在台账被删时返回 `null`，`finishTask` / `auditTask` / `settle` / 里程碑审阅一律中止，不再提交、打 tag 或完成 goal；调用点改用返回的合并态（`maybeMilestoneReview` 看到的是锁内最新 evaluator）。`rollbackRun` 改走 `store.mutate` 并合并 6 个运行期字段；仅当本次回退自己把 `tasks.json` 从历史里 revert 掉时，允许用回退前快照重建台账。
  - **提示生命周期**：`goalResumeHint` / `resumeRefused` 在下一次动作发起时清空；轮询看到 `status: 'completed'` 或 `done` 增长也清空（读取失败不清）。
  - **卡片**：run 级 `blockedReason` 与 BLOCKED 任务的 `blockedReason` 不同时同时显示，相同时才合并。
  - 回归：loop「并行 BLOCKED 兄弟不绕过里程碑」「纯 status-blocked 可恢复」「台账消失时 pass 写入中止（无 commit/tag/goal）」「审计写入合并并发热切换」；rollback「只回退 BLOCKED 兄弟保留里程碑闸门」「回退合并运行期切换」「回退自己 revert 掉台账时重建」；channel「continue/switch 并行里程碑零副作用」「resume 在并发里程碑写入后被拒时报 `resumeRefused`」；contextView「不同原因的 run 级阻断同时显示」「拒绝横幅跨轮询保留」「完成/推进清空旧提示」「新动作失败前清空旧拒绝」。

- 第二十六轮：交接技能补齐督导运行的全部六项选项建议（此前只给「评估模型 / 严格模式 / 独立 worktree」三项，与对话框里的六组控件不对齐）。
  - `src/host/handoff-skill.ts` 的「选项建议」模板扩为六项：独立评估模型（含推理等级）、执行回退模型、评估回退模型、启用视觉取证（含多模态 witness）、严格模式、独立 worktree；并补每条判断准则：CLI 桥接型 provider 不能当评估器（无工具 JSON 请求易空回复→反复 `insufficient`）、回退只有跨 provider 才有意义、评估回退留空则失败按 `insufficient` 处理、视觉取证对纯后端/文档任务只会变慢且对缺 witness 是确定性否决、witness 留空跟随纯文本评估模型会 `UNSUPPORTED_CONTENT`。
  - 「不设置回退」「使用模型默认值」同样是要写理由的结论；三个下拉的推理等级默认留空。
  - 技能描述、质量检查清单与「最后一行」同步改为六项口径；README 中英与 `docs/12-user-guide.md` 的督导步骤同步。
  - 回归：`tests/channel/handoff-skill.spec.ts` 固定「独立评估模型：跟随主会话」「执行回退模型：不设置回退」「评估回退模型：不设置回退」「启用视觉取证：不勾选」「六项选项建议」「推理等级」「确定性否决」「跨 provider」等 marker。

- 第二十七轮：把「对话执行模型」并入督导运行选项区，交接技能同步扩为七项。
  - **位置**：勾选「督导运行」后，「对话执行模型」从「新对话执行配置」移进督导选项面板，排在「执行回退模型」之前（执行主模型与它的回退读作一对）；未勾选时仍在运行配置区。同一个控件、同一份 `route`/`effort` 状态，只渲染一处（行标记 `data-redline-anchor-exec-model-row`），所以不会出现两个下拉各自漂移。
  - **判定理由**：执行模型原先被运行目录隔在面板之外，用户会把「想换执行模型」误填到「执行回退模型」里（回退只在故障时接管，等于没换）；两者相邻后，主/回退的语义自己说清。
  - **交接技能**：选项建议从六项扩为七项（新增「对话执行模型（含推理等级）」），并写明「想换风格/能力选执行模型，不要塞进执行回退」「CLI 桥接型 provider 可以做执行、不要做评估」。
  - **文案**：执行模型提示补「督导运行时它排在执行回退之前，子会话也沿用它」；评估模型提示改为「默认跟随『对话执行模型』」。
  - 回归：`tests/client-ui/child-card.spec.ts`「开启督导运行后执行模型移进选项区并排在执行回退之前（只渲染一处、评估仍在上方）」；`tests/channel/handoff-skill.spec.ts` 固定「七项」「对话执行模型：保持默认」。

- 第二十八轮：选项区改为「评估对 → 执行对」，评估回退紧接评估模型。
  - 顺序：独立评估模型 → 评估回退模型 → 对话执行模型 → 执行回退模型 → 启用视觉取证 → 严格模式 → 独立 worktree。主模型与它自己的回退相邻，不再被另一条链隔开；桥接型警告仍跟在评估模型行下（条件渲染，不占位）。
  - 交接技能的七项模板与判断准则同步成同一顺序（评估链在前、执行链在后），避免卡片建议与界面排布互相打架。
  - 回归：`tests/client-ui/child-card.spec.ts` 追加「评估回退紧接评估模型」「评估对整体排在执行对之前」。

- 第二十九轮：评估器「推理吃满输出预算」导致的阻断改成可自助修复（x9Copy 1.6.90 run 实测）。
  - **现象**：R1/R2 通过，R3 的评估连续 3 次 `MAX_TOKENS`（DeepSeek V4.1 Flash / max，4000→8000 两次都被截断、每次约 65 秒），达到 `EVAL_UNAVAILABLE_LIMIT` 后任务与 run 一起 `blocked`，会话停住等人工；该 run 没有配置评估回退，所以没有第二条路由。
  - **判定**：这是设计内的停止（评估不可用绝不 `pass`），但失败原因对人不具可操作性——「检查模型配置、网络或输出格式」并不能指出真正该改的是推理等级。
  - **修法**：`loop.ts` 在阻断原因是 `MAX_TOKENS` 时，把「把评估等级降到 High（或配置评估回退）后可继续」写进 `blocked.reason`，并把 `blocked.next` 改成同一句修法；其他失败码的文案不变。
  - **交接技能**：评估等级建议补「`max` 的推理 token 与 JSON 共用输出预算，大任务容易连续 `MAX_TOKENS`；真要用 max 就先配好评估回退」。
  - 回归：`goal-supervisor-loop.spec.ts`「评估器连续输出被截断时，阻断原因直接给出降到 High / 配回退的修法」。

- 第三十轮：评估/审阅/视觉调用不再自带输出上限；冷启动恢复冻结卡片（x9Copy 1.6.90 run 与重启后会话实测）。
  - **去掉人为 maxTokens**：`evaluator.ts`（任务评估 4000→8000、进度评估 800→1600）、`milestone.ts`（审阅 2500、裁决 1500）、`visual.ts`（2500→5000）此前都显式传 `maxTokens`，而推理 token 与 JSON 共用这份预算；`deepseek-v4.1-flash / max` 在 R3 上两次都被截断。现全部改为不传 `maxTokens`，由适配器按模型自身的默认预算填充（与普通对话一致），`MAX_TOKENS` 仅表示模型自身上限并保持可切换；超时仍是唯一的人为上限。
  - **冷启动恢复冻结卡片**：`watchGoalSupervisors` 的 `agent/created` 在重新 `attachSupervisor` 之后，用台账里的 `goal/acceptance/discipline` 按创建时的格式（`目标：…\n\n验收：…\n\n纪律：…`）重新注册 `RUNTIME_ANCHOR_NAME` 运行时上下文。此前重启后模型只剩督导头/尾锚点（目标首行 + 当前任务），会静默丢失完整验收与纪律。
  - **文档**：用户指南改为「评估调用用模型自身默认预算；仍报 MAX_TOKENS 说明撞到模型上限」。
  - 回归：evaluator「截断如实报 MAX_TOKENS 且不请求显式 maxTokens」「进度评估截断同样不重试」；visual「截断不再升预算」；attach「冷启动重新注册 RUNTIME_ANCHOR_NAME 且文本含目标/验收/纪律」「worktree 冷启动同样恢复」。

- 第三十一轮：督导运行卡重做视觉（按创建规则弹窗的密度与控件语汇）。
  - **头部**：标题 + 状态胶囊（进行中/已阻塞/已完成/已暂停，按 `supervisor.status` 着色）+ 右侧 `done/total` 进度；运行 id 改为等宽小字单行省略。
  - **阻断**：从「一行红字」改成左侧色条的 callout（error/warn 两档），任务级与 run 级阻断分开展示，失败原因与下一步修法不再淹没在元数据里。
  - **模型信息**：保留原有六行（镜像/分支/评估/评估回退/执行/当前执行/视觉）的文案口径（测试逐字钉住），只统一字号与等宽数值。
  - **按钮**：恢复/应用改为弹窗同款的 `redline-confirm-btn`（ok/cancel/danger 三档、29–28px 高、7px 圆角），回退从「需阻断才出现」回到「有历史状态就出现」，与主线行为一致。
  - **选择器**：blocked 时的「评估模型 + 推理等级 + 应用并继续」改成同高的一行控件（圆角 7px、自绘 chevron），与弹窗的模型条读感一致；元素仍是原生 `select`，键盘与既有回归不受影响。
  - 门禁：CSS 闭包（378 类）、i18n 孤儿（376 键）、contextView 71 项、全量 128 文件全过。

- 第三十二轮：把「执行模型不要用 CLI 桥接型」写进技能与界面（选 C：DSH 原生执行 + agy 视觉子代理）。
  - **背景**：`session-anchor-0219…`（zenspace V5 run）执行模型是 `antigravity/gemini-4-neon`，会话 107 次工具调用全部是 `agy_tool`、零 `subagent`——agy 把自己的子代理留在 CLI 内，DSH 的编队页与督导的「派子会话」都看不到委派。
  - **技能**：`handoff-skill.ts` 的「对话执行模型」条目补：CLI 桥接型可以做执行、不要做评估，但它会把子代理留在自己的 CLI 里，默认用 DSH 原生模型做执行，视觉/画面任务再显式派给 agy 子代理。
  - **对话框**：执行模型选到 `antigravity` 时，行下方出现 `data-redline-anchor-exec-bridge-warning` 硬提示。
  - **督导卡**：`executorModel` 以 `antigravity/` 开头时补一条 `data-redline-supervisor-executor-bridge` 说明，避免运行中才后知后觉。
  - 回归：client-ui「执行模型选到 CLI 桥接型时提示子代理会留在 CLI 里」；contextView「a CLI-bridge executor says its subagents stay inside the CLI」；channel 技能 marker「把子代理留在自己的 CLI」「派给 agy 子代理」。

- 第三十三轮：长跑轮次预算、空转收敛与宿主 goal 对齐（2026-11-28，`session-anchor-0219…` 复盘）。
  - **背景**：zenspace run 在同一个回合里做完 15 个任务并打出 15 个提交/tag，但一份「## 完成声明」都没写；回合结束后宿主 goal 被 256 轮默认上限停掉（`round-limit`），台账仍是 `active / 0/15`，卡片因此永远显示「进行中」。期间每轮 turn-stop 还把同一个 heavy 探针重跑了 256 次。
  - **轮次预算（`budget.ts`）**：`armSupervisorGoal` 建 goal 时显式传 `maxGoalRounds = max(2000, 任务数 × 200)`；`auditTurn` 结束时若 run 仍在推进（无任务处于空转）且余量 ≤200，自动 `goals.edit` 每次 +1000 并记 `goal.extended` 事件。宿主的 256 默认值不再是长跑的天花板。
  - **round-limit 可恢复**：`resumeSupervisorGoal` 遇 `roundsStarted >= maxGoalRounds` 时先 `edit` 扩容、再用 `edit` 返回的新 `revision` 调 `resume`；冷启动 `armSupervisorGoal` 同样处理「blocked 且轮次耗尽」的目标。
  - **空转收敛**：没有 light 探针的任务不再对空数组 `.every()` 恒真而每轮重跑 heavy（改为：必选未全过、scope 指纹变化、或新增声明才跑）；未变化的探针复用上次结论与时间戳。`idleStreak` 记录「探针全过但 scope 未动且无新声明」的连续轮数，到 `IDLE_STALL_LIMIT = 5` 自动 BLOCKED 并给出 `docs/guard/<runId>/tasks/<ID>/notes.md`；任何真实进展（改代码、写声明、评估、DONE、人工继续、回退）都会清零。
  - **锚点**：空转任务在最高优先级段显示「待验收（<ID>）：…追加「## 完成声明」并立刻结束本回合」；硬规则里的完成声明改为完整路径，并写明「即使项目纪律写着不改 `docs/guard/**`，该文件仍是例外」。
  - **守卫文案**：`update_goal(complete)` / `update_goal(blocked)` 的拒绝改为给出未通过数量、当前任务与 `notes.md` 精确路径，避免模型把拒绝误读成「本会话没挂 guard 工具」后空转 200+ 轮。
  - **卡片**：`SupervisorSummary` 新增只读 `hostGoal`（phase/activation/roundsStarted/maxGoalRounds/blockedReason，来自宿主 `GoalService`）；台账 `active` 但宿主 `blocked/paused/disarmed` 时，胶囊显示「已阻塞/已暂停」并给出原因与轮次，不再渲染成「进行中」。「继续运行」按钮在宿主停摆时同样可用：台账仍是 active 时也允许 `guard.continue` 清空 `idleStreak` 并扩容恢复目标（`milestone-pending` / `completed` 仍严格拒绝）。
  - 门禁：channel 528+、client 75、loop 80；`tsc --noEmit`、`oxlint`、`tsdown`、文档/i18n 脚本全过。
