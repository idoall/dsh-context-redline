# 01 · 平台事实（已核实）

> **用途**：让评审者不必读代码就能判断我们的设计是否建立在真实 API 上。
> **纪律**：每条都标 `实测` / `推断`，并给出可复核的位置。凡未核实的，一律写"待验证"，不许当依据。
>
> **路径约定**（本机）：
> - `$DSH_PKG` = `<dsh-install>/node_modules/@deepseek-ai`
>   （**当前真正在跑的构建**，版本 **0.2.0-rc.2**（2026-10-01 实测），每个包独立，`lib/types/*.d.ts` 是权威签名）
> - `$DSH_PROFILE` = `$DSH_HOME/profiles/node_modules/@deepseek-ai`（profile 层依赖树）
> - `$DSH_SRC` = `<dsh-workdir>/deepseek-harness`（源码 monorepo，**版本与运行时同步 = 0.2.0-rc.2**，语义看它、签名以 `$DSH_PKG` 为准）
>   · ⚠️ **历史**：早期那次尝试的源码副本是 `0.1.6-alpha.1`（`<old-dsh-src>`），**落后于运行时**，只当历史参考，其中的行号/结论不许当依据
> - `$UPSTREAM` = `<upstream-clone>`（参考插件 clone，带 tag）

---

## 1. 运行时现状（实测）

| 事实 | 值 | 怎么核实的 |
|---|---|---|
| DSH 版本 | **0.2.0-rc.2** | `$DSH_PKG` 各包 `package.json`（2026-10-01 实测：安装树与 `$DSH_PROFILE` 都是 rc.2） |
| Node | v24.15.0 | 当前进程 |
| 参考插件 | profile 里**实装 `dsh-context@0.60.0`**（`^0.60.0`），**已装并在跑**；我们的**复制基线 = git tag `v0.59.2`**（两者同源） | `$DSH_HOME/profiles/web/package.json` 的 dependencies + `node_modules/dsh-context/package.json` |
| 我们的插件 | 目录 symlink 在 `$DSH_HOME/profiles/web/node_modules/dsh-context-redline`，但**不在** `dsh.profile.bundles` 里 → **当前未启用** | 同上 |
| 早期那次尝试 的验证运行时 | `0.1.7-rc.2`（**历史**，不是现在这个） | `git show v2-archive-20260928:AGENTS.md` |

> **含义**：任何"早期那次尝试 里验证过"的结论，都必须在 **0.2.0-rc.2** 上**重新验证**。
> 这也是我们把**复制基线**换成 git tag `v0.59.2` 的原因。（版本仍在往前走：`0.2.0-rc.1` 是**历史**运行时，那时的实测结论同样要按 rc.2 复核一遍。）

---

## 2. 硬约束：三个"会抛错"的命名空间冲突（实测）

这一节是整个设计里最容易被忽略、也最致命的部分：**我们与参考插件必须并存**，而上游源码用的是全局名字。

### F1 · HTTP 路由：同路径重复注册**直接抛错**

```js
// $DSH_PKG/dsh-client-connection/lib/index.js:633
if (this.fetchRoutes.has(route.path))
  throw new Error(`connection: exact Fetch route ${JSON.stringify(route.path)} is already registered`);
```

- 注册入口：`ctx.connection.fetch.register({ path, methods, requestBody, fetch })`
  （`$DSH_PKG/dsh-client-connection/lib/types/rpc.d.ts:111`（接口）/ `:128`（方法）；上游 v2 的用法见 `host/redline-channel.ts:213-222`）
- ⚠️ **`path` 写全量（含 `/api` 前缀）**：类型注释说它是"Absolute path **below `/api`**"（`rpc.d.ts:112`），
  但上游实测注册值就是**含前缀**的 `'/api/dsh-context/detail'`（`src/host/detail.ts:43`）——**别照注释把 `/api` 去掉**，
  否则客户端 POST 的 URL 与注册路径不成对，成 404 而不是抛错（更难发现）。
- 上游注册的路径：`/api/dsh-context/detail`、`/api/dsh-context/balance`、`/api/dsh-context/backfill`
  （对应 `src/host/detail.ts:43`、`src/host/balance.ts:29`、`src/host/backfill.ts:51`，客户端还有 `src/client/timelineSource.ts:37`）
- **结论**：复制上游 `src/` 时，**所有**路径必须改成我们自己的前缀 `/api/dsh-context-redline/*`。
  顺序上后注册的一方会抛错——而插件加载失败是**静默降级或整块功能消失**，很难被发现。

### F2 · 投影 key：同 key 的两种命运（静默顶掉 / 抛错）

```js
// $DSH_PKG/dsh-session-projection/lib/index.js:84-91（0.2.0-rc.2 实测行号）
const existing = this.registrations.get(key);
if (existing === void 0) this.registrations.set(key, { def: erased, cells: new WeakMap(), refs: 1 });
else {
  if (existing.def.stateVersion !== erased.stateVersion)
    throw new Error(`session projection key ${JSON.stringify(key)} is already registered at stateVersion ` +
      `${String(existing.def.stateVersion)}; refusing to share it with stateVersion ${String(erased.stateVersion)}`);
  existing.refs += 1;   // ← 相同 stateVersion：静默共用**先注册者**的定义
}
```

- 上游的 key（行号 2026-10-01 按 tag `v0.59.2` 复核）：`contextTimeline`（`src/host/timeline.ts:310`）、
  `contextHeaders`（`src/host/headers.ts:186`）、`contextActivity`（`src/host/activity.ts:245`）。
- **结论**：key 必须改成 `redlineTimeline` / `redlineHeaders` / `redlineActivity`。
  否则：stateVersion 撞上 → 我们的 fold 被参考插件的定义顶掉（面板数字看着"对"，其实不是我们的口径）；
  stateVersion 不同 → 插件直接抛错。**两种失败都不会给出清晰提示。**

### F3 · 客户端 bundle 注册 id 必须等于包名（实测，早期那次尝试 踩过）

DSH 的 `dsh-client-modules` 按**包名**校验客户端模块注册 id，不一致会抛
`loaded without registering "<id>"`。早期那次尝试 里为此专门提交过一次修正
（`ec57ea8 fix(v2): 插件身份 id/name 与包名对齐 —— 否则被上游 dsh-context 顶掉`）。

- 我们的 tsdown 配置从上游继承，注册 id 由 `pkg.name` 自动生成 → **改包名会自动同步**，但 slot id / locale 命名空间/投影 key / 路由**不会**自动改，必须人工逐个对齐。

### F4 · 其余需要"分家"的名字（实测：行号按 tag `v0.59.2` 复核，2026-10-01）

> ⚠️ 这一节是**最容易漏的一节**：F1/F2/F3 撞车会**抛错**，而下面这些**多半是静默**的
> （偏好被两边共用、slot 被后注册者顶掉、localStorage 互相覆盖），排查时看不到任何报错。
> 判据一律是**字符串相等**，所以"上游值 → 我们的值"必须逐个改，且改完要能用机器断言（见本节末尾）。

| 面 | 上游值（`v0.59.2` 实测出处） | 我们的值 |
|---|---|---|
| `conversation.view` slot id | `context` | `redline` |
| **其余 slot id**（同一批注册，同样按字符串分派） | `context-jump`（`src/client/index.ts:113`）、`context-modal`（`:125`）、`context-overview`（`:140` `sidebar.footer.action` 与 `:148` `shell.overlay`） | `redline-*`（同样逐个改） |
| **键控 slot**（`key:` 参与分派） | `settings.plugin.item`（`src/client/index.ts:181`）与 `plugins.bundle.config`（`:199`）都以 `key: NS` 注册；`sidebar.right.pane.tab` 以 `key: SIDEBAR_CONTEXT_ID` 注册（`src/client/sidebar.ts:87`） | 键控名照旧，但 `key` 必须换成我们的命名空间 |
| **`SETTINGS_NAMESPACE`**（宿主侧设置服务 + 持久化偏好命名空间） | `'dsh-context'`（`src/host/settings.ts:26`，`:53` `service.register(SETTINGS_NAMESPACE, SettingsSchema)`） | `'dsh-context-redline'`。**撞车是静默的**：两个插件共用同一份偏好，用户改一边另一边跟着变 |
| **`SIDEBAR_CONTEXT_ID` / `SIDEBAR_CONTEXT_KIND`** | 都是 `'dsh-context'`（`src/client/sidebar.ts:31,38`） | 分家（否则右侧 Sidebar 的标签类型互相顶掉） |
| **localStorage key** | `'dsh-context:platform-balance'`（`src/client/balance.ts:26`） | 分家（否则两个插件互相覆盖余额缓存） |
| locale 命名空间（`NS`） | `'dsh-context'`（`src/client/index.ts:65`） | `'dsh-context-redline'` |
| 插件 `name` 导出 | `dsh-context` | `dsh-context-redline` |
| `MessageSourceMap` kind | **无**——上游**不注册任何消息来源 kind**（`git grep MessageSourceMap v0.59.2 -- src/` 零命中），所以这一面**没有"上游旧值"要分家** | `dsh-context-redline`（merge-extensible，无 catch-all `plugin`，各生产者自 declare） |
| 数据目录 | 无（上游只读） | `$DSH_HOME/dsh-context-redline` |

**机器断言（M1 的 `namespace-contract` 用）**：查"上游旧值零命中"时**必须带排除**，
否则正则会把我们自己的名字判红：

```js
// ✅ 正确：排除我们已经改好的前缀
/dsh-context(?!-redline)/          // 命中 dsh-context、dsh-context:platform-balance；不命中 dsh-context-redline
// ❌ 错误：/dsh-context/ 会把 dsh-context-redline 也算命中
```

同理，`contextTimeline` 这类 key 要断言**改后**是 `redlineTimeline`（而不是断言"文件里没有 contextTimeline"——
`docs/01`/`UPSTREAM.md` 里的说明文字本来就该提到上游旧名）。

---

## 3. 会话读写（实测）

### F5 · 同步事件读取**已废弃**，新代码禁止使用

```ts
// $DSH_PKG/dsh-session/lib/types/index.d.ts:177 / :187 / :196
/** @deprecated Existing logic may remain unmigrated for now, but new calls are prohibited.
 *  See the Agent Note .../2026-09-09-deprecate-synchronous-session-event-reads.md */
eventAt(seq: SessionSeq): SessionEvent | undefined;
snapshotEvents(fromSeq?, toSeqExclusive?): readonly SessionEvent[];
ownEvents(): readonly SessionEvent[];
```

**替代（异步、支持冷会话）：`ctx.sessionQuery`**（`$DSH_PKG/dsh-session-query/lib/types/index.d.ts`）

| 方法 | 签名 | 用途 |
|---|---|---|
| `readSurface` | `(sessionId) => Promise<SessionSurfaceSnapshot>` | **一次拿到当前 surface 的全部事件与全文**；`{session, inheritedEventCount, capturedThroughSeq, events: SurfaceEvent[]}`（`types.d.ts:23-32`） |
| `readEvent` | `({sessionId, seq, before?, after?}) => Promise<SessionEventWindow>` | 取单条事件的**完整内容** + 一段上下文窗口（`types.d.ts:109-133`） |
| `readSession` | `(sessionId) => Promise<SessionLogSnapshot>` | 完整原始日志（`types.d.ts:34-41`）——做 `seq → turn` 映射用它 |
| `listEvents` | `(sessionId) => Promise<SessionEventRecord[]>` | 轻量事件清单 |
| `readEvent`/`traceEvent`/`traceSession` | 见文件 | 替换关系溯源（`start` 事件 → 被遮蔽节点） |

> **设计含义**：我们把**读**全部放在 `sessionQuery` 上（异步、冷会话也能读、且一次能拿到**全文**），
> 把**写**放在 live `Session.append` 上。早期那次尝试 的致命缺陷正是因为它的"读"取的是宿主投影里的 80 字预览
> （当时的审计文档 `docs/07` 已按用户要求删除、**编号不复用**；结论已并入本文 F35）。

### F6 · 写入：`encodeSurfaceOp` 的三个硬校验（实测）

```ts
SurfaceOp = 'append' | { op: 'replace'; startSeq: SessionSeq; endSeq: SessionSeq }
```
（`$DSH_PKG/dsh-session/lib/types/types.d.ts`）

`append` 时，session 侧会校验（`$DSH_PKG/dsh-session/lib/index.js`）：

| 校验 | 规则 | 位置 |
|---|---|---|
| `replacementRange` | `startSeq`/`endSeq` 必须是**当前 surface 节点**，否则 `surface replace: start seq N not found in surface` | `:361-372` |
| `assertSourceEventReferences` | `sourceEventSeqs` 必须非空、无重复、都 `< 本事件 seq`，且**包含每一个被遮蔽的节点** | `:311-329` |
| `assertToolResultRewrite` | `tool/result` 的替换只能改 `message.content`（其余字段深比较必须相等） | `:391-408` |
| `assertSystemHeadRewrite` | node 0 是 `system/message` 时只能被 `system/message` 且恰好指向它 | `:415-424` |
| `surfaceOp` 必填 | 5 种 surface 事件类型必须带 `surfaceOp` 标记 | `:304` |

配套（`types.d.ts`）：
- `assistant/message` **禁止** `sourceEventSeqs`（`SurfaceIntent<T>` 的条件类型）
- 辅助函数：`isAppendSurfaceEvent` / `isReplacementSurfaceEvent` / `foldSurface(events, projections?)`
- **`inPlaceSurface` 这个 API 不存在**（`实测`：在 `$DSH_PKG`、`$DSH_SRC`、早期那次尝试 里都搜不到）——"遮蔽"就是 `surfaceOp: replace`

### F7 · replace 的**目标必须是"当前可见的节点"**——这条决定"能不能改第二次/能不能回滚"

平台侧 `planSurfaceEvent` 对一条 replace 事件只校验五件事（`$DSH_PKG/dsh-session/lib/index.js:437-460`）：
① `surfaceOp` 合法且 `startSeq/endSeq < event.seq`；② `replacementRange`：start/end **必须是当前 surface 节点**（按 surface 顺序）；
③ `assertSourceEventReferences`：`sourceEventSeqs` 必须包含**全部被遮蔽节点**，且非空、无重复、都更早；
④ `assertToolResultRewrite`（仅 tool/result）：**只能改 `message.content`**；⑤ `assertSystemHeadRewrite`：node 0 的 system 受保护。

**注意：校验里没有"目标必须是 append-origin"这一条。** 早期那次尝试 里的 `isAppendSurfaceEvent(original)` 拒绝是**它自己加的策略**，不是平台约束。

由此得到两条**必须区分**的事实（本机 `dsh-session` 直接实测，见 §3.1）：

| 目标 | 结果 |
|---|---|
| **已被遮蔽的原始节点** | ❌ 拒：`surface replace: start seq N not found in surface`（它已不在 surface 上） |
| **上一次的替换体** | ✅ **通过**（它就是当前 surface 节点）→ **可以改第二次、也可以回滚** |

**结论（与本文档早期版本相反，已按实测更正）**：
- 「编辑」**不是一次性的**。对同一条消息可以：改 → 再改 → 回滚（把目标换成当前可见的那个替换体即可）。
- 早期那次尝试 把"原始节点不可再作目标"误读成"编辑只能做一次"，于是**丢掉了用户明确要求的"能回滚"**（图 2 ④）。
  这是**早期那次尝试**的教训（结论见本文件 F7/F7.1）。

### F7.1 · 直接实测记录（本机 `dsh-session`，2026-09-30）

探针脚本在 `（临时探针目录）/`（不进仓库，只读性质：`Session.create()` 造 detached 会话 + `append`）：

```
PASS | replace 原始节点（第一次编辑）        | {"seq":1,"nodes":[1]}
FAIL | replace 已被遮蔽的原始节点（期望被拒） | surface replace: start seq 0 not found in surface
PASS | replace 替换体（第二次编辑/回滚）      | {"seq":2,"nodes":[2],"msgs":["ORIGINAL-USER-TEXT"]}
PASS | user 第 1/2/3/4 次替换                | seen: U1, U2, U3, U4        ← 连续改任意次
PASS | append + replace tool/result（改 content）| {"seq":1,"nodes":[1]}
PASS | replace tool/result 的替换体           | {"seq":2,"msgs":["T-ROLLBACK"]}
PASS | replace 区间覆盖 user+assistant 两节点  | {"seq":2,"nodes":[2],"seen":["COMBINED"]}   ← 多节点区间也成立
FAIL | replace assistant（不带 sourceEventSeqs）| surface replace: sourceEventSeqs must include every shadowed surface node; missing 0
FAIL | replace assistant（带 sourceEventSeqs）  | assistant/message embeds its source stream and cannot carry sourceEventSeqs
```

⚠️ **探针的边界**：用的是 `Session.create()` 的 **detached** 会话（无 compaction checkpoint、无真实 tool-call 配对、无 fork 前缀）。
涉及压缩、工具配对、fork 继承的场景必须在 M4.5 用**真机会话**复验（见 §6 V7）。

### F7.2 · ⚠️`assistant/message` **无法改写**（平台自相矛盾，实测）

两条规则互斥，导致 assistant 的 surface replace **没有任何可行写法**：

1. replace 要求 `sourceEventSeqs` 覆盖被遮蔽节点（`assertSourceEventReferences`）；
2. 但 `assistant/message` **禁止携带** `sourceEventSeqs`：`assistant/message embeds its source stream and cannot carry sourceEventSeqs`（`lib/index.js:313`）。

⟹ **产品结论（必须落到 UI）**：
- **助手消息在 v1 不可改写**，界面上**不给「编辑」按钮**（给了必然点下去报错）。
- 助手消息的修正路径只有：**批注**（追加更正）、或**遮蔽整段**（用多节点区间替换把 user+assistant 一起换成一条人工消息，见 F7.1 最后一行 PASS）、或**快照 + 子会话**。
- 早期那次尝试 的 `applyEdit` 里有完整的 assistant 分支，**但那条路径从未真机跑过**（M3 界面未验收），必然抛错 —— 早期那次尝试就栽在这里。

### F8 · turn 边界是**策略**而非核心校验（实测）

`Session.append` 本身**不检查**轮次是否闭合；turn-closed 是插件（上游）自己守的：
扫描 `turn/start` … `turn/end` 得到 `hasOpenTurn`。
（早期那次尝试：`src/redline/turn-state.ts:13-27`，在 `write.ts:103,242` 调用。）

**为什么必须守**：模型可能**已经读过**旧内容，改动必须发生在"没有请求在飞"的间隙，否则上下文在模型看不见的时刻变化。

### F9 · 会话必须 live 才能写（实测）

`ctx.sessions.get(sessionId)` 拿不到 → 不能 apply/annotate（早期那次尝试 抛
`session "…" is not live in this process`）。因此"冷会话 / 别人的会话"只能**只读**，
`turnState` 也要用 `known:false` 表达"判不了"，UI 必须**默认禁用并说明原因**，而不是让用户点了才报错。

---

## 4. 子会话 / 压缩 / 编排（实测，M5 的地基）

### F10 · fork：父会话**已完成轮次**做种子，一次性

```ts
ctx.subagents.start(name: string, request: SubagentStartRequest): Promise<SubagentRun>
SubagentStartRequest = { label?, prompt: ContentBlock[], parent: Agent, signal: AbortSignal,
                         agentOptions?, outputSchema?, maxDepth?, toolFilter?, persona? }
SubagentRun        = { id: SessionId, localAgent: Agent | undefined,
                       result: Promise<SubagentResult>, dispose(): Promise<void> }
```
（`$DSH_PKG/dsh-subagent/lib/types/index.d.ts`、`.../types.d.ts`）

- provider 名 **`fork`** 由 `dsh-subagent-fork-in-process` 注册（`providerName` 默认 `fork`，
  `$DSH_PKG/dsh-subagent-fork-in-process/lib/types/index.d.ts`），本会话里它表现为 `subagent_fork` 工具
- 种子切点：父会话 `snapshotEvents()` 中**最后一个 `turn/end`**（`$DSH_SRC packages/subagent/subagent-fork-in-process/src/index.ts:48-55`）
- **`prompt` 必填**：子会话建立时必须带一条初始消息
- **`parent` 必须是活的 `Agent`**：`ctx.agents.get(sessionId)`（`'subagent/start'` 的 JSDoc 明确 in-process provider 可解析）
- **⚠️ 关键推论（实测/很重要）**：种子取自**日志**，而**草稿不在日志里**
  → **没 apply 的改动不会带进子会话**。这条是编排层的第一优先级（见 `docs/06` §2）

### F11 · 压缩：可编程，但有四个前置条件

```ts
ctx.compaction.compactNow(agent: ManualCompactAgentContext, signal: AbortSignal, sourceCommandId?: CommandId)
  : Promise<CompactionResult | null>
ManualCompactAgentContext = CompactionAgentContext & { runMaintenance<T>(task): Promise<T> }
ManualCompactionError.code = 'busy' | 'cancelled' | 'changed' | 'summary' | 'commit' | 'persistence'
```
（`$DSH_PKG/dsh-compaction/lib/types/index.d.ts`；`/compact` 的实现就是这个调用：
`$DSH_SRC packages/compaction/command-compact/src/index.ts:73`）

前置条件（`$DSH_SRC packages/compaction/compaction-basic/src/index.ts:340-408`、`region.ts:174-203,328-355`）：

| # | 条件 | 不满足时的表现 |
|---|---|---|
| 1 | **需要 live `Agent`**（不是裸 Session） | 无法调用（`runMaintenance` 在 Agent 上） |
| 2 | **Agent 空闲**（不能有轮次在跑、不能有别的 maintenance） | `ManualCompactionError('busy', …)` |
| 3 | **轮次已闭合** | `busy`（`manual compaction: the session already has an open turn`） |
| 4 | **没有未配对的 `compaction/start` 锁** | `busy` |
| 5 | 区间两端必须在**当前 surface** 上、按 surface 位置有序、工具调用/结果**成对** | `changed` / 抛错 |

- `compactRegion(start, end, agent)` 用的是 `{owner:'current-turn'}` → **要求有未闭合轮次**，所以**不适用**于"空闲子会话压缩"；空闲场景用 `compactNow`。
- **结论（产品策略，不是平台限制）**：本插件 **v1 只在子会话里暴露压缩按钮**，主会话不给（降低误操作面）。
  ⚠️ 平台**没有**"主会话不能压缩"这条限制：只要 Agent 空闲且轮次闭合，对任何会话调 `compactNow` 都成立。
  这条限制是我们自己设的，属于 `docs/08` 可改的产品决策。
- 失败码必须映射成人话（"等它空闲再压"等），见 `docs/06` §5。

### F12 · 主会话指挥子会话

```ts
ctx.subagents.sendMessage(sender: Agent, targetId: SessionId, content: ContentBlock[], options): Promise<MessageId>
ctx.subagents.listChildren(parentSessionId, signal?): Promise<SubagentCatalogEntry[]>
ctx.subagents.listDescendants(rootSessionId, signal?)
ctx.subagents.interrupt(targetSessionId, authority: {kind:'user',parentSessionId} | {kind:'ancestor',agent})
ctx.subagents.startContinuable(spec): Promise<{ childId: SessionId; messageId: MessageId }>
```
（`$DSH_PKG/dsh-subagent/lib/types/index.d.ts`）

- `sendMessage` 的 `sender` 必须是**活的** Agent（父↔直接子，双向；**子会话发给父会话就是"结果回传"**）
- `interruptByParent(childSessionId, parentSessionId, 'continuable')`：按**持久父子地址**打断，不需要父 Agent 在线
- **容量**：`maxActiveSubagents` 默认 **8**；超出时新建/冷恢复以 `ACTIVATION_LIMIT_REACHED` 拒绝（**不排队**）；上限只存在于当前进程

### F12.1 · ⚠️ 两种形态的**回传差异**——它决定"主会话能不能接着干"

| 形态 | 谁拿到结果 | 主会话会被唤醒吗 | 子会话还能继续吗 |
|---|---|---|---|
| **一次性**（`start`；工具默认 `backgroundMode: one-shot`） | **调用方**。由**工具**发起 → 结果是父会话**同一轮里的工具结果**，父会话据此继续；由**我们的插件**直接 `start()` 发起 → 只回到**我们**，父会话**不会**被唤醒 | ❌（工具路径除外） | ❌ 终态 |
| **可续接**（`startContinuable`；**本机 `subagent_fork` 工具配置的就是 `backgroundMode: continuable`**） | ① 子会话**主动** `sendMessage` 给父会话（模型写的 relay 消息）；② 子会话 settle 时，**运行时尝试**往**父会话日志**追加一条 `subagent-settled` **结算通知**（user 消息：一句话结论 + 它的结束语）→ **这是父会话得以继续的通道** | **尽力而为**（见下"投递的真实边界"） | ✅ 持久会话，按顺序收后续消息，可单独 Stop |

> **⟹ 产品结论（已按此更正 `docs/08` Q6）**：只要目标是"**主会话根据子会话结果继续后面的任务**"，
> 就必须走**可续接**，而不是一次性。一次性只在"我只要一个结果、自己处理"时用。

**⚠️ 投递的真实边界（`lib/index.js:1254-1267` 的 `notifySettlement`，实测）——文档与界面都不许越界承诺**

| 情形 | 实际行为 |
|---|---|
| 父 Agent 在进程里 | 投递结算通知 |
| **父 Agent 不在进程里**（`ctx.agents.get(parentSession)` 取不到） | **直接 return，不投递**（该通知不会凭空出现在日志里） |
| 投递过程抛异常 | **只 `logger.warn`**，不重试、不上抛 |
| 父会话**正忙** | 走 **steer**（就近插入），**不是**"保证立刻开一轮新 turn" |
| 子会话的 `send_message` 工具可用时 | 运行时**在首条任务后自动追加返回指引**（见下）；不可用时**不追加** |

⟹ 所以准确的说法是：**"运行时尝试投递；成功投递后父会话会（按队列或 steer）收到并据此继续"**，
**不是**"父会话一定会立刻自动继续"。界面必须按 `docs/03` R5.1 第 4 项分成两个状态显示。

**两条必须写进实现的配套事实**

1. **返回指引是运行时自己加的，不是插件 API**：`withContinuableReturnGuidance(parentId, prompt)` —— ⛔ **禁止**插件 import / 复刻 / 调用它（它是运行时内部函数，既可能导不到，也会造成重复注入）。
   它由运行时在 **`startContinuable` 内部、且相邻 `send_message` 工具可用时**调用
   （定义在 `lib/index.js:599`，调用点 `:1738`），把下面这段接在子会话首条任务后面：
   > *"Your parent agent id is `<id>`. Before you finish, send your result to that agent with `send_message({…})`.
   > **The parent does not automatically receive your transcript, tool output, or reasoning.**
   > Send earlier messages as well when a finding changes what the parent should do next; sending a message does not end your turn."*

   ⟹ **我们只负责传"人写的首条任务"**，**不要**去 import/复刻这个内部函数（既可能导不到，也会造成重复注入）。
   "指引到底有没有被加上"由 **V11 真机验收**（检查子会话初始消息里是否含该引导、`send_message` 是否可用），不靠假设。
2. **结算通知由运行时投递**（**不是工具**）：`createSettlementMessage(childId, terminal)`（`lib/index.js:633`），
   `stopReason` 的人话映射：`completed`→"finished and will do no further work unless you send it more."；
   `aborted`→"was stopped before it finished."；`max-tokens`→"ran out of room"；`refusal`→"declined"；`error`→"failed"；
   未知→"ended abnormally (<reason>)"（**不粉饰成功**）。
   它的来源 kind 是 `subagent-settled`（`form:'notice'`），与"另一个 Agent 写给它的消息"（kind `agent-message`，`form:'relay'`）**刻意区分** ——
   因为"孩子自己说的话"和"运行时说孩子怎么了"不能混为一谈。

**还有一条容易漏的**：**子会话的工具审批不继承父会话**（`docs/01` F10 已说"不继承父会话任何权限"）。
子会话自己调工具时仍按宿主审批机制走，可能在"等待用户授权"处**长时间停住**（表现为 running 但不动）。
面板必须把"**等待授权/未知阻塞**"与"运行中"分开显示，并**跳转到官方子会话视图去处理**——**我们绝不代替它审批**。

### F13 · ⚠️ 插件直调**绕过工具级审批**（实测 + 推断）

`ctx.subagents.start` / `ctx.compaction.compactNow` 内部只做"capability 与语义检查"，
**没有审批门**；审批只存在于**模型走工具**的路径上（`tools/pre-execute`，例如 `dsh-experimental-auto-review`）。

- **实测**：服务定义与实现里没有 approval 调用点。
- **推断（保守取信）**：插件直调 = 绕过 auto-review。
- **因此**：本插件**必须自己承担授权**——每个会写会话/建会话/不可逆的动作，
  事前在界面上列「改哪一条、改成什么、影响范围、理由」，等人点头。

### F13.1 · 子会话在工作区里**怎么呈现**——官方已经做了，我们**不要重造**

**投影（平台权威，两侧都有）**

| 投影 key | 挂在谁身上 | 内容 |
|---|---|---|
| `subagentCatalog` | **父会话** | 直接子会话目录 `{id, createdAt, mode:'one-shot'\|'continuable'\|'unknown', label?}[]`；来自父会话日志里的 `subagent/catalog` 事件（`establishCatalogChild` 写入）；**排除 fork 继承来的事实** |
| `subagentTiming` | **子会话** | `{settledMs, active?:{since,through}, lastTurnCompleted?}` —— 活跃轮次耗时与"最近一轮是否正常结束" |
| `subagent` | **子会话** | 它自己的身份 `{mode, label, seq}`；`session.isOwnSeq(seq)` 用来证明来自**自己的日志后缀**（而不是 fork 种子里重放的祖先描述符） |

**官方 UI（`dsh-client-ui-subagent`，已随运行时挂载，含中文）** 注册了 5 个槽位：
`conversation.session.header.lineage`（**父会话页头的血缘面包屑**）、`conversation.session.header.actions`（**后代数量触发器**）、
`sidebar.chat.conversation`（在**右侧 Sidebar** 渲染该子会话的对话）、`sidebar.right.pane.tab`、`conversation.composer`（续接输入区）。

它自己的 README（`$DSH_PKG/dsh-client-ui-subagent/README.zh.md`）写着：

> **"普通会话侧边栏会省略 subagent 对话，因此父会话页头目录是它们的导航入口。"**

由此（**这条推翻多数人的直觉，也推翻本文档早期版本**）：

- 子会话**是**真会话（独立 sessionId、独立日志、持久化），但**不会出现在左侧会话列表里**；
- 导航入口在**父会话页头**：标题即谱系面包屑；子孙数量触发器**悬停 150ms** 打开目录树，可**按需**加载任意深度的后代；
- 打开方式：菜单里选一个 → 以确切的 `{parentSessionId, childSessionId, mode}` 地址打开它的对话；行尾箭头可在**右侧 Sidebar** 独立分栏打开；
- 行上显示：mode、活动状态（running / 最近一轮正常结束=绿点 / 其他 inactive=灰点，14px 对齐列）、日志支撑的 title、token 用量、活跃轮次耗时；
- **可续接**子会话在父会话活着时保留**普通输入区**（后续消息进它的 FIFO inbox），运行中有独立的 **Stop**（走 `subagents/interruptByParent`）；
- **一次性**子会话是**只读**的（当执行记录看）。

**⟹ 本插件必须遵守的两条**：
1. **不自己画会话树、不在左侧列表里嵌套子会话**（会和官方页头目录重复，并与"普通侧边栏省略 subagent"打架）；
2. 我们的「快照与子会话」面板只做**索引 + 状态 + 动作 + 跳转**：哪个快照生了哪些子会话、现在什么状态、要不要派活/压缩/打断；
   看全文一律**跳到官方视图**（页头目录或右侧 Sidebar），不在我们的面板里重画一个对话。

### F13.2 · fork 子会话**可以**是"可续接"的（实测：fork provider 实现了 `prepareContinuable`）

`$DSH_PKG/dsh-subagent-fork-in-process/lib/index.js`（全文 2.4KB，可复核）：

```js
class ForkInProcessProvider {
  name; capabilities = { agentOptions:true, outputSchema:true, depthLimit:true, toolFilter:true, persona:true };
  inheritsParentContext = true;
  start(request) { const seed = completedTurnPrefix(request.parent); return startInProcessRun(request, seed.length>0?{seed}:{}) }
  prepareContinuable(request) { const seed = completedTurnPrefix(request.parent); return Promise.resolve(seed.length>0?{seed}:{}) }
}
```

`SubagentProvider.prepareContinuable` 的**方法存在本身就是能力**（`dsh-subagent/lib/types/types.d.ts:360-375`：
"Method presence IS the capability"），且"provider 在可续接子会话里的**唯一参与**就是提供这份 detached creation spec"——
身份预占、组合、Agent 创建、prompt 投递、冷恢复、所有权与销毁全由 continuation manager 负责。

**⟹ 结论**：`ctx.subagents.startContinuable({ provider:'fork', … })` **合法且可用**，
所以我们能同时拿到 **"用（人编辑过的）父会话已完成轮次做种子"** + **"跑完自动回传唤醒父会话"**。
这也解释了为什么本机 `subagent_fork` 工具配的就是 `backgroundMode: continuable`。

### F13.3 · 官方 Agent Teams（实验性）：**teammate 就是"可续接子会话"**

**接线（实测，安装树）**：官方用一个组合包 `@deepseek-ai/dsh-experimental-agent-team-profile` 启用，它的 patch 做两件事：

```yaml
# ① 禁掉四个旧工具
- id: tool-subagent-control      disabled: true
- id: tool-subagent-list-agents  disabled: true
- id: tool-subagent              disabled: true     # 模型不能再调 subagent（spawn 委派）
- id: tool-subagent-fork         disabled: true     # 模型不能再调 subagent_fork（fork 委派）
# ② 插入官方三件套
- id: agent-team       name: dsh-experimental-agent-team        config: { maxMembers: 8, … }
- id: tool-agent-team  name: dsh-experimental-tool-agent-team   config: { freshProvider: spawn, forkProvider: fork }
- id: ui-agent-team    name: dsh-experimental-client-ui-agent-team
```
（`$DSH_PKG/dsh-experimental-agent-team-profile/cordis.patch.yml`）

| # | 事实 | 出处 |
|---|---|---|
| F28 | **teammate 走 subagent seam**：领域包里直接调用 `ctx.subagents.startContinuable` / `.interrupt` / `.drainContinuableChildren`；`freshProvider: spawn`、`forkProvider: fork` ⟹ **teammate = 可续接子会话**（fork 型 teammate 也用父会话已完成轮次做种子） | `$DSH_PKG/dsh-experimental-agent-team/lib/index.js`（grep 命中） |
| F29 | **启用团队会禁掉模型的委派工具**：`subagent` / `subagent_fork` / `subagent-control` / `subagent-list-agents` 四个工具被 `disabled: true`；Workflow 仍可建 fresh 子代理 | 同上的 bundle patch |
| F30 | 团队 UI 在**会话页头的 Agent Teams action**：读 Lead 会话的 `agentTeam` 投影，显示 roster（provisioning/running=loading、inactive=人物图标、failed=红点）+ **只读**任务板（pending 灰点 / 被依赖阻塞=橙点 / in-progress=loading / completed=绿点）+ 成员导航（选 active teammate → 打开它那个**普通 continuable 子会话地址**） | `$DSH_PKG/dsh-experimental-client-ui-agent-team/README.zh.md` |
| F31 | 团队需要**持久会话存储**才激活；`maxMembers` 本机 bundle 设为 **8**（文档默认 16）、`maxTasks` 256、单成员排队消息 64、单条消息 64 KiB | `agent-team` 与 bundle 的 README/config |

> **对本插件的三条含义**（写进 `docs/03` R5.1 与 `docs/08` Q12）：
> 1. **teammate 会出现在同一个"后代"目录里**（因为都进 `subagentCatalog`）→ 我们的索引**不能假装它不存在**：
>    用 `tryMembership` 判定来源并给徽章（比按 label 猜准）；
> 2. **绝不重复实现协作层**（消息 / 任务板 / 成员导航官方已有）——但要**接上它**（见 F32）；
> 3. ⚠️ **官方禁的是"工具"，我们用的是"服务"**（`ctx.subagents.startContinuable`）。官方团队自己也调这个服务，
>    所以理论上不受影响 —— 但**必须实测**（见 §6 的 V12），因为这是 M5 主线的地基。

### F32 · ★ 对接面：官方把**服务**也暴露出来了（`ctx.agentTeams: TeamService`）

实测（源码 + 安装树一致）：`@deepseek-ai/dsh-experimental-agent-team` 注册 cordis 服务 **`ctx.agentTeams`**；
`@deepseek-ai/dsh-experimental-tool-agent-team` 的九个工具只是它的**模型侧包装**（工具逐个调 `ctx.agentTeams.*`）。
**所以我们的宿主半可以直接调它** —— 这就是"用好官方功能"的正确姿势。

| 方法（源码 `packages/experimental/agent-team/src/index.ts`） | 签名要点 | 谁能调 |
|---|---|---|
| `tryMembership(agent)` / `membership(agent)` | 该 Agent 的团队身份/角色（`undefined` = 不是成员） | 任何活 Agent |
| `listMembers(agent)` | roster（Lead + teammates，创建顺序） | 团队成员 |
| **`spawnTeammate(caller, request)`** | **★ 见 F33**：建一个具名、**可续接**的直接子成员 | **Lead** |
| `sendMessage(caller, {target, content, signal})` | 往**名册名**投递持久消息（返回 `accepted` / `queued`） | 团队成员 |
| `createTask(caller, {subject, description, blockedBy?, writeScopes?})` | 建共享任务（revision 1） | 团队成员 |
| `getTask(caller, id)` / `listTasks(caller)` | 读任务（**同步**） | 团队成员 |
| `updateTask(caller, {taskId, expectedRevision, action, …})` | `claim/release/edit/set_dependencies/complete/reopen/reassign/delete`，**带 revision 乐观校验**（过期编辑被拒，不覆盖） | 团队成员 |
| `waitForChange(caller, timeoutMs, signal)` | 等下一次团队变化（驱动实时刷新） | 团队成员 |
| `interrupt(caller, targetName)` | 打断某成员当前轮次 | Lead |

**⚠️ 三条工程约束（不遵守会加载失败或行为错）**

1. **必须"可选注入"**：团队未启用时 `ctx.agentTeams` **不存在** → 插件**不能**写死 `inject: ['agentTeams']`
   （那样团队一关插件就加载失败）。用可选/延迟挂载；**服务不在时所有对接点消失**（不是报错、不是空列表）。
2. **每个方法都要一个"活的 Agent"当凭据**，且**角色决定权限**（`spawnTeammate`/`interrupt` 要 Lead）。
   我们以**该会话的 live Agent**（`ctx.agents.get(sessionId)`）作 caller —— 会话不 live 时对接点全不可用（与 V3 同源）。
3. **团队状态写在 Lead 会话日志里**（事件 `team/member`、`team/task`、`team/message/queued|delivered`）
   → 又是"平台权威、我们**不复制**"。我们的 sqlite 只存平台不知道的东西（快照、来源关联、已查看标记）。

### F33 · ★★ `spawnTeammate` 支持 **`context: 'fork'`** ——"用我编辑过的上下文建一个成员"是官方正路

```ts
SpawnTeammateRequest = {
  name: string; description: string; prompt: ContentBlock[];
  context: 'fresh' | 'fork';   // ← fork = 用父会话「已完成轮次」做种子（= 我们编辑过的上下文）
  provider: string;            // 工具层映射：context==='fork' ? forkProvider : freshProvider（本机 = 'fork' / 'spawn'）
  signal: AbortSignal;
}
```
**源码证据**：工具层 `tool-agent-team/src/index.ts:182-208`（`context` 是工具参数，`provider` 按 context 选）；
服务层 `agent-team/src/index.ts:150` → `roster.spawn()` → **`ctx.subagents.startContinuable({...})`**（`roster.ts:282`）。

**⟹ 设计结论（`docs/08` Q12 的 A′，用户已定）**
- **优先走官方**：`ctx.agentTeams.spawnTeammate(lead, { context:'fork', provider: forkProvider, prompt: 人写的首条任务, name, description, signal })`
  → 得到的成员**进官方 roster**：任务板、成员导航、**官方派活**（`sendMessage` 的 target 是**名册名**）、`interrupt`、
  `waitForChange` 实时刷新、官方 UI 面板**全都有**。**我们一行协作逻辑都不用写。**
- **兜底**（团队未启用 / 服务缺失 / 拿不到 live Lead）：退回 `ctx.subagents.startContinuable({provider:'fork'})`
  → 一个**不进名册的裸续接子会话**：仍会被官方页头目录看到、仍会自动回流，但**没有任务板、没有官方派活**；
  界面必须**如实标注**当前是哪一种（`docs/03` R5.1）。
- **仍然自有的只有三样**：① 冻结快照记录；② "这条成员/子会话来自哪条快照"（`snapshot_links`）；③ 结算通知的"已查看"标记（`pending_results`）。

### F34 · 客户端读的是 `agentTeam` 投影（我们读**同一份**）

| 项 | 值 |
|---|---|
| key | `agentTeam`，挂在**团队根（Lead）会话**上 |
| 宿主状态 | `TeamState = {id, members, tasks, messages, delivered, nextTaskNumber}`（增量折叠自 `team/*` 事件） |
| 下发给客户端的 wire view | `TeamProjection` = **roster + 未删除的任务板**（+ 可选 `failure`；**投影失败是终态**，官方面板正是在最后有效 roster 之上显示该失败） |
| 我们怎么用 | 客户端半边：像读我们的 `redlineTimeline` 一样读 `agentTeam`（实时、无 RPC）；宿主半边：`ctx.sessionProjections.stateOf(session,'agentTeam')` 或 `listMembers/listTasks(lead)` |
| 任务视图 | `TeamTaskView` = 任务 + **负责人名** + **就绪状态（依赖是否都完成）** + **写入范围重叠警告** |

> **我们面板里显示官方 roster/任务板时，显示的就是这一份数据**——不复制、不缓存、不自己算就绪状态。

### F35 · ⚠️ 上游投影里的 `text` 是 **80 字空白折叠预览**，不是正文

上游 fold 用 `firstText(blocks)` 生成节点摘要：`b.text.replace(/\s+/g,' ').trim().slice(0,80)`
（上游 `src/host/pricing.ts`，在 `src/host/fold.ts` 赋给 `node.text`）。
⟹ **它既截断又压掉换行**，只能当"列表行的预览"，**绝不能**当"编辑器预填/提交"的正文。
**规则**：编辑器的读写一律走 `node.read`（宿主全文）；`docs/05` 的 **A4** 用"返回正文 ≠ 80 字预览"把它锁死。
（早期那次尝试正是把预览当正文，点一次「编辑+应用」就把整条消息截成 80 字 —— 数据破坏级缺陷。）

### F36 · 会话侧边栏里**没有**"缩进嵌子会话"这回事（插件也做不到）· 实测

用户 2026-10-01 问：微信群里有人把子会话**缩进嵌在左侧会话列表**里（看着像层级），DSH 能不能这样做？
核实结论（读安装树里官方包自己的文档，0.2.0-rc.2）：

1. `$DSH_PKG/dsh-client-ui-workspace/README.zh.md`：「待处理交互显示为警告点，**subagent 来源的 Session 则保持隐藏**。」
2. `$DSH_PKG/dsh-client-ui-subagent/README.zh.md`：「**普通会话侧边栏会省略 subagent 对话**，因此父会话页头目录是它们的导航入口。」
3. 官方在会话行上暴露的插槽**只有 action 类**：`sidebar.workspaces.session.menu.item`、
   `sidebar.workspaces.session.row.action`、`sidebar.session.row.leading`、`sidebar.session.row.hover`
   —— **没有"插入一条新会话行"的插槽**。

⟹ 那位朋友看到的界面**不是官方 DSH 默认行为**（可能是别人的改造/补丁，或别的产品）。
⟹ 本插件**不重复造**：沿用官方入口（父会话页头谱系目录 + 右侧 Sidebar）；想在会话行上加"后代 N"这类标记，
   只能用上面那几个 action 插槽，**不能**让子会话出现在会话列表里。要"左侧可见"得走上游产品建议。

### F37 · ★★ 会话之间**互通消息**的官方通道（多轮子会话的答案）· 实测（读安装树类型定义）

用户 2026-10-01 问：能不能在主会话里创建一个新会话来当子会话，**与它互通消息（多轮）**？
答：**能，而且我们选的"可续接"子会话本来就是多轮的** —— "只能一轮"是对 **one-shot**（`start()`）的印象，
不是 continuable 的行为。三条公开 API（`$DSH_PKG/dsh-subagent/lib/types/index.d.ts`）：

1. **人写的话 → 子会话的「下一个轮次」**：`ctx.subagents.prompt(request, signal)`
   —— *"Deliver one **browser-authored** message to a continuable child through the exact live direct parent…
   **Queue delivery targets a later turn**; steer delivery targets the nearest step"*。
   ⟹ 每发一条就是它的**一个新轮次**；`steer` 则是插到**最近的步骤边界**（不打断当前这步）。
   失败码含 `subagent/parent-unavailable`、`subagent/not-resumable`、`subagent/delivery-unavailable`（冷恢复遇容量上限）。
2. **双向**：`ctx.subagents.sendMessage(sender, targetId, content, options)` ——
   *"Steer one **model-authored** message to the sender's **direct parent or direct continuable child**.
   A running target admits it at the nearest step boundary; an idle target **starts a turn**, and
   **an absent direct child cold-resumes from persistence**."*
   ⟹ 子 Agent 也能主动给父会话发消息；父忙→最近步骤边界接收、父闲→起一个轮次、**不在进程→冷恢复**。
3. **可指定模型与推理档 + 短标签**：`SubagentStartRequest.agentOptions`
   = *"Optional host-Agent **provider, model, reasoning-effort, and output-token** overrides.
   Requires `SubagentCapabilities.agentOptions`; in-process providers merge them over the parent Agent's options."*；
   `label` = *"Optional short display label persisted with a session-backed child."*

**约束**（别忽略）：投递要求**直接父子邻接**（direct parent/child）且**发送方是 live Agent**；
子会话可以冷恢复、父会话不可以。另有一条运行时账目 `subagent-settled`（best-effort：父不在进程就不投递）。

**推论（我们据此决策）**：**不需要**为了"多轮"去造普通会话；反而普通会话**没有父子邻接** ⟹ 没有回程通道
（`prompt`/`sendMessage` 都会以邻接被拒）。缺的只是**界面入口**（打开子会话 / 给它发消息），这属于我们的面板职责。

---

## 5. 其它已核实事实

| # | 事实 | 位置 / 依据 |
|---|---|---|
| F14 | `pnpm install` 会**写穿** profile 符号链接（把悬空 symlink 写进共享 profile，曾真实发生并恢复） | 早期那次尝试 `AGENTS.md` §2.3（`scripts/link-dsh-runtime.mjs` 自身安全；危险的是 `pnpm install`） |
| F15 | 安全安装顺序：`rm -f node_modules/@deepseek-ai` → `pnpm install --ignore-scripts` → `node scripts/link-dsh-runtime.mjs` | 同上 |
| F16 | 客户端 bundle 由宿主**按需从磁盘读**并送到浏览器 → `tsc && tsdown` 之后**硬刷新即可**，不必重启 `dsh web` | 早期那次尝试 §2.5 的实测更正（2026-09-27） |
| F17 | 深色主题的选择器是 **`body[data-ds-dark-theme]`**（不是 media query，也不在 `html` 上）→ 不写配置也能实测深色 | 早期那次尝试 §2.5（实测值：`--dsw-alias-bg-layer-1` 浅 `#fff` / 深 `#232324`；`bg-layer-2` 浅 `#fff` / 深 `#2c2c2e`） |
| F18 | 两个 `@deepseek-ai` 依赖树**都不完整**：profile 层缺内部包、安装层缺 `react`/`react-dom`/`shiki`/`clsx` | 早期那次尝试 §2.5（2026-09-28 实测；`scripts/link-dsh-runtime.mjs` 默认链 profile 层） |
| F19 | `ctx.sessionProjections` 是**注册表**，不是数据源；`stateOf(session,key)` / `snapshot(session,keys?)` 返回值 | `$DSH_PKG/dsh-session-projection/lib/types/index.d.ts` |
| F20 | 宿主**没有**任何现成的"每请求上下文构成"投影；上游是靠自己的 fold 单元算出来并 `wire.view` 下发的 | 逐个枚举 0.2.0-rc.2 的 `SessionProjectionStateMap` 合并点：`turnOutline`/`contextBreakdown`/`tokenUsage`/`contextPressure`/`subagentCatalog`/`todos`/`goal`/`plan`… 无一是"每请求上下文清单" |
| F21 | 斜杠命令：`ctx.commands.register({name (小写无斜杠), description, handler(invocation)})`，`invocation = {commandId, agent, rawInput, attachments, signal}` | `$DSH_PKG/dsh-commands/lib/types/index.d.ts`；`/compact` 是完整范例（`$DSH_SRC packages/compaction/command-compact/src/index.ts:104-118`） |
| F22 | 系统提示词可按 Agent 作用域注入：`ctx.systemPrompt.section/context`（每 **preStep** 重新 assemble），一次性可用 `agent.inject(msg)` | `$DSH_SRC packages/core/agent-loop/src/agent.ts:246`、`runtime-context.ts:14-70`。**M7+** 才用 |
| F23 | `dsh --profile web --dump-config` 可**静态合成插件树而不 boot** → 用来确认插件挂载与我们的命名空间是否冲突 | 早期那次尝试 §2.5 |
| F24 | 子会话的目录/状态/身份**已有平台投影**：父会话 `subagentCatalog`、子会话 `subagentTiming` + `subagent` | `$DSH_PKG/dsh-subagent/lib/types/{catalog,projection-types}.d.ts`；见 §F13.1 |
| F25 | **子会话不进左侧会话列表**；导航入口是**父会话页头的血缘面包屑 + 后代数量触发器**；官方 UI 包 `dsh-client-ui-subagent`（5 个槽位，含右侧 Sidebar 打开子会话对话） | `$DSH_PKG/dsh-client-ui-subagent/README.zh.md`（原文见 §F13.1） |
| F26 | **fork 子会话可以可续接**：fork provider 实现了 `prepareContinuable`（方法存在即能力）→ `startContinuable({provider:'fork'})` 可用 | `$DSH_PKG/dsh-subagent-fork-in-process/lib/index.js` 全文；`dsh-subagent/lib/types/types.d.ts:360-375`；见 §F13.2 |
| F27 | 可续接子会话的回传由**运行时**负责：建时自动追加**返回指引**（`withContinuableReturnGuidance` —— ⛔ **插件禁止** import/调用它，只传人写的首条任务），settle 时往**父会话日志**追加 `subagent-settled` **结算通知** | `$DSH_PKG/dsh-subagent/lib/index.js:599,633`；见 §F12.1 |

---

## 6. 待验证（**不许**当依据，M1/M5 前必须补测）

| # | 待验证项 | 怎么验 | 影响 |
|---|---|---|---|
| V1 | `ctx.sessionQuery` 在本机 web profile 是否**真的挂载**（它在 base bundle 里） | `dsh --profile web --dump-config` + 在插件里 `ctx.inject(['sessionQuery'], …)` | 若不挂载，读路径要退回 live Session（并接受"只能读 live 会话"的降级） |
| V2 | `dsh-subagent-fork-in-process` 与 `dsh-compaction-basic` 是否都在 web profile 挂载 | 同上；本会话有 `subagent_fork` 工具 = fork 侧已挂载（强证据，但仍需确认 `fork` provider 名） | 若压缩后端缺失 → 压缩降级为"人在子会话执行 `/compact`" |
| V3 | `ctx.agents.get(sessionId)` 对**用户当前正在看的那个会话**是否总能拿到（尤其是没在跑轮次时） | 真机调用 + 日志 | 拿不到就不能 fork/派活，只能引导用户用原生工具 |
| V4 | 上游 `v0.59.2` 的投影 `stateVersion`（我们的基线复制后必须**改名**，因此不受其值影响，但要知道） | `git show v0.59.2:src/host/timeline.ts` | 只影响"万一不改名"的失败模式 |
| V5 | `MessageSourceMap` 增补自定义 kind 在**客户端**是否也要 declare 一份（类型侧） | 编译 + 真机 | 影响编辑层追加消息能否被 UI 正确归类 |
| V6 | 冷会话的 `readSurface` 是否包含被遮蔽节点的完整原文（我们要展示"原 #N"） | 真机读一个已压缩过的会话 | 影响"已应用改动"的展示 |
| V7 | 替换/回滚/多节点区间替换在**真机会话**上的行为（探针只用了 detached 会话） | 在真机会话（含 compaction checkpoint、含真实 tool-call 配对、含 fork 前缀）上重跑 F7.1 的四类操作 | 决定"回滚"能否覆盖压缩过的历史；决定 tool/result 的配对约束是否额外收紧 |
| V8 | 被遮蔽节点的原文如何读回来（回滚要用它） | `sessionQuery.readSession` 读全量日志后按 seq 取 `data`；确认 `readSurface` 只给当前 surface | 决定"历史版本"下拉的数据来源（要读全量日志而不是 surface） |
| V9 | 一条 replace 区间横跨**压缩 checkpoint** 时是否被拒 | 真机：对一个含 compaction checkpoint 的会话做区间替换 | 决定"遮蔽整段"是否只能在未压缩区间内做 |
| V10 | `subagentCatalog` / `subagentTiming` / `subagent` 三个投影在**真机**上能否读到（我们的面板要靠它们做索引，而不是自建 children 表） | 真机：在一个有子会话的父会话上读 `ctx.sessionProjections.stateOf(session,'subagentCatalog')`；在子会话上读另两个 | 决定我们的"子会话索引"是读平台还是自建（**默认读平台**） |
| V11 | `startContinuable({provider:'fork', …})` 在**真机**上端到端跑通，且**把失败情形也验掉**：① 子会话初始消息里**确实含**返回指引且 `send_message` 可用；② 父会话**在进程里**时 settle → 父日志出现 `subagent-settled`；③ 父会话**不在进程里**时 → 确认"不投递"这一行为（别期待有通知）；④ 父会话**正忙**时 → 确认走 steer 而不是立刻开新轮；⑤ 投递异常时只有 warn | 真机（包 B 授权后）：建专用会话 + 续存 fork 子会话，逐情形跑 | 决定"主会话能否接着干"这条主线的**真实**边界；若 ② 不稳或 ③ 常见 → M5 必须在面板上给"未确认/需人工查看"，并提供"让主会话接着做"的人工入口 |
| V12 | **官方 Agent Teams 启用时，我们的服务层调用是否仍可用**：① `ctx.subagents.getProvider('fork')` 是否仍在册；② `ctx.subagents.startContinuable({provider:'fork'})` 是否仍能建；③ 会话里到底还有没有 `subagent` / `subagent_fork` 工具（bundle 声明禁用了它们，但**以会话工具表实测为准**） | ① `dsh --profile web --dump-config` 看 `tool-subagent*` 是否为 `disabled`；② 真机调一次 `getProvider('fork')`（只读） | ⚠️ 这是 M5 的**地基**：官方禁的是**工具**、我们用的是**服务**。若服务也受影响 → M5 主线改为"引导用户走官方团队"，我们的面板只保留"编辑 + 快照" |
| V13 | **对接面在真机上可用**：① 插件**可选注入** `agentTeams` 能否成功（团队启用/未启用两种情形都不该让插件加载失败）；② `ctx.agents.get(sessionId)` 拿到的 Agent 能否通过 `tryMembership` 判定为 Lead；③ `spawnTeammate(lead, {context:'fork'})` 能否建出一个**进 roster、种子=父会话已完成轮次**的成员；④ `listTasks` / `createTask` / `sendMessage` 能否按名册名调用；⑤ 客户端能否读到 `agentTeam` 投影 | 真机（包 B 授权后）：在**专用会话**里逐项调；同时看官方面板是否出现该成员与任务 | 决定 A′（对接官方）是否成立。**若 `spawnTeammate` 不可用** → 降级为裸 `startContinuable` + 只读跳转（不再提供派活/任务板对接） |
