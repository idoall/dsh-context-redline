# 02 · 架构

> 前置阅读：[`docs/01-platform-facts.md`](01-platform-facts.md)（平台能力与硬约束）、[`docs/00-scope.md`](00-scope.md)（做什么/不做什么）。

---

## 1. 一句话

> **当前状态边界**：`demo/` 是当前可交互原型；本文件后面的 L0–L4、RPC、宿主服务和编排表是 M1–M6 的**未来插件实现计划**，不是当前 demo 已提供的功能。当前 demo 的可见契约以 `docs/03` 的“当前 demo”段落和 `demo/README.md` 为准。

**复制上游的"看得清"，自己写"改得动"和"编排得起来"。**

- L0/L1 是**事实**（平台给的、上游投影算出来的）——只读，不发明。
- L2/L3 是**我们的增量**（编排 + 编辑）——所有写入都经过"轮次边界 + 授权 + 可追溯"。
- L4 是**界面**——把"模型到底收到了什么、我改的生效没有"讲清楚。

---

## 2. 分层

```
┌────────────────────────────────────────────────────────────────────────────┐
│ L4  未来插件界面（当前可交互原型见 demo/，不是已装配插件）                    │
│  · 计划界面：统计 / 趋势 / 浏览器 / 子会话（实际 demo 以 docs/03 当前段落为准）  │
│          （「第 N 轮 · 第 M 步」卡片已按用户要求整张删除：轮/步选择器在右侧浏览器标题里） │
│  · 当前 demo 已做：上下文浏览器分类行、编辑/本地保存/子会话确认                    │
│          ＋ 行内动作条（**只有 `编辑`**；有本地改动时多一个 `丢弃这条改动`） │
│          ＋ 行下内联编辑器（kind-aware，不弹窗）                             │
│  · 未来插件计划：apply/未生效吸顶/更多编排能力（当前 demo 不提供）                 │
│  · 当前 demo：开启子会话 + 只读索引；压缩/派活/团队操作属于后续插件阶段             │
└────────────────────────────────────────────────────────────────────────────┘
                                   ▲ ▼  RPC（/api/dsh-context-redline/redline）
┌────────────────────────────────────────────────────────────────────────────┐
│ L3  编辑面  src/redline/                                                   │
│  drafts      本地草稿（不进会话；原子写 JSON）                              │
│  inspect     取全文（编辑器的唯一预填来源，**不是**预览）                    │
│  apply       遮蔽改写：surface replace（user / tool-result；**assistant 平台不支持**，见 docs/01 F7.2）
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

### 3.1 编辑一次（本地保存，不写当前会话）

```
点「编辑」
  → inspect(seq)                       ← 取全文（不是列表预览）
  → 人在行下内联改
  → 点「保存」                         ← 只写本地草稿，当前会话日志与模型不变
  → 行上显示「已改（本地）」；再次「编辑」预填最新版；「丢弃这条改动」回到原文
```

**当前 demo 不提供** `apply`、版本历史、回滚、批注、固定块或漂移检查入口。保存后的唯一写入点是「开启子会话」。

### 3.2 开子会话（本地改动唯一写入点）

```
点「开启子会话」
  → 确认框列出最后聊完的轮次、会写入的本地改动、首条任务、不会带上的内容
  → 人写首条任务并确认
  → 新会话第一句话逐字带入本地改动 + 首条任务
```

保存本地改动**不需要先应用**，也不会写父会话；取消确认不建会话。当前 demo 只展示开启入口和只读子会话索引，不提供派活、压缩、打断、团队任务或自动回流操作。


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
│   ├─ eligibility.ts   能力判定（**按底层事件类型**给按钮，docs/01 F7.2）
│   ├─ orchestrate/     ← 编排面的纯逻辑（只装配请求与判定，**不直接调平台服务**）
│   │   ├─ child.ts         建子会话 / 建团队成员的请求装配（真正执行在 host 通道）
│   │   ├─ compact.ts       压缩体检 + 失败码 → 人话
│   │   ├─ steer.ts         发消息 / 打断的请求装配（转发官方）
│   │   └─ plan.ts          纯函数「下一步该做什么」+ 事实装配
│   └─ store.ts         sqlite（schema_version / snapshots /
│                        snapshot_links / pending_results）——**不存 children**：
│                        子关系与状态一律来自平台投影与父日志（docs/01 F13.1）
├─ shared/          ← 两半共用（**唯一**路由与请求形状来源，防 404；也是**两半都要跑的纯逻辑**的家）
│   ├─ redline-route.ts     路由 + RPC 信封（防"前缀/形状不成对 404"）
│   ├─ redline-errors.ts    稳定错误码表（客户端按码出人话）
│   ├─ redline-paths.ts     数据目录常量
│   └─ redline-ability.ts   ★ 能力判定：**客户端也要**（决定行上给什么动作），
│                           而客户端不许 import `src/redline/**` ⟹ 规则放这里、只写一份
│                           （反向验证：在 src/client 里 import src/redline → 面 9 立刻红）
└─ （无 `src/index.ts`：Host 入口 = `src/host/index.ts`，客户端入口 = `src/client/index.ts`）
tests/
├─ edit/            ← 自有 lane（纯逻辑；不 import 客户端 primitives）
└─ channel/         ← 自有 lane（真实路由级；捕获精确 Fetch 路由后按真实信封调用）
```

**纪律**：客户端 bundle **不得** import `src/redline`/`src/host`（上游有 bundle purity 检查，`scripts/namespace-contract.mjs` 面 9 也机械断言）。
两半要**跑**同一段逻辑时，那段逻辑必须放在 `shared/`（`redline-ability.ts` 就是这么定的）—— 不许两边各写一份（一份按钮规则写两遍，正是早期那次尝试让「助手消息可改写」这种必然报错的分支上线的原因）。
（**历史归档线**里，早期那次尝试的 `tests/redline/route-pairing.spec.ts` 就是守这条的；该目录名已废弃，现行是 `tests/edit/`。）
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

> `op` 名与请求/响应形状**只能**在 `src/shared/redline-route.ts` 里定义（两半共用；这是防"前缀/形状不成对 404"的唯一手段）；
> **本节的表由 `src/host/redline-channel.ts` 的 `OPS` 表逐条核对**（2026-10-06 复核：8 条，见下）。
>
> ⚠️ **本节在 2026-10-06 做过一次"以实现为准"的重写**（Code Review 的一条 P2：旧表是 **2026-10-02 转向之前**的合同，
> 与实现只有 3 个名字重合，而它是两半共用的唯一契约 ⟹ 必须对齐）。旧表的 op 没有消失，而是被分到下面三段里：
> **A 已实现**（可调、有测试）· **B 计划中**（M5/M6 的落点，尚未实现）· **C 已作废**（转向的代价，附作废依据）。

#### A. 已实现（`OPS` 表里的 8 条，逐条可调）

**只读（不写会话、不需要确认框）**

| op | 请求 | 响应 | 说明 |
|---|---|---|---|
| `node.read` | `{sessionId, seq}` | `{type, cat, text, reasoning?, isError?, seq}` | 这一条的**完整正文**（`docs/01` F35：永远不是 80 字预览）。拒绝码：`shadowed`（已被接替）/ `not-found`（日志里也没有）/ `unsupported-type` |
| `turnState` | `{sessionId}` | `{known, open}` | 轮次是否闭合（`known:false` = 本进程判不了 ⟹ 界面只读） |
| `draft.list` | `{sessionId}` | `Record<seq, draft>` | 我们自己的草稿表 |
| `child.plan` | `{sessionId, humanTask}` | 确认框五项（切点 / 首条任务 / 继承与不继承 / 副作用 / 取消语义） | 开子会话前给用户看的清单；**不写任何东西** |
| `probe.services` | `{}` | 结构探针 | ⛔ **临时诊断 op（M4.5 期间用）**：`check-release-ready` 会在它还在时报红 ⟹ 发布前必须整段删除（`docs/11` 已记） |

**写入（只写我们自己的数据目录）**

| op | 请求 | 响应 | 写哪里 | 可逆？ |
|---|---|---|---|---|
| `draft.update` | `{sessionId, seq, edit:{text, reasoning?, isError?}}` | 新的草稿表 | 插件数据目录（`redline-drafts-*.json`） | ✅ 可 `draft.drop` |
| `draft.drop` | `{sessionId, seq}` | 新的草稿表 | 同上 | ✅ |

**写入（会话侧 —— 全插件唯一的会话写入点）**

| op | 请求 | 响应 | 写哪里 | 可逆？ |
|---|---|---|---|---|
| `child.start` | `{sessionId, humanTask}` | `{childId, label, carriedSeqs}` | **新开一个子会话**，把「人写的首条任务 + 逐字带入的改后正文」作为它的第一句话 | 子会话可归档；父会话**一个字都没写** |

> **硬约束的落点**（`AGENTS.md` §1 / `docs/11` D15）：`draft.*` 只写本地；**`child.start` 是唯一的会话写入点**。
> 因此旧表里的 `apply`（往会话日志追加 replace 事件）**不再存在** —— 见下方 C 段。
> 三条 JSON 路由（`/detail` `/balance` `/backfill`，见 §5.1）不是 op，它们是投影与历史回填的取数端点。

#### B. 计划中（M5 / M6 的落点，**尚未实现**）

> 这些名字来自 `docs/10` 的 M5/M6 任务行；**落地前不许在界面或文档里当成已可用**。
> 实现时必须先在这里与 `redline-route.ts` 同步（两半共用同一份词表）。

| op | 用途（对应任务行） |
|---|---|
| `child.list` | 读平台投影列父会话的子会话（M5-06 的一半；`docs/01` F34：不自建 children 表） |
| ~~`team.members` / `team.tasks`~~ | **【作废 · 2026-10-07】** 官方团队的名册与任务板**不进我们的界面**（用户 2026-10-07 裁定「按 demo 撤掉这两样」；原裁定见 [`docs/11`](11-session-handoff.md) **D14**，2026-10-02）⟹ 本插件**不再有** `team.*` op。团队的名册 / 任务板在**官方视图**里看（[`docs/11`](11-session-handoff.md) **D55**） |
| ~~`child.prompt` / `child.interrupt`~~ **【作废 · 2026-10-07】** | 用户 2026-10-02 晚已裁定面板**不提供压缩 / 打断**，且 2026-10-02 的减法表里「子会话行：打开 / 发消息」也是**删**（[`docs/11`](11-session-handoff.md) D14 / **D55**）⟹ 「发消息」与「打断」都不进我们的界面 —— 要打断就去**子会话自己的视图**（那里右上角就有） |
| ~~`compact.state` / 压缩确认与执行~~ **【作废 · 2026-10-07】** | 压缩服务被注册在 **agent 隔离作用域**里，第三方插件从自己的 fiber 调不到（[`docs/01`](01-platform-facts.md) **F54** 三证）⟹ 界面**不提供压缩执行入口**，改为"引导你在子会话里执行 `/compact`"（[`docs/10`](10-execution-checklist.md) M5-14/15/16/17 已按作废记账） |

#### C. 已作废（2026-10-02 转向的代价，**不要再实现**）

| 旧 op | 为什么作废 | 依据 |
|---|---|---|
| `apply` | 往会话日志追加 replace 事件 = 违反「所有保存都是临时保存」的硬约束 | `docs/11` D15（唯一写入点 = 开子会话） |
| `draft.reset` | 被 `draft.drop`（按条丢弃）取代：一条一行，不需要整表重置 | `docs/11` D16 |
| `edits.list` | 它渲染「原 #N → 新 #M」—— 那是**版本历史**的入口，已从界面移除 | `docs/11` D19 |
| `child.fork` | 改为 `child.plan` + `child.start` 两段（先给人看清单、再执行） | `docs/11` D5/D10 |
| `child.compact`（旧名） | 压缩尚未实现，落点见 B 段；旧名不再使用 | `docs/10` M5-14…17 |
| `freeze` / `invariants.*` / `pinInvariants` | 固定块 / 钉住 / 漂移检查**整套删除** | `docs/11` D14、D10 |
| `plan.next`（旧契约） | 机器判定仍在（`src/redline/plan.ts` + 单测），但**不再是 RPC op**：界面自带这条顺序，不需要往返一次 | `docs/10` M5-02 说明 |

### 5.3 主机斜杠命令

**当前不提供任何斜杠命令**（2026-10-06 收口，`docs/10` M6-02）。

- 依据：用户定的产品形态是**面板**（`docs/03` + demo）；命令/工具入口整体归 `docs/10` **M7+「本轮明确不做」**。
- 下面这张表是**转向前的规格**，保留只为记下"为什么命令里不给编辑"这条判断：

| 子命令（旧规格） | 行为 | 是否写会话 | 现状 |
|---|---|---|---|
| `/redline children` | 列出子会话与状态 | 否 | 面板侧对应 `child.list`（M5 的 B 段） |
| `/redline compact <childId>` | 压缩指定子会话（先体检） | **是（不可逆）** | 面板侧对应 M5-14/16（走确认框） |
| `/redline drift` | 只报漂移 | 否 | **已作废**（漂移/批注整套已删，`docs/11` D10） |

**为什么命令里（将来）也不给编辑类子命令**：斜杠命令最容易在"没看清改哪一条"的情况下误触，而遮蔽不可撤销。
编辑必须在界面上**看着那一行**做（这也是"编辑在行下内联展开、不弹窗"的同一条理由）。

### 5.4 内部服务

**不导出 cordis Service**（2026-10-06 收口，`docs/10` M6-03）。

- 依据：① **没有消费者**（本仓库只有这一个插件；官方团队那一面走的是它自己的服务与工具，`docs/01` F47/F53）；
  ② 旧规格里列出的成员大半**已经作废** —— `apply` / `annotate` / `invariants.*` / `freeze` 随"回滚 + 批注 + 固定块"整套删除（`docs/11` D10/D19），
  只剩 `inspect` 与 `plan` 还在。
- 这两个**保留为仓库内模块**：`src/redline/inspect.ts`（两半共用的纯函数：事件 → 语义文本）与
  `src/redline/plan.ts`（M5 的"下一步"契约，10 条单测钉着）。**它们不对外暴露**。
- 真要给别的插件复用，**单独立项**并遵守本节 §5.2 的口径（尤其 C 段那批已作废的名字不许复活）。

---

## 6. 数据与本地存储

```
$DSH_HOME/dsh-context-redline/
├─ redline-drafts-<safeSessionId>.json   草稿（每会话一文件；原子写 .tmp + rename）
   ├─ schema_version(version)            我们的格式版本（**只备将来升级用**；首启即空库，无旧数据可迁，见 `docs/08` Q8）
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
- ⛔ `history.sqlite`（`invariants` / `history` 两张表）**已随功能删除**（`docs/11` D14/D19）：我们的数据目录现在只有草稿 JSON。
- 机密性：这里存的是**用户自己的上下文正文**（可能含私密内容），与 DSH 会话日志同等敏感；不做任何外发。

---

## 7. 错误模型

| 场景 | 对外表现 |
|---|---|
| 会话不在本进程（冷会话/别人的会话） | `turnState.known=false` → 界面前事禁用所有写入类动作，文案说明"这个会话不在本进程里，只能看" |
| 轮次未闭合 | `apply` 事前禁用 + 理由；**不靠点击后报错** |
| 目标已被遮蔽 | 行上**不出现任何动作**，只给一句说明 `已被 #K 接替`（不再有"去改现在这条"这类跳转入口，`docs/11` D19） |
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
