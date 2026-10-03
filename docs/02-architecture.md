# 02 · 架构

> 前置阅读：[`docs/01-platform-facts.md`](01-platform-facts.md)（平台能力与硬约束）、[`docs/00-scope.md`](00-scope.md)（做什么/不做什么）。

---

## 1. 一句话

**复制上游的"看得清"，自己写"改得动"和"编排得起来"。**

- L0/L1 是**事实**（平台给的、上游投影算出来的）——只读，不发明。
- L2/L3 是**我们的增量**（编排 + 编辑）——所有写入都经过"轮次边界 + 授权 + 可追溯"。
- L4 是**界面**——把"模型到底收到了什么、我改的生效没有"讲清楚。

---

## 2. 分层

```
┌────────────────────────────────────────────────────────────────────────────┐
│ L4  界面（本插件新增接线，外壳来自上游）                                     │
│  · 左侧：统计 / Token / 趋势图（轮次条，每轮标「用户消息 N · 注入内容 N」）    │
│          （「第 N 轮 · 第 M 步」卡片已按用户要求整张删除：轮/步选择器在右侧浏览器标题里） │
│  · 右侧：上下文浏览器（分类 + 条数/token/占比 + 步级下拉 + 每行 #seq）        │
│          ＋ 行内动作条（编辑 / 批注 / 版本历史）                     │
│          ＋ 行下内联编辑器（kind-aware，不弹窗）                             │
│          ＋ 常驻「还有 N 条未生效」                                        │
│          ＋ 子会话面板（开子会话 → 压缩 → 派活）                             │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲ ▼  RPC（/api/dsh-context-redline/redline）
┌────────────────────────────────────────────────────────────────────────────┐
│ L3  编辑面  src/redline/                                                   │
│  drafts      本地草稿（不进会话；原子写 JSON）                              │
│  inspect     取全文（编辑器的唯一预填来源，**不是**预览）                    │
│  apply       遮蔽改写：surface replace（user / tool-result；**assistant 平台不支持**，见 docs/01 F7.2）
│  rollback    版本历史 + 回滚（目标=当前可见节点，正文取历史版本；实测可行）             │
│  annotate    追加更正 + 作废范围（不遮蔽原文）                               │
│  invariants  逐字保存 / 版本留痕 / workspace 作用域 / 漂移检查 / 显式重注入   │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲ ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ L2  编排面  src/redline/orchestrate/                                       │
│  child       子会话（startContinuable({ provider:'fork', label, request:{parent,prompt}, signal })│
│              ——种子由平台 fork provider 自算；**可续接** → 收工由平台自动回流结算通知（docs/06 §3.1）│
│  compact     子会话压缩（ctx.compaction.compactNow(childAgent, signal)）     │
│  steer       发消息 / 看状态 / 打断（转发 ctx.subagents.prompt / subagentCatalog / interrupt）│
│  plan        纯函数判定「下一步该做什么 + 是否需要确认框」                    │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲ ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ L1  事实层（平台，只读）                                                     │
│  ctx.sessionQuery          readSurface（含全文）· readEvent · readSession     │
│  ctx.sessions              get / flush / append（仅写入用）                   │
│  ctx.agents.get           父/子 Agent（fork、compact、派活都需要）            │
│  ctx.subagents / ctx.compaction   见 docs/01 F10–F12                        │
└────────────────────────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────────────────────────┐
│ L0  投影层（复制上游 fold，**key 改名**）                                     │
│  redlineTimeline / redlineHeaders / redlineActivity → wire.view → useProjection│
│  概念：surface 节点（seq/cat/tokens/text/gone）、请求记录（turn/step/seq/分类 token）│
└────────────────────────────────────────────────────────────────────────────┘
```

**为什么读不全走投影**：投影是**我们自己的 fold 单元**（为了做趋势/历史/占比），而"某一条的完整正文"必须问宿主——
所以 `inspect` 用 `ctx.sessionQuery`，不用投影里的 `text`（投影里的 `text` 是 80 字预览；早期审计文档 `docs/07` 已删除，结论见 `docs/01` F35）。

---

## 3. 两条数据流

### 3.1 编辑一次（L4 → L3 → 宿主日志）

```
点「编辑」
  → inspect(seq)                       ← 取**全文**（text / reasoning / toolResultText / isError / provider / model）
  → 人在行下内联改
  → 保存草稿（只落我们的数据目录，**不进会话**）        ← 行上出现「未生效」
  → 保存只写本地；点「开启子会话」时逐字写进新会话的第一句话
       ├ turn 未闭合 → 事前禁用 + 说明原因（平台硬约束）
       ├ 会话不 live → 事前禁用 + 说明原因
       └ 通过 → append 一条 surfaceOp:{op:'replace', startSeq:seq, endSeq:seq}
                原文被遮蔽（gone = 新事件 seq），此后每轮读到的都是改后的
  → 行上显示「原 #N → 新 #M」；草稿删除
```

### 3.2 开子会话（L3 → L2 → 平台）

```
① 草稿全部提交（否则改动不在日志里 → 不会进种子）      ← 最易错的一条
② （建议）目标/约束存成 workspace 级固定块             ← 子会话要靠它守住漂移
        ——只写我们自己的库，**不写会话**
④ 开子会话（**可续接**，必须）——**以安装树 `.d.ts` 的签名为准**（`ContinuableStartSpec`，实测）：
        ctx.subagents.startContinuable({
          provider: 'fork',
          label: 短标签,                                  // **必填**
          request: { parent: ctx.agents.get(sessionId),   // 父 Agent 在 request 里
                     prompt: 人写的首条任务 },             // ContentBlock[]
          signal,
        })
        ——种子 = 父会话「最后一个 turn/end」**及其之前**的全部事件（含已应用的编辑），**由平台 fork provider 自算**
          （它内部用的是已废弃的同步读，**与我们无关**）；其后父会话新轮次不进子会话
        ——**返回指引由运行时自己加**（`send_message` 工具可用时即可用）；`withContinuableReturnGuidance` 是运行时内部函数 → **禁止** import/复刻（`docs/01` F12.1）
⑤ 压缩：子会话空闲时 ctx.compaction.compactNow(子 Agent, signal)
        ——不可逆；失败码映射成人话（busy → "等它空闲"）
⑥ 指挥：sendMessage(父 Agent, childId, 人写的任务, {signal}) / 读 subagentCatalog 看状态 / interruptByParent
⑦ 回流（**平台自动，我们只是显示**）：子会话 settle → 运行时往父会话追加 `subagent-settled` 通知
        → 父会话据此继续下一轮；面板把它列进「待处理的结果」
```

---

## 4. 模块与文件布局（计划，M1 起落地）

```
src/
├─ host/            ← 上游 tag v0.59.2（复制；改动面尽量小，见 UPSTREAM.md §3.2）
│   ├─ index.ts         挂载点（上游只在此加一行 watch 我们的通道）
│   ├─ redline-channel.ts ★ **我们唯一的上游接线文件**（RPC 端点 + `op` 分发 + 注入 host 服务）
│   ├─ fold.ts          投影 fold（上游；key 已改名，见 docs/01 F2）
│   └─ ...
├─ client/          ← 上游 tag v0.59.2（复制）
│   ├─ components/browser.tsx     ★ 我们改：动作条 / 内联编辑器 / 轮次选择 prop
│   ├─ components/contextView.tsx ★ 我们改：编辑 hook 接线 / 轮次联动 / 子会话面板
│   ├─ i18n.ts                    ★ 我们改：新文案 + 补齐上游缺的 key
│   └─ ...
├─ redline/         ← 我们新增：**全部纯逻辑**（禁 `node:*` / DOM / React；edit lane 直接单测）
│   ├─ drafts.ts        草稿存储（原子写）
│   ├─ inspect.ts       取全文（sessionQuery）
│   ├─ apply.ts         遮蔽改写（surface replace，规则照 docs/01 F6/F7 写死）
│   ├─ annotate.ts      追加更正 + 作废范围
│   ├─ eligibility.ts   能力判定（**按底层事件类型**给按钮，docs/01 F7.2）
│   ├─ invariants.ts    逐字固定块（版本 / workspace 作用域 / 漂移判定）
│   ├─ orchestrate/     ← 编排面的纯逻辑（只装配请求与判定，**不直接调平台服务**）
│   │   ├─ child.ts         建子会话 / 建团队成员的请求装配（真正执行在 host 通道）
│   │   ├─ compact.ts       压缩体检 + 失败码 → 人话
│   │   ├─ steer.ts         发消息 / 打断的请求装配（转发官方）
│   │   └─ plan.ts          纯函数「下一步该做什么」+ 事实装配
│   └─ store.ts         sqlite（schema_version / invariants / history / snapshots /
│                        snapshot_links / pending_results）——**不存 children**：
│                        子关系与状态一律来自平台投影与父日志（docs/01 F13.1）
├─ shared/          ← 两半共用（**唯一**路由与请求形状来源，防 404）
│   └─ redline-route.ts
└─ （无 `src/index.ts`：Host 入口 = `src/host/index.ts`，客户端入口 = `src/client/index.ts`）
tests/
├─ edit/            ← 自有 lane（纯逻辑；不 import 客户端 primitives）
└─ channel/         ← 自有 lane（真实路由级；捕获精确 Fetch 路由后按真实信封调用）
```

**纪律**：客户端 bundle **不得** import `src/redline`/`src/host`（上游有 bundle purity 检查）。
两半只能通过 `shared/` 的类型与常量交流（**历史归档线**里，早期那次尝试的 `tests/redline/route-pairing.spec.ts` 就是守这条的；该目录名已废弃，现行是 `tests/edit/`）。
`src/redline/rows.ts` 这类"纯投影"可以放在能被客户端 `import type` 的位置（编译后无运行时依赖）。

---

## 5. 公开接口

### 5.1 HTTP 路由（全部在我们自己的前缀下）

| 路径 | 用途 | 来源 |
|---|---|---|
| `/api/dsh-context-redline/redline` | 编辑面 RPC（单端点 + `op` 分发） | 我们 |
| `/api/dsh-context-redline/detail` | 时间线明细（客户端第二次拉取，按需） | 上游改名 |
| `/api/dsh-context-redline/balance` | 余额胶囊 | 上游改名 |
| `/api/dsh-context-redline/backfill` | 历史回填 | 上游改名 |

**注册方式**：`ctx.connection.fetch.register({ path, methods:['POST'], requestBody:'buffered', fetch })`
**响应信封**：成功 `{ok:true, value}` / 失败 `{ok:false, error:{code,message}}`，`cache-control: no-store`。

### 5.2 RPC op 清单

> `op` 名与请求/响应形状**只能**在 `src/shared/redline-route.ts` 里定义（两半共用；这是防"前缀/形状不成对 404"的唯一手段）。

**只读（不写会话，不需要确认框）—— 14 条**

| op | 请求 | 响应 | 说明 |
|---|---|---|---|
| `node.read` | `{sessionId, seq}` | `{type, cat, text, reasoning?, toolResultText?, isError?, provider?, model?, turn?, step?, shadowed?, replacedBy?}` | **全文**（编辑器唯一预填来源） |
| `draft.list` | `{sessionId}` | `Record<seq, draft>` | 草稿表 |
| `edits.list` | `{sessionId}` | `{replacedSeq, newSeq, type, turn?, step?, time}[]` | 已生效的替换关系（渲染「原 #N → 新 #M」） |
| `history.list` | `{sessionId, seq}` | `{version, seq, kind:'origin'\|'edit'\|'rollback', time, text, reasoning?, toolResultText?}[]` | **版本历史**（回滚要用）。正文来自**全量日志**（`sessionQuery.readSession`），因为被遮蔽的原文不在 surface 上（`docs/01` V8） |
| `turnState` | `{sessionId}` | `{known, open}` | 轮次是否闭合（`known:false` = 判不了） |
| `invariant.list` | `{sessionId}` | `InvariantBlock[]` | 含 workspace 级 |
| `invariant.history` | `{id}` | `InvariantBlock[]` | 全部版本（含退休） |
| `invariant.drift` | `{sessionId}` | `{id, label, present, firstSeenSeq?}[]` | 漂移检查（逐字比对当前 surface） |
| `plan.next` | `{sessionId}` | `NextStep` | 「下一步该做什么 + 是否需要确认框（点确认即授权）+ 理由」 |
| `child.list` | `{sessionId}` | `ChildRow[]` | **读平台投影**：父会话的 `subagentCatalog` / `agentTeam` + 各子会话的 `subagentTiming` / 用量。**不自建 children 表**、不推断状态（`docs/01` F13.1/F24/F34）；用 `tryMembership` 标来源 |
| `team.members` | `{sessionId}` | `TeamMemberView[]` \| `null` | 转发官方 `ctx.agentTeams.listMembers(lead)`；**服务不存在 → 返回 `null`**（不是空数组，界面据此隐藏对接点） |
| `team.tasks` | `{sessionId}` | `TeamTaskView[]` \| `null` | 读官方 `agentTeam` 投影 / `listTasks(lead)`——**同一份数据**，不复制、不缓存（`docs/01` F34） |
| `compact.state` | `{childId}` | `{canCompact, reason}` | 压缩前置条件体检（不写会话） |

> **条数（与 `docs/10` M0-09 / M6-01 的「读 12 + 写 13 + `team.*`」对齐）**：
> 只读 **14**（= 自有读 **12** + 官方团队读 `team.members`/`team.tasks` **2**）；
> 写入 **13**（表一，含 `child.interrupt`）；官方团队写入 **4**（表二）。合计 **31**。
> 官方团队服务不存在（团队未启用）时，`team.*` 一律返回 `null`（不是空数组），界面据此**隐藏**对接点。
>
> ⚠️ **界面上的「钉住这一段」只写本地、不写会话**（`docs/11` D9）：它落 `invariant.save`（本地逐字基准），**不**落 `invariant.inject`。让它进模型上下文有两条路：① **开子会话时**由 `child.fork` 把当时在效的固定块**逐字拼进子会话的第一句话**（于是只有那个新会话的模型读到）；② 在本会话里手动点 `重注入`（`invariant.inject`，追加一条消息）。
> —— 用户点一次确认就完成这两件事；**不许**拆成"只存本地、模型看不到"再让用户手动注入（那是用户明确否掉的形态）。

**写入（表一：本插件数据 / 会话日志 / 子会话通道）—— 13 条**

> 每一条都要求界面先出**确认框**（短警示 + 本次清单 + 理由）；**用户点「确认」即为该次授权**——
> 这不是"逐动作找人点头"（D5）。逐动作必须列的清单见 [`docs/06`](06-orchestration.md) §4 的 A1–A11。

| op | 请求 | 响应 | 写哪里 | 可逆？ |
|---|---|---|---|---|
| `draft.update` | `{sessionId, seq, patch}` | `Record<seq, draft>` | 我们的数据目录 | ✅ 可删 |
| `draft.reset` | `{sessionId}` | `{}` | 我们的数据目录 | ✅ |
| `apply` | `{sessionId, seq, draft?}` | `{replacedSeq, newSeq, type, turn?, step?, flushed}` | **会话日志**（追加 replace） | ❌ append-only；**但可再改/可回滚**——目标换成"当前可见的那个替换体"即可（`docs/01` F7） |
| `apply.rollback` | `{sessionId, seq, toSeq}`（`seq` = 当前可见节点，`toSeq` = 要恢复到的版本） | `{replacedSeq, newSeq, restoredFrom, flushed}` | **会话日志**（追加 replace，正文取 `toSeq` 那一版） | ❌ append-only；回滚本身也可再回滚 |
| `annotate` | `{sessionId, seq, reason, voidFrom?, voidTo?}` | `{targetSeq, newSeq, voidFrom?, voidTo?, flushed}` | **会话日志**（追加 user 消息） | ❌ |
| `invariant.save` | `{sessionId, label, text, scope, id?}` | `InvariantBlock` | 我们的 sqlite | ✅ 可退休（历史保留） |
| `invariant.retire` | `{id}` | `{id, retired:true}` | 我们的 sqlite | ✅ |
| `invariant.inject` | `{sessionId, id, reason}` | `{newSeq, flushed}` | **会话日志**（追加 user 消息） | ❌ |
| `child.fork` | `{sessionId, recordId?, label, prompt}` —— `recordId` 只用于**来源凭证/备注**（写 `snapshot_links`），**不是种子参数**：平台 fork **没有**任何切点参数（`docs/01` F38） | `{childId}` | **创建新会话**（优先 `ctx.agentTeams.spawnTeammate`；兜底 `ctx.subagents.startContinuable({provider:'fork', label, request:{parent, prompt}, signal})`）。**实际种子 = 平台自算的"当前最后一个 `turn/end` 及其之前"** | 会话可归档，但父会话种子是**一次性**的 |
| `child.compact` | `{childId}` | `{compacted, items?, reason?}` | **子会话历史被摘要取代** | ❌ **不可逆** |
| `child.prompt` | `{requestId（**由我们铸造**：`SubagentPromptRequestId`）, parentSessionId, childSessionId, mode:'continuable', delivery:'queue'\|'steer', content: PromptContentPart[]}` | `{messageId}`（`ctx.subagents.prompt(request, signal)` 的回执） | 子会话 inbox（人写的一条话 = 它的**下一个轮次**） | ❌ |
| `child.interrupt` | `{childId, parentSessionId}` | `{accepted:true}` | 子会话（`ctx.subagents.interruptByParent(childSessionId, parentSessionId, 'continuable')`；**团队成员**走表二 `team.interrupt`） | ❌ 已提交的工作不回滚 |

**写入（表二：官方 Agent Teams 转发）—— 4 条**

> 团队不可用时这 4 个 op 返回 `null`，界面**不出现**对接点（docs/01 F31/F33、docs/06 §3.2）。
> `lead` = `ctx.agents.get(sessionId)` 拿到的 live Lead Agent。

| op | 请求 | 响应 | 写哪里 | 可逆？ |
|---|---|---|---|---|
| `team.createTask` | `{subject, description, blockedBy?, writeScopes?}` | `TeamTaskView` \| `null` | 官方 Lead 会话日志（`ctx.agentTeams.createTask(lead, request)`） | ❌ 但可用 `updateTask` 改 |
| `team.updateTask` | `{taskId, expectedRevision, action, subject?, description?, blockedBy?, writeScopes?, owner?}` | `TeamTaskView` \| `null` | 同上（**revision 乐观校验**：`expectedRevision` 过期即被拒，**不覆盖**） | ❌ |
| `team.sendMessage` | `{target（名册名）, content: ContentBlock[]}` | `{messageId, status:'accepted'\|'queued'}` \| `null` | 官方成员邮箱（`ctx.agentTeams.sendMessage(lead, request)`） | ❌；`queued` **不重发**（如实显示） |
| `team.interrupt` | `{target（名册名）}` | `{previousStatus:'running'\|'inactive'}` \| `null` | 官方成员（`ctx.agentTeams.interrupt(lead, targetName)`） | ❌ 已提交的工作不回滚 |

### 5.3 主机斜杠命令

`/redline <子命令>`：

| 子命令 | 行为 | 是否写会话 |
|---|---|---|
| `/redline children` | 列出子会话与状态 | 否 |
| `/redline compact <childId>` | 压缩指定子会话（先体检） | **是（不可逆）** |
| `/redline invariants` | 列出固定块与漂移状态 | 否 |
| `/redline drift` | 只报漂移 | 否 |

**为什么命令里不提供 apply/annotate**：斜杠命令最容易在"没看清改哪一条"的情况下误触，而遮蔽不可撤销。
编辑必须在界面上**看着那一行**做（这也是"编辑在行下内联展开、不弹窗"的同一条理由）。

### 5.4 内部服务

导出 cordis Service（`ctx.redline` 之类的命名），把 `inspect / apply / annotate / invariants.* / plan` 暴露给其它插件与命令复用。
**这是图 2 里"内部服务"入口的对应物**；工具入口见 `docs/00` N6 与 `docs/08`。

---

## 6. 数据与本地存储

```
$DSH_HOME/dsh-context-redline/
├─ redline-drafts-<safeSessionId>.json   草稿（每会话一文件；原子写 .tmp + rename）
└─ history.sqlite
   ├─ schema_version(version)            我们的格式版本（**只备将来升级用**；首启即空库，无旧数据可迁，见 `docs/08` Q8）
   ├─ invariants(id, session_id, version, created_at, label, text, retired_at, scope)
   ├─ history(id, ts, kind, session_id, category, action, payload)
```

> **子会话的权威事实在平台，不在我们这里**：谁是谁的子会话由**父会话日志**里的 `subagent/catalog` 事件决定
> （投影 `subagentCatalog`）；状态与耗时来自子会话的 `subagentTiming`；完成原因来自父会话日志里的 `subagent-settled` 通知。
> **不再有 `snapshot_links`**（`docs/11` D10 删掉冻结后，"来源记录"这个概念也一起删了）。
> ⚠️ 平台 fork 的种子恒为"父会话**当前最后一个 `turn/end` 及其之前**"，**没有任何参数**能指定更早的切点（`docs/01` F38）；
> 所以界面上**不许**出现"从某条记录 / 某个更早位置开始"的说法（`docs/03` R5.1）。
> ⟹ **不要复制一份 children 表**去和平台对账——那必然会漂移（`docs/01` F13.1）。

- **不写** `$DSH_HOME/profiles/*`、不写 DSH 安装目录、不写会话日志（除非用户点了写入类动作）。
- **`digest` = 内容哈希（`counts` = 条目数等计数）**，**不是**人话摘要：本插件**不生成任何摘要/总结**（N4：不产生 AI 生成内容），人写备注里也不许出现"摘要"字样。
- `schema_version` 存在的理由：要**继承**早期那次尝试 时期已经存在的 `invariants` 表（用户已有的固定块不该丢）。
- 机密性：这里存的是**用户自己的上下文正文**（可能含私密内容），与 DSH 会话日志同等敏感；不做任何外发。

---

## 7. 错误模型

| 场景 | 对外表现 |
|---|---|
| 会话不在本进程（冷会话/别人的会话） | `turnState.known=false` → 界面前事禁用所有写入类动作，文案说明"这个会话不在本进程里，只能看" |
| 轮次未闭合 | `apply`/`annotate`/`inject` 事前禁用 + 理由；**不靠点击后报错** |
| 目标已被遮蔽 | 行上不出现「编辑」，并显式给原因（"原文已被遮蔽（#N）；要再改请用批注"） |
| 草稿不存在 / 无实质改动 | 宿主拒绝并给原文（`redline/no-draft`、`no uncommitted edit`） |
| 作废范围非法 | 只给一端 / `from > to` → 拒绝（`redline/bad-range`） |
| 压缩 `busy` | "子会话正在跑或轮次未闭合，等它空闲再压缩" |
| 压缩其它失败码 | 逐码映射：`cancelled`=已取消 / `changed`=区间被改动 / `summary`=摘要失败 / `commit`/`persistence`=落盘失败（**失败尝试会留在日志里**，如实说） |
| fork 时父 Agent 不在 | 明确告知"拿不到这个会话的活 Agent，无法开子会话"，并给替代路径（原生 `subagent_fork` 工具） |
| `flush` 失败 | **不假装成功**：响应 `flushed:false`，界面提示"已写入内存日志但落盘失败" |

---

## 8. 与上游的关系（工程约定）

1. **改动越少越好**：上游文件只在"必须接线"处改（`browser.tsx` / `contextView.tsx` / `i18n.ts` / `client/index.ts` / `host/index.ts`）；我们的东西集中在 `src/redline/`（含 `src/redline/orchestrate/` 的编排纯逻辑）、`src/shared/redline-route.ts`、`src/host/redline-channel.ts`（**唯一**上游接线文件）。
2. **基线固定**在 tag `v0.59.2`；上游 `main` 已在其后（`6778768`，2026-09-29），**按需 cherry-pick**，不追。
3. 每次改上游文件，都要在 `UPSTREAM.md` §3.2 记一行"改了什么、为什么"。
4. 上游的告警/遥测类入口（版本检查、社交预览等）M1 复制时按需裁掉——它们会引入我们不需要的网络行为。
