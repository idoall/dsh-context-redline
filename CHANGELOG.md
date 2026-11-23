# 更新日志 / Changelog

## [0.8.3] — 2026-11-23

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.3-alpha.2 <0.3.0-0`; verified with `0.2.3-alpha.2`. Node.js `^24.22.3 || >=26.13.1`.

### 兼容 / Compatibility

- 验证基线从 DSH `0.2.2-rc.5` 提升到 `0.2.3-alpha.2`（本次实际升级的版本）；开发依赖、对等依赖下限与 Node.js 要求同步到该版本（`^24.22.3 || >=26.13.1`）。
- 核对官方 upgrade guide（`0.2.2-rc.5` → `0.2.3-alpha.2`）：移除的 `ctx.sessionQuery.inspectSession` 本插件未使用（只用 `readSession` 与可选的 `observeSession`），类型检查、构建与全部测试在该版本上通过。
- 系统提示词改为章节更新后，DSH 会把**所有幸存系统消息**拼进请求并按“求和”计价；本插件的系统提示词卡片同步改为同一条规则（与宿主的上下文分解一致）。

### 修复 / Fixed

- 系统提示词不再按“最后一条非空系统消息”计价：发生章节更新时，旧规则会把整份提示词显示成一段增量的 token 数，现在显示所有幸存系统消息之和。
- 系统提示词文本按顺序拼接头部提示词与每条章节更新（每条一次按需读取，失败可重试），不再把一段章节更新当成整份提示词展示。
- DNA 条的系统带取同样的总和；压缩（compaction）遮蔽掉的系统消息同步移出，不再重复计价。
- 持久化状态版本 24 → 25（旧规则算出的数值是错的，缓存行重新 fold）。

## [0.8.2] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 变更 / Changed

- `context-redline-handoff` 强制拆任务：每个里程碑 / 交付物一个独立任务，每个任务至少一个子会话；首条任务从建任务清单开始。
- `context-redline-handoff` mandates task decomposition: one independent task per milestone/deliverable, at least one subagent per task, and the first task starts with building the task list.
- 主会话只规划/分派/审查，不得直接开发、修改或测试，也不得自己连续做多个任务或多个里程碑。
- The main session only plans, dispatches and reviews; it never develops, modifies or tests directly, and never runs several tasks or milestones itself.
- 即使说“过程中不用确认”，拆分与审查也不取消，只取消逐里程碑确认；验收必须包含任务清单、子会话产物与审查记录。
- “No confirmation during the process” waives only the per-milestone confirmation, not decomposition or review; acceptance requires the task list, subagent output and review record.

## [0.8.1] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 修复 / Fixed

- 锚定会话标题不再加 `新对话 ·` 前缀，直接用目标；目标为空时退回首条任务。
- Anchored session titles no longer carry a `新对话 ·` prefix; they use the goal, falling back to the first task.

### 变更 / Changed

- `context-redline-handoff` 内置主会话/子会话分工：主会话只规划、分派、审查，开发与测试修改交子会话；收到的成果必须审查，问题打回或重新分派。
- The `context-redline-handoff` skill embeds role separation: the main session plans, dispatches and reviews only; development and test changes go to subagents; results are reviewed and problems bounced or reassigned.
- UAT 按需判断：UI / 交互 / 视觉改动必须有头 UAT 并复测到无问题；纯后端 / 文档改动写“无需 UAT”及理由。
- UAT is conditional: UI / interaction / visual changes require headed UAT with retests until clean; backend/documentation changes state why no UAT is needed.
- 验收标准保留可检查门：有头 UAT 证据与主会话审查记录；执行纪律写行为约束。
- Acceptance keeps checkable gates (headed-UAT evidence and review record); discipline carries the behavioral constraints.

## [0.8.0] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- `context-redline-handoff` 技能升级为双场景：先推荐迁移或锚定，再输出对应字段。
- The `context-redline-handoff` skill now outputs both handoff shapes, after recommending one.
- 情况 A（迁移）：首条任务 + 每轮运行时规则锚点，最终发送全文由插件拼接；情况 B（不迁移）：首条任务 / 目标 / 验收标准 / 执行纪律。
- Case A (migration): first task + per-request runtime-rule anchor, with the final message composed by the plugin; Case B (fresh): first task / goal / acceptance criteria / discipline.
- 两种场景共用目标、验收、纪律检查；未知信息标“未验证”，不编造。
- Both scenarios share the goal/acceptance/discipline checks; unknown facts stay unverified.

### 边界 / Boundaries

- 技能只输出文本，不建会话、不写文件；不改变趋势、锚定会话或既有数据。
- The skill only outputs text; it creates no session and writes no file, and changes no trend, anchored-conversation or existing data.

## [0.7.0] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 注册运行时技能 `context-redline-handoff`：读取当前对话，输出首条任务 / 目标 / 验收标准 / 执行纪律四段，直接粘贴到「新建带规则的对话」。
- Register a runtime skill, `context-redline-handoff`: read the current conversation and output first task / goal / acceptance criteria / discipline, ready to paste into **New conversation with rules**.
- 技能区分当前里程碑与整个目标，要求验收可执行/可观察，未知信息标“未验证”，不编造。
- The skill separates the current milestone from the whole goal, requires executable/observable acceptance, and marks unknown facts unverified instead of inventing them.
- 通过 `ctx.inject(['skills'])` 可选注册；没有 skills 服务或注册失败都不影响插件其他功能。
- Registered optionally through `ctx.inject(['skills'])`; a missing skills service or a failed registration leaves the rest of the plugin unaffected.

### 边界 / Boundaries

- 技能只输出文本，不建会话、不写文件；不改变趋势、锚定会话或既有数据。
- The skill only outputs text; it creates no session and writes no file, and changes no trend, anchored-conversation or existing data.

## [0.6.1] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 修复 / Fixed

- 从上下文浏览器打开 DNA 时，趋势的「增量」模式没有复位：图上已按 DNA 的总计语义绘制，但「增量」按钮仍然显示选中（仅被禁用）。现在两个 DNA 开关共用一个处理函数，开启 DNA 时同时把趋势复位到「总计」。
- Opening DNA from the Context browser left the trend's Delta mode selected: the chart plotted DNA total semantics while the Delta segment still looked active (only disabled). Both DNA switches now use one handler that parks the trend at Total when DNA turns on.
- 关闭 DNA 时保留当前模式，不额外改写用户选择。
- Turning DNA off preserves the current mode instead of rewriting the user's choice.

### 边界 / Boundaries

- 只改客户端状态同步；DNA 仍是总计语义，DNA + 增量与色带点击跳转仍不在范围内。
- Client-side state sync only; DNA remains total-only, and DNA + Delta plus band click-through remain out of scope.

## [0.6.0] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 趋势 DNA 指纹模式：每根柱子按模型读取顺序拆成逐条色带；系统提示词、工具定义在前，随后是消息。
- Trend DNA fingerprint mode: each bar decomposes into per-item bands in the model's read order — system prompt and tool schemas first, then messages.
- 浏览器的 DNA 开关与趋势开关联动；DNA 开启时增量模式禁用（色带即组成，固定总计语义）。
- The browser DNA switch and the trend switch move together; Delta is disabled while DNA is on (the bands are the composition, so total semantics are fixed).
- 趋势标题移除轮次/刻度读数，与参考插件标题结构同步。
- The trend title drops the turn/scale readout, matching the reference title structure.

### 边界 / Boundaries

- DNA + 增量组合、色带点击跳转到浏览器条目不包含在本版；持久化状态版本保持 24。
- DNA + Delta and band click-through to a browser row are not in this release; the persisted state stays at version 24.
- README 总览截图随标题与开关更新；中英文 README、发布说明与 npm 包内容同步。
- The README overview screenshot follows the title and switch changes; both READMEs, release notes and npm package contents stay synchronized.

## [0.5.0] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 趋势耗时曲线：每步活跃耗时（step 窗口减审批/提问等待）叠加在柱子上，右轴读取；按轮次求和；缺失值断开曲线。
- Trend duration overlay: each step's active time (step window minus approval / Q&A waits) as a curve over the bars, read off the right-hand axis; turn mode sums the steps; a missing figure breaks the line.
- 自适应与耗时合并为一组标题开关；移除聚焦分类副标题；移植 hover 性能修复。
- Adaptive and Duration share one compact title group; the focused-category subtitle is removed; the hover-path performance fix is ported.

### 内部 / Internal

- 请求记录新增 `activeMs`，宿主在 `step/end` 写入；状态版本 23 → 24，旧缓存行从日志重折叠。
- Request records gain `activeMs`, stamped by the Host at `step/end`; the state version moves 23 → 24 so cached rows refold from the log.
- README 总览截图随趋势 UI 更新；中英文 README、发布说明与 npm 包内容同步。
- The README overview screenshot follows the trend UI change; both READMEs, release notes and npm package contents stay synchronized.

### 边界 / Boundaries

- 不包含 DNA 趋势指纹模式、未验收的体检功能或 carrier-seed 实验。
- Excludes the DNA trend fingerprint mode, unaccepted diagnostics and carrier-seed experiments.

## [0.4.1] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 修复 / Fixed

- 修复锚定会话首次创建时报 `anchor start held: prompt-not-persisted` 的假阴性：flush 已确认写入，但查询投影可能短暂滞后；宿主改为有界重读（3 次、200/500/1000ms 退避，最多约 1.7 秒），遇到真实冲突仍立即停止。
- Fix the anchored-conversation false negative `anchor start held: prompt-not-persisted`: flush confirms the append, but the query projection can lag; the Host now re-reads a bounded number of times (3 retries, 200/500/1000 ms backoff, ~1.7 s worst case) and still stops immediately on a real conflict.
- 补齐锚定会话弹窗底栏间距：底栏改为 flex、按钮间 10px，说明文字与按钮之间留出空隙。
- Restore the anchored-conversation dialog footer spacing: flex layout, 10 px between actions, and a gap between the scope copy and the buttons.

### 边界 / Boundaries

- 不改变首次消息字节、运行时快照、台账或回程语义；不新增模型调用。
- First-message bytes, runtime snapshot, ledger and return semantics are unchanged; no model call is added.

## [0.4.0] — 2026-11-22

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 「新建带规则的对话」：不迁移上下文，直接创建独立普通 root 会话；首条任务 + 目标/验收/纪律快照，无回程。
- "New conversation with rules": creates an independent ordinary root session without migration; first task plus a goal/acceptance/discipline snapshot, with no return path.
- 目标默认跟随首条任务；快照在确认前逐字预览、创建后冻结。文本不变不重复写入，压缩后自动重新声明。
- The goal follows the first task; the snapshot is shown verbatim before creation and frozen afterwards. Unchanged text is not rewritten and is re-declared after compaction.
- 同一 `operationId` 重试只创建/投递一次；不读也不写来源会话日志。
- Retrying the same `operationId` creates and delivers only once; the source session log is neither read nor written.

### 边界 / Boundaries

- 只影响这一个新对话，不改 DSH 原生新建对话、其他会话或其他工作区；不调用模型生成内容。
- Affects only that new conversation; leaves DSH's native new-conversation flow, other sessions and other workspaces untouched; no model-generated content.
- 自动化回归不代表生产人工验收；不包含未验收的体检功能和 carrier-seed 实验。
- Automated regression does not constitute production manual acceptance; excludes unaccepted diagnostics and carrier-seed experiments.

## [0.3.0] — 2026-11-21

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 锚点新增「每轮运行时规则」方式：不写进首条消息，而是通过 `systemPrompt.context` 注册为承载会话的运行时上下文。文本不变不重复写入，压缩折叠后自动重新声明并声明取代旧版本。
- New "per-request runtime rule" anchor mode: kept out of the first message and registered through `systemPrompt.context` for the carrier. Unchanged text is not rewritten; after compaction it is re-declared with a supersession notice.
- 该方式默认关闭、必须显式选择；锚点原文与指纹写入台账，恢复时按同一文本重新注册。空锚点不能选择；改锚点或改方式会使旧确认失效。
- Off by default and explicitly selected; the anchor text and fingerprint are frozen in the ledger and re-registered on recovery. Empty anchors cannot select it; changing the anchor or mode invalidates an old confirmation.

### 边界 / Boundaries

- 运行时规则只作用于本插件创建的承载会话，不是预设系统提示词或工具定义；不调用模型、不摘要、不改写，来源会话保持 append-only。
- The runtime rule applies only to the carrier this plugin creates; it is not a preset system prompt or tool definition, involves no model call, summary or rewrite, and leaves the source session append-only.
- 保留 0.1.x / 0.2.0 的模型 / 预设读取、异步投影句柄与工具结果历史修复；不包含未验收的体检功能和 carrier-seed 实验。自动化回归不代表生产人工验收。
- Retains the 0.1.x / 0.2.0 model/preset reads, asynchronous projection handle and tool-result history fixes; excludes unaccepted diagnostics and carrier-seed experiments. Automated regression checks do not constitute production manual acceptance.

## [0.2.0] — 2026-11-21

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 新增 / Added

- 确认框新增可选的「锚点」：人写的关键词或硬约束，原样放在首条消息的开头和结尾各一次，用来抵抗长会话里的注意力稀释。
- Optional "anchor" in the confirmation box: human-written keywords or hard constraints, placed verbatim at the start and end of the first message to resist long-context attention dilution.
- 锚点进入确认项、最终发送全文和确认指纹；改动锚点会要求重新确认。空锚点与 0.1.3 的首条消息逐字节相同。
- The anchor is part of the confirmation items, the final message and the confirmation fingerprint; changing it requires re-confirmation. An empty anchor keeps the 0.1.3 first message byte-identical.

### 边界 / Boundaries

- 锚点不调用模型、不做摘要或改写，也不进入系统提示词或工具定义；来源会话仍保持 append-only。
- The anchor involves no model call, summarization or rewrite, and never enters the system prompt or tool definitions; the source session stays append-only.
- 保留此前的模型 / 预设读取、异步投影句柄与工具结果历史修复；不包含未验收的体检功能和 carrier-seed 实验。自动化回归不代表生产人工验收。
- Retains the model/preset reads, asynchronous projection handle and tool-result history fixes; excludes unaccepted diagnostics and carrier-seed experiments. Automated regression checks do not constitute production manual acceptance.

## [0.1.3] — 2026-11-21

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 变更 / Changed

- 验证基线提升到 DSH `0.2.2-rc.5`（现为 npm `latest`）；开发依赖与对等依赖下限同步，Zod 4.6.6 与 `dsh-error` 对等依赖保持不变。
- Move the verified baseline to DSH `0.2.2-rc.5` (now npm `latest`); synchronize development/peer dependency floors while keeping Zod 4.6.6 and the `dsh-error` peer.
- rc.5 仅调整 DeepSeek 模型的服务端搜索策略，未修改本插件使用的 Session Query、Agent、预设、工作区、会话投影与 Client 插槽接口。
- rc.5 only adjusts DeepSeek models' server-side search strategy; the Session Query, Agent, preset, workspace, projection and Client slot interfaces used here are unchanged.
- 保留此前的模型 / 预设读取、异步投影句柄和工具结果历史修复；支持下限随验证基线上移，旧 DSH 用户可继续使用 0.1.2。
- Retain the model/preset reads, asynchronous projection handle and tool-result history fixes. The supported floor moves with the verified baseline; older DSH users can stay on 0.1.2.

本次仍为兼容性补丁，不包含未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This remains a compatibility patch and excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.2] — 2026-11-18

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.4 <0.3.0-0`; verified with `0.2.2-rc.4`. Node.js `>=24.9.0`.

### 变更 / Changed

- 验证基线提升到 DSH `0.2.2-rc.4`，包含其 Zod 4.6.6 与新增的 `dsh-error` 对等依赖；类型检查、全量测试与构建均以该版本依赖完成。
- Move the verified baseline to DSH `0.2.2-rc.4`, including its Zod 4.6.6 and the new `dsh-error` peer; typecheck, the full test suite and the build run against that dependency set.
- 0.2.2-rc.2 至 rc.4 未移除本插件使用的公开接口；会话批量追加与更明确的工具错误类型不影响现有只读、台账和回程路径。
- DSH 0.2.2-rc.2 through rc.4 removed no public interface this plugin uses; batched event append and clearer tool error types do not affect the read-only capture, ledger or return paths.
- 保留 0.1.1 的模型 / 预设读取、异步投影句柄与工具结果历史修复；支持范围下限随验证基线上移，旧 DSH 用户可继续使用 0.1.1。
- Retain the 0.1.1 model/preset reads, asynchronous projection handle and tool-result history fixes. The supported floor moves with the verified baseline; older DSH users can stay on 0.1.1.

本次仍为兼容性补丁，不包含未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This remains a compatibility patch and excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.1] — 2026-11-04

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`; verified with `0.2.2-rc.1`. Node.js `>=24.9.0`.

### 修复 / Fixed

- 读取会话当前的模型选择，不再把启动配置误当成用户切换后的模型；未指定推理等级不继承旧值。承载会话恢复时按实际当前模型验证，配置不一致或未知则停止投递。
- Read the Session's current model selection instead of stale startup options. Omitted reasoning effort stays at the model default. Carrier recovery validates the effective route and refuses mismatched or unknown selections.
- 读取会话当前已记录的预设，不再优先使用创建时固定头信息；未知预设不猜测。
- Read the recorded preset selection instead of the immutable creation header; never guess an unknown preset.
- 等待异步会话投影注册完成后再启用详情读取，使用保留的投影句柄而非弃用的按 key 读取。
- Await asynchronous projection registration before exposing detail reads, and retain the projection handle instead of using deprecated registry key reads.
- 修复新版工具结果历史详情丢失正文与错误状态的问题，同时保留旧日志格式读取。
- Preserve current tool-result history content, call identity and failure status while continuing to read legacy log shapes.
- 开发依赖、Node.js 要求、中英文文档和 npm 包支持范围同步；GitHub Release 必须等待 npm 发布成功。
- Synchronize development dependencies, Node.js requirements, bilingual documentation and npm support metadata; create the GitHub Release only after successful npm publication.

本次仅发布兼容性补丁，不包含尚未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This compatibility-only patch excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.0] — 2026-10-15

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.1-alpha.2 <0.3.0`.

### 新增 / Added

- 可编辑、可删除的上下文迁移副本；本地保存不改来源会话。
- 在当前工作区创建零历史普通根会话，不继承 fork 历史。
- 可直接编辑最终发送全文，并选择新会话模型与推理等级。
- 固定 ID 持久台账、精确字节校验、崩溃恢复和自动原样回程。
- 混合文字 / 图片消息迁移文字并明确报告遗漏图片。

### 安全与恢复 / Safety and recovery

- 删除项不进入新会话，来源日志保持 append-only。
- 工具结果必须匹配原调用；未知媒体和文件附件不会静默丢失。
- 同一 request ID 必须匹配精确正文，并在 flush 后由冷日志证明持久化。
- unknown 状态不重发；损坏台账、配置或回程指纹会停止执行。
- 新会话配置与来源会话回程恢复配置分开冻结。

### 界面 / UI

- 上下文统计、趋势、事件、七类浏览器与普通承载会话索引。
- 行下全文编辑、可逆删除、最终全文编辑器。
- 与 DSH 输入框一致的一行模型 / 推理等级浮动选择器。
- 深浅主题、窄屏布局和 CSS 命名空间隔离。

### 许可 / License

- 原创代码采用 MIT。
- 复制自 `dsh-context` 的部分保留 Apache-2.0。
- 详见 `NOTICE`、`LICENSE-Apache-2.0` 和 `UPSTREAM.md`。
