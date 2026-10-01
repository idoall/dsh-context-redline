# 05 · 测试计划

> 三条上位规则（从早期两条实现线的教训里来（结论已并入 `docs/01`））：
> **① 先写测试并确认它红**——一条从没红过的测试不构成证据。
> **② 客户端半（React/浏览器）无法 TDD** → 必须过**人工门禁**，且先在静态 demo 里量过。
> **③ 入参尽量用 DSH 的真实类型**；不得不 `any` 时，测试必须传**真实对象**（手搓 fake 正是掩盖上游改形的东西）。
>
> ⚠️ **一句话说清本轮的边界**：本计划在 **M2/M3 只能证明"我们的代码与不变量成立"**；
> 凡涉及真机平台语义的（真机会话上的 replace/回滚、被遮蔽原文可读性、跨压缩区间）**一律推迟到 M4.5**，
> 并在本文件里逐条标 `conditional`。**不许把 fake 通过当成平台事实。**

---

## 1. 测试分 lane（vitest `projects`）

| lane | 目录 | 可依赖的运行时 import | 能不能稳定跑 | 跑什么 |
|---|---|---|---|---|
| `edit`（自有护栏·纯逻辑） | `tests/edit/` | **只允许** `src/redline/**` 与 `src/shared/**` | ✅ 必须永远绿 | 资格判定、行投影、漂移逐字判定、范围校验、快照/血缘序列化、`plan.next` 判定次序、能力开关组合 |
| `channel`（自有护栏·真实路由级） | `tests/channel/` | 允许 `src/host/redline-channel.ts` 与 `src/edit/**`；**禁止** `src/client/**` | ✅ 必须永远绿 | 捕获宿主注册的**精确 Fetch 路由** → 按真实 RPC 信封调用 → 读回 SQLite/草稿文件断言 |
| `host`（上游带的） | `tests/host/` | 上游 | ⚠️ 环境依赖，可能整片失败 | 上游 fold/投影。**不作为门禁**，但改动上游文件时要跑一次做对照 |
| `client`（上游带的） | `tests/client/` | 上游客户端 | ⚠️ 同上 | 上游客户端组件。**不作为门禁** |

> **⚠️ 关于"自有护栏不受上游影响"的诚实口径**（上一版把它写得太满，已更正）：
> - `edit` lane 真的可以**完全不碰**宿主与上游（只 import 纯逻辑 + `shared`），这一点可由 import 图机械校验。
> - `channel` lane **必然** import `src/host/redline-channel.ts`，因此它**依赖 DSH 的 server 侧类型与 `node:sqlite`**。
>   它能规避的只是**上游客户端依赖缺口**（缺 `react`/`shiki` 等），**不是**"完全不依赖平台"。
> - **机械校验**：把上面两条边界写成检查（静态 import 图 + 禁止 `src/client/**`），违规即失败。**不靠人记。**
> - 新增测试目录必须同时在 `vitest.config.ts` 加一条 lane，否则 `vitest run <dir>` 会报"找不到测试"。

---

## 1.5 「大量条目」是硬约束，不是边角情况（2026-10-01 补）

用户问过一句必须记下来的话：**「刚才那个用户有 2000 多条，每一步里可能又有工具、其他内容，
总数可能上万条 —— 会影响下拉列表的性能吗？从质量测试角度，你有考虑过这些问题吗？」**
答案是：**没有**（当时我只是把"两个数字输入框"换成了一个"列出这一步所有条目"的下拉，没问量级，
也没问语义）。从此定为设计约束：

| 约束 | 具体规则 |
|---|---|
| **界面里不许出现"全量条目"的选择器** | 任何下拉/列表都只渲染**当前这一步**（几十~几百条上限），且必须虚拟化或分页；不许把"整段历史的条目"塞进一个控件 |
| **范围类输入一律交给自然语言** | 例如批注的「作废更大的范围」 → 写在**理由**里（模型读的就是理由），不在 UI 里造区间选择器 |
| **新增交互控件前先问两件事** | ① 量级（这条会话/这一步可能有多少条）② 语义（「从 A 到 B」对用户与模型到底意味着什么）。答不上来就不加 |
| **回归检查** | `demo/check-static.mjs` 里有契约锁死：批注**不许**出现 `type="number"`、**不许**出现范围下拉（`id="edTo"`） |

> 教训（写给自己）：上一轮我为了解决「别让用户输数字」，顺手加了一个下拉 —— 那是**把一个问题换成另一个更糟的问题**。
> 用户一句「从质量测试角度你考虑过吗」就点破了：**没有量级意识的交互设计，等于没设计。**

## 2. 必须有的断言（每条按 **fixture → action → assertion** 三栏写全）

> 这是 M2 的自动化门禁。带 `conditional` 的条目**不等 M4.5 结论就不能算平台事实**。

### 2.1 草稿与只读（不写会话）

| # | fixture | action | assertion |
|---|---|---|---|
| **A1** | 一个已闭合轮次的会话（N 条事件）+ 一条草稿 | `draft.update` → `draft.reset` | ① 返回草稿表正确；② **会话事件数仍是 N**（关键反证）；③ 草稿文件只在数据目录，路径里不含会话 id 明文（用 safeSessionId） |
| **A4** | 一条 **>200 字、含多段换行**的 `user/message` | `node.read{seq}` | ① 返回正文**逐字等于**事件里的 `data.content` 文本块拼接；② **长度 ≠ 80**、**不等于** `firstText()` 的结果（封死 `docs/01` F35） |
| **A19** | 两个会话 A/B（各有草稿与固定块）+ 一个不存在的 sessionId + 一个故意的损坏草稿 JSON | 对所有**只读** op 各调一次 | ① A 的读取**绝不**返回 B 的数据（会话隔离）；② 不存在的会话 → 稳定错误码而不是 500；③ 损坏草稿 → 明确 `corrupt` 错误，**不静默清空** |
| **A23** | 一个已闭合轮次的会话 | `snapshot.create` | ① 返回记录含 `cutSeq`/条目数/时间**基本合理**（`cutSeq` = 最后一个 `turn/end` 的 seq）；② **会话事件数不变**；③ 记录只落数据目录 |
| **A24** | 有两次替换 + 一次回滚的会话 | `edits.list` / `history.list` | ① 形状与顺序正确（按时间/seq）；② 每个版本的 `kind` 是 `origin/ edit/ rollback` 之一 |

### 2.2 改写的门禁（每条都要有"被拒"的断言）

| # | fixture | action | assertion |
|---|---|---|---|
| **A2** | 一条 append-origin 的 `user/message`（seq=A）+ 草稿 | `apply{seq:A}` | ① 追加一条 `surfaceOp:{op:'replace',startSeq:A,endSeq:A}`；② `deriveMessages()` 里**看不到**原文；③ A 不再是 surface 节点；④ 5 秒内 `readSurface` 能看到替换关系 |
| **A3a** | 分别构造 `user/message` 与 `tool/result`（各自 append-origin）与草稿 | `apply` 各一次 | ① 两类**都成功**；② `tool/result` 的替换**只改了 `content`**（其余字段深比较相等）；③ `user/message` 带 `sourceEventSeqs:[原 seq]` |
| **A3b** | 一条 `assistant/message`（append-origin） | ① 先问能力判定；② 再**强行**调写入口 | ① 能力判定返回 `canRewrite:false` + **稳定原因码**（如 `assistant-not-rewritable`）；② 强行调用返回**可读错误**（带同一个原因码），**不是**平台抛出的 `sourceEventSeqs must include…` 或 `assistant/message embeds…` |
| **A5** | 一个**未闭合轮次**的会话（有 `turn/start` 无 `turn/end`）+ 草稿 | `apply` / `annotate` / `invariant.inject` 各一次 | 三个写入器**全部**被拒，且错误文案里提到"轮次未结束"；**会话事件数不变** |
| **A6** | 一条已被遮蔽的**原始节点**（`#A` 已被 `#M` 替换） | `apply{seq:A}` | 被拒；错误码可读（对应用户文案是"这一条已不在模型可见内容里"） |
| **A7** | ① 没有草稿的 seq；② 草稿内容与原文**完全相同** | `apply` 两次 | 两次都被拒，且两次的**原因码可区分**（`no-draft` vs `no-change`） |
| **A8** | 四条夹具：只给 `voidFrom` / 只给 `voidTo` / `from > to` / `from == to` | `annotate` 四次 | 前三个被拒（`bad-range`）；`from == to` **成功** |
| **A9** | 一条 append-origin `user/message` | `annotate{seq}` | ① 追加的是一条**带结构化头部**的普通 user 消息；② **原文仍在 surface 上**（`gone` 未设置）；③ 头部可被解析回 `{targetSeq, voidFrom, voidTo, reason}` |

### 2.3 固定块与漂移

| # | fixture | action | assertion |
|---|---|---|---|
| **A10** | 会话 A 建两个固定块（一个 `scope:'workspace'`、一个默认 session 级）；另一会话 B | 在 B 里 `invariant.list` | B **只看到** workspace 那个；A 看到两个。**反向**：把 `scope` 过滤去掉 → 该断言必须红 |
| **A11** | 三个夹具：① surface 上与固定块**逐字相同**；② **只差一个字**；③ 固定块**已退休** | `invariant.drift` | ① `present:true`；② `present:false`（**不许** trim/contains 就算在）；③ 退休块不参与漂移判定但仍出现在 `invariant.history` |
| **A22** | 子会话夹具：① 空闲且未压缩过；② 有未闭合轮次；③ 已有一个未配对的 `compaction/start` | `compact.state` | 三种情况分别给出 `canCompact` 与**可读 reason**；②③ 为 false |

### 2.4 回滚与版本历史

| # | fixture | action | assertion |
|---|---|---|---|
| **A16** | 一条 `user/message` 原文 `#A` → 替换成 `#M` → 再替换成 `#K` | `history.list{当前可见 seq}` → `apply.rollback{seq:K, toSeq:A}` | ① 历史链返回 `[A(origin), M(edit), K(edit)]`，正文可读；② 回滚后 `deriveMessages()` **逐字等于 #A 的原文**；③ 行上关系链为 `原 #A → #M → #K → 回滚 #N` |
| **A18** | ① 注入一个"能读到被遮蔽正文"的 readSession 实现；② 注入一个"读不到"的实现 | `history.list` / `node.read` | ① 能读到时：返回完整正文；② 读不到时：返回 **`history-unavailable`** 这一稳定降级信号，**绝不用 80 字预览冒充**。<br>⚠️ **`conditional`**：**真机上"被遮蔽原文到底读不读得到"由 M4.5 的 V8 专项验证**，不在 M2 下定论（见 §3.1） |

### 2.5 契约与纯度（防"两边各自自洽但合不上"）

| # | fixture | action | assertion |
|---|---|---|---|
| **A12** | 宿主半装好后，从**客户端那一半**的 transport 层发一次请求 | 逐个 op 打一次 | ① 客户端**实际 POST 的 URL** == 宿主注册表里捕获的 `path`（同一个常量来源）；② 把 `src/shared/redline-route.ts` 的常量改错一处 → **必须红**（两侧任何一侧单改都要红） |
| **A13** | 客户端 bundle 的入口文件 | 静态**与动态** import 图分析 | `src/client/**` 的可达 import 图里**不出现** `src/host/**`、`src/edit/**`（实现）、`node:*`。**反向**：加一行动态 import → 必须红 |
| **A14** | 表驱动：`plan.next` 的所有输入组合（轮次开/闭 × 草稿 0/N × 固定块 0/N × occupancy 未定/<0.7/≥0.7 × 能力开关组合） | 逐条调用 | ① 返回的 `kind` 与优先级次序**逐条符合** `docs/06` §6 的表；② `needsAuthorization` 正确；③ 每个 `reason` 非空且包含关键事实（例如有草稿时**必须**提到"种子取自会话日志"） |
| **A20** | 本地写 op：`invariant.save` / `invariant.retire` / `snapshot.create` / `draft.update` | 各调一次 | ① 只写数据目录/sqlite；② **会话事件数不变**；③ 再次调用（幂等场景）结果可预期 |
| **A21** | 把能力开关置 `{agents:false}` / `{fork:false}` / `{compaction:false}` | 调 `child.fork` / `child.compact` / `child.send` / `child.interrupt` | ① 各自返回**明确的不可用错误码**；② **根本没有调用平台 API**（用 spy 断言 `ctx.subagents` / `ctx.compaction` 零调用）——避免"能力为 false 但按钮还在，点下去是平台异常" |

### 2.6 迁移

| # | fixture | action | assertion |
|---|---|---|---|
| **A15**（**已降级**：用户已删除旧数据目录，`docs/08` Q8 作废） | 一个**空数据目录** | 首次启动 | ① 能建库并写入 `schema_version`（值正确）；② 固定块增删改查正常；③ **不需要任何旧库迁移分支**（代码里不得残留"读旧 schema"的路径） |

---

## 3. 环境与前置

```bash
# 装依赖（顺序不能变；见 docs/01 F14/F15）
rm -f node_modules/@deepseek-ai
pnpm install --ignore-scripts
node scripts/link-dsh-runtime.mjs

# 必须能过的命令
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsdown
./node_modules/.bin/vitest run --project edit --project channel
node scripts/namespace-contract.mjs        # M1 的命名空间自检（docs/04 M1 DoD）
```

- **不许**跑 `scripts/clean-lib.mjs`（删 `lib/` 会让 `link:` 安装的插件客户端半边直接失效）。
- 静态确认插件树与命名空间：`dsh --profile web --dump-config`（**合成但不 boot**）。

### 3.1 与 M4.5 的关系（**不许把顺序搞反**）

| 内容 | 在哪验 |
|---|---|
| 纯逻辑、契约、迁移、拒绝路径、能力开关 | **M2/M3（本文件的 A 表）** |
| **真机会话上的 replace / 回滚 / 被遮蔽原文可读性 / 跨压缩区间** | **M4.5（`docs/04`）**，包 B 需你逐次授权 |
| 依赖上述结论的人工门禁条目（`docs/03` §7 的第 15 条等） | **在 M4.5 的 V7/V8 出结论之后才执行**；未出结论时只验"关闭态"（第 16 条） |

**包 A / 包 B 的划分与死锁处理**见 `docs/04` 的 M4.5（包 B 未授权时取 `capability=false` 的保守配置，关闭对应按钮，其余子集照常验收）。

---

## 4. 人工门禁（浏览器）

> **唯一权威清单是 `docs/03` §7 的 30 条**（按 R 编号覆盖，逐条打勾）。
> 本节不再重复条目内容，只给**执行前的前置条件**与**证据格式**——两份清单如果有出入，以 `docs/03` §7 为准，并回改本节。

**每个条目的证据格式**（缺一项即不算通过）：

| 字段 | 内容 |
|---|---|
| 条目号 | `docs/03` §7 的编号（如 `#4`）+ 它覆盖的 R 编号 |
| 前置 | 是否需要真机授权、是否依赖 M4.5 的某项结论（`V7/V8/V9`） |
| 操作 | 具体点了什么（可复现） |
| 证据 | **原始输出**：截图 / console 全量片段 / 会话日志片段（不许只写"已通过"） |
| 结论 | 通过 / 不通过 / **因能力缺失而按降级口径通过**（要注明是哪个开关） |

**准备**
- 装进 web profile（**需用户单独授权**）、`tsc && tsdown`、**硬刷新**（F16）。
- 深色：`document.body.setAttribute('data-ds-dark-theme','')`；浅色移除（V2，纯 DOM，不落盘）。
- 窄屏：375 / 640 两档。
- **先确认面板显示的是哪个会话**：① 面板数字条的"本会话共 N 事件 / 最后 seq"与目标会话日志对得上；② `turn/start` 与 `turn/end` 条数差 = 1 的是末轮未结束的那个。

**依赖关系（必须遵守，否则会验出一个假的通过）**

| `docs/03` §7 的条目 | 前置 |
|---|---|
| `#15`（回滚逐字恢复） | **M4.5 的 V8 = pass** 才执行；否则只执行 `#16`（关闭态） |
| `#16`（不可恢复态都有文案） | 无（任何情况下都要执行） |
| `#19` / `#23`（开子会话 / 派活闭环） | ① M4.5 的 ② `agents`、③ `fork`、**V10**（`subagentCatalog` 等投影可读）、**V11**（续存 fork 端到端，含"父不在进程 / 父正忙"两种情形）都有结论；② **官方 `dsh-client-ui-subagent` 已挂载**，父会话页头的血缘触发器存在且能打开一个 child（否则"打开 → 官方视图"这条承诺无法兑现）。任一不满足 → 按 `docs/04` 的同步变更表验"不存在 / 降级" |
| `#21`（压缩体检） | M4.5 的 ④ 有结论（可用 → 验执行；不可用 → 验"不显示执行按钮"） |
| `#30`（并存） | 两插件同 profile（需授权） |
| **另立一条门禁**：官方 subagent UI 可用 | 与 `#30`（与 `dsh-context@0.59.2` 并存）**分开验**：本插件**不得注册或替代**官方的 subagent 槽位（`conversation.session.header.lineage` / `.actions` / `sidebar.chat.conversation` / `sidebar.right.pane.tab` / `conversation.composer`） |

---

## 5. 边界与失败模式用例（每条都要有用例或明确文案）

| # | 场景 | 期望 |
|---|---|---|
| E1 | 会话不在本进程 | 只读 + 常驻说明；写入类不可用 |
| E2 | 轮次未闭合 | 同上（理由不同） |
| E3 | 目标已被遮蔽 | 无「编辑」+ 原因 + 替代路径（批注 / 快照+子会话） |
| E4 | 目标被自动压缩埋掉（checkpoint） | 只能批注；界面说明"改写够不到它" |
| E5 | 无草稿 / 无实质改动 | 拒绝，给原文 |
| E6 | 作废范围一端缺失 / 逆序 | 拒绝 |
| E7 | 多段文本消息改写后合并为一段 | **提前告知**（R3.4） |
| E8 | `flush` 失败 | 响应 `flushed:false`；界面不假装成功 |
| E9 | 子 Agent 忙 / 有未闭合轮次 / 已有压缩锁 | `busy` → 人话"等它空闲再压"；按钮置灰 |
| E10 | 压缩 `failed`/`changed`/`summary` | 逐码映射；如实告知"失败尝试会留在日志里" |
| E11 | fork 后父会话继续跑新轮次 | 新轮次**不**出现在子会话（用日志比对证明） |
| E12 | 拿不到父 Agent | 明确告知 + 给原生 `subagent_fork` 工具的替代路径 |
| E13 | 草稿文件损坏（非法 JSON） | 明确的 corrupt 报错，不静默清空 |
| E14 | SQLite 迁移中途失败 | 迁移前备份；失败可回退，不半迁移 |
| E15 | 两个插件并存 | 无路由/key 冲突（M1 的 `namespace-contract`） |
| E16 | **助手消息行** | 不出现「编辑」；点出现的按钮**不会**出现平台异常；说明徽章给出替代路径（批注 / 快照+子会话） |
| E17 | **跨压缩 checkpoint 的区间替换**（V9 未验证前） | 界面上**不提供**该入口 |
| E18 | **回滚后又被追问"为什么内容变了"** | 行上显示完整关系链，每一步可展开看正文 |
| E19 | **有草稿时点开子会话** | 被阻止 + 明说"草稿不在 fork 种子里" + 逐条处置 |
| E20 | **旧替换体上还挂着草稿**（R4.6 的组合） | 不静默丢弃：给"把草稿应用到当前可见的 #K"或"丢弃草稿"二选一（需确认） |

---

## 6. 反向验证（**每条护栏都要证明"改坏会红"**）

> 规则：对每条护栏实际做一次"改坏 → 看红 → 改回"，并把这一步写进提交说明。
> 下面按 A 编号给**具体的改坏手法**（不只列编号）。

| 护栏 | 改坏手法 | 期望 |
|---|---|---|
| A1 | 让 `draft.update` 顺手 append 一条事件 | **红** |
| A2 | 去掉 `surfaceOp` 或改成 `append` | **红** |
| A3a | 让 tool/result 替换顺手改 `isError` 以外还改 `callId` | **红**（平台会拒，我们要在**测试里**先捕获） |
| A3b | 删掉 assistant 的原因码判定（让它走正常路径） | **红** |
| A4 | 把 `node.read` 改成返回投影预览 | **红** |
| A5 | 移除 `assertClosedTurn` | **红** |
| A6 | 允许 `gone` 的 seq 作目标 | **红** |
| A7 | 跳过"无草稿/无实质改动"检查 | **红** |
| A8 | 接受单端/逆序范围 | **红** |
| A9 | 让 `annotate` 走 replace（遮蔽原文） | **红** |
| A10 | 忽略 `scope`，固定块永远全局返回 | **红** |
| A11 | 把逐字比较改成 `trim()`/`includes()`；或不过滤退休块 | **红** |
| A12 | 只改客户端常量、或只改宿主注册路径（任一侧） | **红** |
| A13 | 在客户端里加一行动态 `import('../../host/...')` | **红** |
| A14 | 调换 `plan.next` 的优先级；或把 `needsAuthorization` 全设 false | **红** |
| A15（已降级） | 在代码里加一段"读旧 schema"的兼容分支 | **红**（旧数据目录已被用户删除，不该有任何旧库分支 —— `docs/08` Q8） |
| A16 | 把"回滚"实现成新 append 一条（而不是 replace 当前可见节点） | **红**（`deriveMessages()` 会同时看到新旧两条） |
| A17 | 让 `canRewrite` 对 `assistant/message` 返回 true | **红** |
| A18 | 在"读不到"的实现下返回 80 字预览 | **红** |
| A19 | 去掉会话隔离 / 损坏草稿时静默返回 `{}` | **红** |
| A20 | 让 `snapshot.create` 顺手写一条会话事件 | **红** |
| A21 | 能力开关为 false 时仍去调平台 API | **红**（spy 断言零调用） |
| A22 | 让 `compact.state` 在"有未闭合轮次"时返回 `canCompact:true` | **红** |
| A23 | 让 `cutSeq` 取"最后一个事件"而不是"最后一个 `turn/end`" | **红** |
| A24 | 打乱 `history.list` 的顺序或漏掉 `kind` | **红** |

---

## 7. 人工门禁之前的静态 demo 要求（客户端改动）

布局/交互类改动**先在静态 demo 里做出来**，demo 必须**能在浏览器里自报测量值**（元素尺寸、命中坐标、是否溢出、对比度），因为 agent 侧只能读无障碍树/截图，不能 `evaluate` 任意表达式。

demo 的验收口径：
- 深/浅两套截图；
- 375 / 640 / 1280 三档宽度下的关键盒子数值；
- `Esc` / `Cmd+Enter` / 点击穿透（动作条不触发展开）/ 确认框取消无副作用，四个行为的可见回执。

---

## 8. op → 测试 → 人工门禁 → 阶段（**零空白追溯表**）

> 规则：`docs/02` §5.2 里的**每一个 op** 都必须在这张表里有落点。新增 op 而没加落点 = M2 未完成。

| op | 自动化 | 人工门禁（`docs/03` §7） | 阶段 |
|---|---|---|---|
| `node.read` | A4、A18、A19 | #4、#15 | M2 |
| `draft.list` | A1、A19 | #6 | M2 |
| `draft.update` | A1、A20 | #4、#12 | M2 |
| `draft.reset` | A1、A20 | #12 | M2 |
| `apply` | A2、A3a、A3b、A5、A6、A7 | #5、#10、#11 | M2 |
| `apply.rollback` | A16、A18 | #15、#16 | M2 |
| `history.list` | A16、A18、A24 | #15、#16 | M2 |
| `edits.list` | A24 | #5 | M2 |
| `annotate` | A8、A9、A5 | #10、#11 | M2 |
| `turnState` | A19、A5 | #13、#14 | M2 |
| `invariant.list` | A10、A19 | #17 | M2 |
| `invariant.history` | A11 | #17 | M2 |
| `invariant.drift` | A11 | #18 | M2 |
| `invariant.save` | A10、A20 | #17 | M2 |
| `invariant.retire` | A10、A20 | #17 | M2 |
| `invariant.inject` | A5、（能力开关）A21 | #18 | M2 |
| `plan.next` | A14 | #24 | M2 |
| `snapshot.create` | A23、A20 | #19 | M2 |
| `snapshot.list` | A19、A23 | #19 | M2 |
| `child.list` | A19、A21 | #19、#23 | M5 |
| `child.fork` | A21 | #19 | M5 |
| `child.compact` | A21 | #21、#22 | M5 |
| `compact.state` | A22 | #21 | M5 |
| `child.send` | A21 | #10、#23 | M5 |
| `child.interrupt` | A21 | #10、#23 | M5 |
| `/redline` 子命令（`snapshot`/`children`/`compact`/`invariants`/`drift`） | 每个子命令一条真实路由级用例（同 A12 的信封） | 与对应 op 同条目 | M6 |

**能力开关为 false 时**：上表里对应的 op 改为断言"**明确不可用错误码 + 零平台调用**"（A21），人工门禁条目改为验"入口不存在"，并在 `docs/04` 的同步变更表里留下 diff。
