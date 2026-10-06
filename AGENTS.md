# 工作约定（AGENTS.md）

> **本文件是唯一必读入口。** 现行文档只有这一份 + `docs/` 下的编号文档集：
> [`docs/00-scope`](docs/00-scope.md)（做什么/不做什么）· [`docs/01-platform-facts`](docs/01-platform-facts.md)（平台事实）
> · [`docs/02-architecture`](docs/02-architecture.md) · [`docs/03-ui-spec`](docs/03-ui-spec.md)
> · [`docs/04-roadmap`](docs/04-roadmap.md) · [`docs/05-test-plan`](docs/05-test-plan.md)
> · [`docs/06-orchestration`](docs/06-orchestration.md)
> · [`docs/08-open-questions`](docs/08-open-questions.md) · [`docs/09-requirements-traceability`](docs/09-requirements-traceability.md)（需求追溯矩阵）
> · [`docs/10-execution-checklist`](docs/10-execution-checklist.md)（**长任务执行清单 · 唯一状态源**：细粒度任务表 `ID / 子任务 / 状态 / 文件动作（范围冻结）`；需要用户的标 `WAIT🙋`）
> · [`docs/11-session-handoff`](docs/11-session-handoff.md)（**换会话时的可复制交接文本**——新会话先读它）
> · [`docs/12-user-guide`](docs/12-user-guide.md)（**用户向总体帮助**：这是什么 / 五分钟上手 / 七类能不能改 / 何时不能改 / 术语表 / 常见问题 —— 也是界面里 `?` 与不可用状态那句话的权威来源）
> · [`UPSTREAM.md`](UPSTREAM.md)（上游与许可）

---

## 1. 硬约束（不可违反）

| 约束 | 原因 |
|---|---|
| **只以「插件形态」实现；不动 DSH 安装目录，不改 `$DSH_HOME` 下的配置与脚本** | 用户明确要求。**读** `$DSH_HOME` 与 DSH 安装目录用于核实平台事实是允许的；**改**不行 |
| **装进运行中的 profile 需用户单独授权；`dsh web` 重启一律由用户本人执行** | 这台机器的 `dsh web` 承载用户当前的会话，助手自行重启会立刻杀掉它 |
| **不跑 `scripts/clean-lib.mjs`** | 删 `lib/` 后，`link:` 安装的插件客户端半边直接失效 |
| **保留上游许可声明**：`LICENSE-Apache-2.0` 原样、`NOTICE` 声明来源、`UPSTREAM.md` 记录修改 | Apache-2.0 要求 |
| **所有保存都是临时保存**（用户 2026-10-02 立的硬约束） | 「只有开启子会话的时候才会写进去；否则任何保存都不能写进当前模型」⟹ 编辑只写插件本地，**唯一写入点 = 开启子会话**（把本地改动逐字写进新会话第一句话）。详见 `docs/11` D15 |
| **不产生任何 AI 生成内容** | 本项目存在理由：进入会话的每个字都必须来自人类输入（正文、标签、理由、子会话首条任务） |
| **不放宽 turn 边界检查** | `apply` 的 open-turn 拒绝，是"改动只发生在轮次边界"的机械保障 |
| **不放宽 append-origin 与 sourceEventSeqs 规则** | 宿主 surface 语义决定的，不是可优化项 |
| **不得为了让测试通过而放宽断言** | 测试与原则冲突时**先回报冲突**，不要自行放宽 |
| **范围不扩大** | 只动本仓库；发布/push/开 PR 必须单独授权 |
| **测试期可把本仓库装配进 profile**（用户 2026-09-30 授权） | 只限**测试/验证**用途：用本地目录装进 `web` profile（`dsh plugin --profile web add <本地路径>`）；**重启仍由用户本人执行**；装完要能一键卸掉，且不得顺手改其它 profile 配置 |
| **实施期不再逐动作找用户确认**（用户 2026-09-30 要求："全部可实施完、过程中不用我确认"） | 改为 **4 个一次性授权包**：① 装 profile + 重启 ② 专用一次性会话的破坏性验证 ③ M5 端到端验收（用户在场点按钮）④ push。其余**一律自验**并**留原始输出**。详见 [`docs/08`](docs/08-open-questions.md) §9。<br>⚠️ 这不等于"写会话不用授权"：`docs/06` §4 的授权清单（A 编号）是**界面确认框的内容规格**（用户点确认即授权）；**只有 §9 的 4 个包**需要用户本人动作 |

---

## 2. 平台硬事实（踩过的坑，别重踩）

本机生产运行时是 **DSH `0.2.0-rc.2`**（**注意**：早期那次尝试是在 `0.1.7-rc.2` 上验证的，其结论必须重验）。
完整清单见 [`docs/01-platform-facts.md`](docs/01-platform-facts.md)，这里只列"最容易被忽略"的：

### 2.1 三个"会抛错"的命名空间（**本插件与参考插件必须并存**）

1. **HTTP 路由同路径重复注册直接抛错** —— `exact Fetch route "…" is already registered`。
   上游的 `/api/dsh-context/{detail,balance,backfill}` 必须全部换成 `/api/dsh-context-redline/*`。
2. **投影 key 同 key**：stateVersion 相同 → **静默共用先注册者的定义**（我们的 fold 被顶掉，数据看着对其实错）；
   不同 → **抛错**。上游的 `contextTimeline`/`contextHeaders`/`contextActivity` 必须改为 `redline*`。
3. **客户端 bundle 注册 id 必须等于包名**，否则 `loaded without registering "<id>"`。
   slot id / locale 命名空间 / 消息 kind / 数据目录都要跟着分家。

### 2.2 同步事件读 API **已废弃**

`Session.eventAt` / `snapshotEvents` / `ownEvents` 的类型注释写着「new calls are prohibited」。
**读**一律走 `ctx.sessionQuery`：`readSurface`（含**全文**的当前 surface）/ `readEvent` / `readSession`。
**写**才用 live `Session.append`。

### 2.3 ⚠️ 危险模式：拿"预览"当正文

上游投影里的 `node.text` 是宿主的 **80 字空白折叠预览**（`firstText()`），
**不是**完整正文。早期那次尝试因此有一个会把整条消息截成 80 字的缺陷（`docs/01` F35）。
**规则**：编辑器的预填与提交**永远**来自 `node.read`（宿主全文）。

### 2.3.1 ⚠️ 两条必须记住的改写能力边界（**已实测，别再猜**）

1. **`assistant/message` 无法改写**：平台要求 replace 的 `sourceEventSeqs` 覆盖被遮蔽节点，
   但 `assistant/message` **禁止携带** `sourceEventSeqs` → **两条规则互斥，没有任何可行写法**。
   ⟹ **助手消息不给「编辑」按钮**，也**不给任何其他动作**（只给一句说明徽章：`助手消息改不了`）。
   要纠正它，就在**开启子会话时写在首条任务里** —— 用户 2026-10-02 定的口径：「上下文的编辑只有编辑就行了」（`docs/11` D19）。
   （早期那次尝试的 assistant 分支必然运行期失败，见 `docs/01` F7.2。）
2. **「编辑」不是一次性的**：被遮蔽的**原始节点**不能再作目标（平台拒），
   但**上一次的替换体是当前 surface 节点 → 可以再替换** ⟹ **连改与回滚都可行**
   （把目标换成"当前可见的那条"）。早期那次尝试把它误判为"只能改一次"，丢掉了图 2 ④ 要求的"能回滚"（结论见 `docs/01` F7）。
   ⚠️ 但**界面不再提供版本历史 / 回滚**（与本文件 §1 的硬约束「所有保存都是临时保存」冲突：那要求先写进当前会话）。
   平台能力仍在（`apply` 后可回滚），只是本插件界面不开放这个入口（`docs/11` D19）。

**结论在生产代码里的落点**：能力判定（纯函数）必须**按底层事件类型**给按钮，而不是按分类猜；
每一种行类型的按钮集合都要有单测锁定（`docs/05` A17）。

### 2.4 ⚠️ `pnpm install` 会**写穿**符号链接 —— 所以**本仓库不建那条链接**

早期那次尝试 里，`scripts/link-dsh-runtime.mjs` 把 `node_modules/@deepseek-ai` 做成指向共享 profile 的符号链接；
此后 `pnpm install` 要写该目录，会**穿过链接**把悬空 symlink 写进**共享 profile 目录**（已真实发生过）。

**2026-10-04 实测更正（`docs/01` F42）——这条路在本机已经走不通，也不该走**：

- `~/.dsh/profiles/web/node_modules/@deepseek-ai` 现在只剩 **5** 个包（`cosmokit`/`schemastery`/`browser-use` 两包/`browser-use-runtime`），
  链向它**解析不到** `dsh-session` 等内部包；
- 真正齐全的树在**全局安装层**（`…/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`，288 个包），而它**缺** `react`/`shiki`/`clsx` 等浏览器依赖。

**本仓库的处置**：需要的 `@deepseek-ai/*` 按 `0.2.0-rc.2` 写进 `devDependencies`，**从 registry 直装**。

```bash
pnpm install        # 只有这一条；没有 link 步骤，也就没有写穿风险
```

- 护栏：`node scripts/namespace-contract.mjs` 的**面 10** 断言 `node_modules/@deepseek-ai` **不是**符号链接（沙箱里反向验证过）。
- ⛔ **不要**为了"照旧文档做"而重新创建那条链接 —— 那等于把一个真实发生过的故障模式搬回树里。
- `.npmrc` 是 `auto-install-peers=false` ⟹ 平台包不会自动补；必须显式声明的清单见 `docs/01` **F41**（缺一个就整片 lane 加载失败）。

### 2.5 其它已核实的平台事实

- **客户端 bundle 由宿主按需从磁盘读并送到浏览器** → `tsc && tsdown` 之后**硬刷新即可**，不必重启 `dsh web`。
- **深色主题的选择器是 `body[data-ds-dark-theme]`**（不是 media query，也不在 `html` 上）→
  给 `document.body` 临时 `setAttribute` 就能实测深色（纯 DOM，不落盘，用完移除）。
- **面板显示的是"当前标签页选中的那个会话"**，不一定是 agent 正在跑的那个。走查依赖会话状态的行为前
  **必须先确认是哪个会话**。两个可靠判据：① **三处读数**与目标会话日志对得上 ——
  **统计卡标题里的 `（当前视图：第 t 轮 · 第 s 步[ · 当前]）`**、趋势卡标题的 `按轮次（共 N 轮）` / `按步骤（共 N 次请求）`、
  浏览器 meta 的 `第 t 轮 · 第 s 步`
  —— ⚠️ 两次更正：这里原写"面板数字条里的『本会话共 N 事件 / 最后 seq』"（**demo 与插件都没有那样一条数字条**，`docs/11` D38）；
  后又写"统计卡的 `轮数 / 步数`"—— **那两格随 `M4-07`（3 格、跟 demo）一起删了**，改由统计卡标题里的"当前视图"承担；
  ② `turn/start` 与 `turn/end` 条数差 = 1 的会话就是末轮未结束的那个。
- **`dsh --profile web --dump-config`** 会**合成插件树但不 boot** → 用来静态确认挂载与命名空间冲突。
- **fork 的种子取自"日志里最后一个 `turn/end` 之前的全部事件"**，一次性；
  **本地保存的改动不在日志里 → 子会话不会自动看到它们** ⟹ 按硬约束把它们**逐字写进新会话的第一句话**（见 `docs/11` D15）。
- **压缩 `compactNow` 需要 live Agent + 空闲 + 轮次闭合**；`compactRegion` 反而要求"有未闭合轮次"，
  不适用于空闲场景。失败码 `busy/cancelled/changed/summary/commit/persistence` 必须映射成人话。
- **插件直调 `ctx.subagents.start` / `ctx.compaction.compactNow` 绕过工具级审批** →
  授权责任落在我们自己的确认框（`docs/06` §4 的授权清单）。

---

## 3. 测试与验证

```bash
pnpm install                                                         # 只有这一条（不建符号链接，见 §2.4 / docs/01 F42）
./node_modules/.bin/tsc --noEmit                                     # 类型检查（exit 0 是底线；含 tests/**）
./node_modules/.bin/tsdown                                           # 构建（不要跑 clean-lib.mjs）
./node_modules/.bin/vitest run --project edit --project channel --project client-logic --project client-ui   # 自有护栏（门禁）
node scripts/release-check.mjs                                       # 一条命令跑完全部门禁并打印判定行（发布前自检）
node scripts/namespace-contract.mjs                                  # 命名空间门禁（11 个面 / 26 项）
node scripts/css-closure.mjs                                         # CSS 闭包：我们的样式出不去、别人的样式删了也不影响我们
./node_modules/.bin/oxlint                                           # 风格与类型感知规则
./node_modules/.bin/vitest run --project host --project client       # 上游 lane（非门禁；环境依赖，docs/05 §1）
dsh --profile web --dump-config                                      # 静态确认挂载与命名空间
```

**规则**：

1. **先写测试，确认它红。** 一条从来没红过的测试不构成证据；护栏测试要**反向验证会真红**（改坏实现 → 看它红 → 改回）。
2. **不得先写实现再补测试。**
3. **客户端半（React/浏览器）无法 TDD** → 必须过**人工门禁**（`docs/03` §7 的 30 条清单，按 R 编号覆盖）。
   ⚠️ **浏览器工具的现状（2026-09-30）**：
   · `browser-skill`/`bsk` 已按用户要求**彻底删除**；
   · **官方 `browser-use`（Playwright MCP，headless）已按用户选 B 恢复**：两个包装进 `web` profile（版本 **`0.2.0-rc.2`**（实测；写 rc.1 的地方是历史记录），
     与运行时一致；`@playwright/mcp@0.0.80` 解析通过；chromium/headless-shell rev 1243 已在本地缓存，无需下载），
     patch 里那段 `insert` 已取消注释，`dsh --profile web --dump-config` exit 0 且两行都在合成树里。
     **生效范围＝新建会话**；**已活动的会话不受影响**。
   · ✅ **已在新会话实测可用**（2026-09-30：`navigate/resize/screenshot/evaluate/console_messages` 都通，
     用它完成了 `docs/10` 的 M05-23/M05-24）。**两条限制**：① 它只是**本机 headless Chromium**，
     不是用户的 Chrome、更不是用户的手机；② **headless 无触屏** → `matchMedia('(pointer: coarse)')` 为 `false`，
     `docs/03` R6.4 V11 的「真触屏 ≥44px」在上面**测不了**（只能把 CSS 规则搬出来模拟验证）。
     ⟹ 手机端手感的最终判据仍是**用户本人实测**。
   · 另有两条不依赖浏览器的自检：① `node demo/check-static.mjs`（id/class/讲解词契约）
     ② `node demo/check-runtime.mjs`（最小 DOM 桩跑真渲染与切换）+ demo 页面内**自测面板**自报测量值。
     ⚠️ 桩里的 `requestAnimationFrame` **必须后置排队**（不能同步执行），否则「render 内部排 rAF、
     紧接着读 DOM」这类**时序 bug 在桩里看不见**（M05-24 就是这么漏掉又补上的）。
4. **布局/交互类改动：先在静态 demo 里做出来、用浏览器量过，再搬进插件。**
   仓库内已有 **`demo/`（M0.5 交互门禁）**：界面改动先在它里面改，**用户逐条确认后**再搬进插件（客户端半无法 TDD，且每次改插件都要用户重启）。
   demo 仍要能自报测量值（元素尺寸、命中坐标、是否溢出）——那是给用户在真机上看读数用的；原始实测数据见
   [`demo/screenshots/measure-log.md`](demo/screenshots/measure-log.md)。
   ⚠️ 改完 `demo.css`/`demo.js` **必须** `node demo/build-standalone.mjs` 重打包单文件版（页头会带新的打包指纹）；
   忘了跑会被 `check-static.mjs` 抓成红的。给用户看的地址**一律用局域网 IP**（`http://10.0.0.30:5180/…`），
   单文件版页头的指纹可以用来核对"用户手上是哪一版"。
5. **改 UI / 写对接代码前先读官方参考实现**：**最新源码在 `$DSH_SRC`**
   （**0.2.0-rc.2**，含全部 TypeScript 源码与 `packages/experimental/{agent-team,tool-agent-team,client-ui-agent-team,agent-team-profile}`）；
   旧的 `<old-dsh-src>` 是 **0.1.6-alpha.1**，只当历史参考。
   ⚠️ **运行时是 0.2.0-rc.2**（安装树实测），所以：**语义看源码、签名以安装树的 `.d.ts` 为准**。
   只 grep npm 包里的压缩 bundle 会一无所获（类名已哈希），然后就会开始发明实现。
6. **留原始输出**，不写"已通过"三个字。
7. 测试分 lane，**自有护栏不许被上游 lane 的环境问题连坐**（见 `docs/05` §1）。

---

## 4. 文档纪律

> ⚠️ **优先级：用户的表述 > 仓库实测 > 本文档与 `docs/*`。**
> 文档只是「对用户意图的整理」，**不是权威**。用户的表述与任何文档冲突时，**就是文档写错了**：
> 当场改文档，并说明「哪一句错了、被用户的哪句话取代」。**不许拿文档当依据去反驳用户**，
> 也不许用「文档就是这么写的」来解释做出来的东西。
> （2026-10-05 用户原话：「所有 doc 下面的内容都以我的表述为主；如果我的表述和 doc 有冲突，以我的为准。」
> 触发场景：`docs/03` §0 写「布局与信息架构整体沿用上游」，被照做出来 ⟹ 面板长得和上游插件一模一样，
> 而用户早就说过「**按 demo 去执行**」。）

- `README.md` 与 `README.zh.md` **必须成对更新**。
- **新发现的平台事实（尤其是硬约束）必须写回 `docs/01-platform-facts.md`**，否则下一个人会重踩。
- 实测与文档冲突时**以实测为准**，并明确指出是哪条文档错了，然后改文档。
- 每条平台事实标注 `实测` / `推断`；未核实的一律进 `docs/01` §6「待验证」，**不许当依据**。
- 外部模型评审的结论要**逐条记录**在 `docs/08` 附录（采纳/不采纳 + 理由）。

---

## 5. 当前状态

> **进度看板（唯一状态源）**：[`docs/10-execution-checklist.md`](docs/10-execution-checklist.md) —— **细粒度任务表**
> （ID / 子任务 / 状态 / **文件动作（范围冻结）**），当前 **DONE 232 / 共 290**，需要用户的步骤标 `WAIT🙋`。
> **每次收尾必须回来同步它**（含 §11 进度总览），否则就会出现第二个"真相"。

| 阶段 | 状态 |
|---|---|
| **M0** 文档集 | ✅ **已完成**：`docs/00`–`docs/09`（`docs/07` 已按用户要求删除、编号不复用），过 7 轮外部模型评审（R1–R7）。**用户 2026-09-30 的全部拍板已落地**：Q1 包名、Q2 不做图 2 ②、Q6 可续接、Q11 **A 完整回滚**、Q12 **A′ 对接官方**；其余问题已给**默认值**（不再需要逐项确认） |
| **M0.5** 静态可交互 demo（交互门禁） | ✅ 第一版已交付（`demo/`，含逐步讲解模式）；✅ **已做浏览器实测**（1440/880/879/390 视口，原始数据在 [`demo/screenshots/measure-log.md`](demo/screenshots/measure-log.md)）；**等用户逐条按 R 编号确认交互**（`docs/10` M05-15） |
| **M1** 骨架与身份（复制 tag `v0.59.2` + 命名空间化） | 🟡 **仓库内已完成 + 已装配进 profile（13 / 14）**：`src/` 从 tag `v0.59.2` 复制 **110 个文件** + 命名空间分家；`tsc --noEmit` exit 0 · `tsdown` exit 0 · `namespace-contract` **11 面 24 项 0 失败**（逐面反向验证）· `oxlint` 0 error · `dsh --profile web --dump-config` **exit 0** 且两插件并排无冲突（M1-14，2 行 profile 声明 + 备份）。**M1-02 已复验通过**（真机：两插件并排、页签 `上下文 | 上下文批改`、console 零注册错误、面板数据正确、截图存档） |
| **M2** 编辑面（TDD；⛔ 回滚已不做，见 `docs/11` D19） | 🟡 **仓库内已完成（32 / 34）**：本地改动存储 / 全文读取 / 按底层事件类型的能力判定 / 通道 `node.read`+`draft.*`；每条保存都断言**会话零写入**；**轮次边界拒绝（`turn-open`）已实现**（落点 `src/shared/redline-turn.ts` + 通道）。剩 2 条都有明确依赖（M2-20 → M5 的确认框；M2-26 → M2-20 + M4-07）|
| **M3** 右侧可编辑界面（人工门禁） | 🟡 **界面已接上（33 / 36）**：行内动作**只有 `编辑`**（改不了的行给一句原因、宿主保护的两类不渲染动作区）、有本地改动时**一个** `已改（本地）` + `丢弃这条改动`、行下**内联编辑器**按 `node.read` 的真实类型给字段并**预填全文**、`保存` 只交给我们自己的本地存储（会话零写入）、工具结果的「编辑」收在「高级编辑」开关后。新增**门禁** lane `client-ui`（jsdom + 真 React，11 条断言，4 个变异反向验证全部变红）。**又补**：轮次未闭合 / 会话不在本进程两种态 —— 编辑器写明句子并禁用 `保存`，主机侧同样拒绝（`turn-open` / `not-live`）。**又补 M3-03**：两级（轮 → 步）选择器（`当前（下一次请求）` 只在末轮）+ `比前步 / 比前轮` 基线开关（δ 参考对象按 demo 的 `deltaRefReq`；4 个变异反向验证全红）。**又**：`docs/12-user-guide.md` 写好（M6-11）⟹ **M3-31 作废**（`docs/03` R7.1 自己写着 demo **没有**总体帮助入口，其形态是讲解模式；内容侧由 `docs/12` + 就地 `title` 承担 —— ⚠️ **2026-10-06 更正**：原写"就地 `?`/`title`"，而插件里已经**没有任何 `?` 角标**了，见 M3-41 / M3-42）。**又**：**M3-21 已真机验证**（1440/640/390 无横向滚动、深浅主题走令牌、粗指针下控件 17→44px 与 25→44px —— 顺带修掉一个真实 V11 缺口）。**又**：**M3-22 的机械半边在真面板上走完**（分类行有 δ、动作条只有 `编辑`、编辑器预填全文、去向标记在、Esc 零写入收起）；**剩**：M3-16/17（子会话卡，属 M5）、M3-22 的"保存/丢弃"两条（会写我们自己的草稿文件，等用户选 (A)/(B)/(C)）与手感验收 |
| **M4** 轮次联动（人工门禁） | 🟡 **7 / 7**：**规模读数**已加（`按轮次（共 N 轮）` / `按步骤（共 N 次请求）`，R1.5）；点击某一轮 → 右侧切该轮末步由基线既有链路满足；**M4-01 作废**（demo 里没有 R1.3 说的那两个数字）；**M4-03 完成**（"可指认"由**统计卡标题里的"当前视图：第 t 轮 · 第 s 步"** + 趋势卡标题 + 浏览器 meta 三处承担；原写的统计卡 `轮数/步数` 随 M4-07 删除，AGENTS §2.5 已同步）；**M4-06 完成**（默认粒度改成 demo 的**按轮次**：宿主 `src/host/config.ts` 的 schema 默认 `turn` + 客户端初值同步；**2026-10-06 重启后真机复核** —— 趋势卡标题 `按轮次（共 52 轮）`）；**M4-07 完成**（用户 2026-10-06 裁定取 **3 格、跟 demo**；口径抽成纯函数 `stepStatsOf()` 并有单测）|
| **M4.5** 平台能力验证（**M5 的硬前置**；含 V12/V13） | 🟡 **6 / 19 DONE + 3 DOING（离线半边已清完）**：新增平台事实 F44（"更早切点"能造但**没有回程通道** ⟹ 现行"只有最新切点"成立）、F45（fork/spawn 能力表：五项全 true、fork 可续接、**种子空 ⟹ 子会话不带历史**）；V12 静态答案（官方**禁的是工具**、服务与两个 provider 在册）；能力开关默认值定死（`fork`/`team` = true，`agents`/`compaction` = probe 决定）；**失败决策表**（V1–V14 逐条降级）与**同步变更表**（开关一变三份文档同 commit）已写进 `docs/04`；**M5 硬门禁已落纸**。**剩**：8 条真机探针（要授权包②）|
| **M5** 子会话 → 压缩 → **对接官方团队**（冻结已删，`docs/11` D10） | 🟡 **5 / 28 + 2 DOING**：`plan.next` 的机器判定落地（`src/redline/plan.ts` + 10 条单测；**规格更正**：不实现已被删除的 `pinInvariants`；补了「已提交改动条数」这个隐含输入）|
| **M6** 入口与发布准备 | 🟡 **7 / 12 + 1 DOING**：**M6-11** 用户向总体帮助 [`docs/12-user-guide.md`](docs/12-user-guide.md) 已交付（9 节 / 153 行，每条标 R 编号、无未解释术语）；**M6-12** `scripts/progress.mjs` 已交付（只读进度汇报器）；**M6-08** 许可复核（**抓到真实不准确**：`package.json` 原写 `license: MIT` 但本包含 Apache-2.0 代码 → 已改 SPDX `MIT AND Apache-2.0`，并把 `UPSTREAM.md` 挂进 `files`）；**M6-05** `CHANGELOG.md`；**M6-09** 版本/tag 策略（首版 `0.1.0`，**打 tag 属发布动作、要单独授权**）；**M6-04** README 双语复核 + 截图（明写是 **demo 截图**，插件截图欠到重启后）+ 安装/使用/限制三节；**M6-06** 本地目录 → npm 两条安装路径 |
| **M7+** 装配层（先盘官方缺什么）/ 工具入口 / 父不在进程时的冷恢复体验 | ⬜ 用户已定"本轮不做" |

**关于"早期那次尝试"**：本仓库曾有一条基于上游 v0.59.0 的实现线，**其目录与 git 历史已丢失**，审计文档也已按用户要求删除；
**只保留"别重犯"的结论**，分别写在 `docs/01`（F7 / F7.2 / F35 等）与本文 §2 / §2.3。

**开工条件（已就绪）**：`docs/08` 的问题**全部有结论**——✅ 已定：Q1 包名 = `dsh-context-redline`、Q2 本轮不做图 2 ②、
Q6 子会话 = **可续接**、Q12 = **A′**（快照化子会话 + 对接官方 Agent Teams）、Q10；⛔ Q11（回滚）**已被 2026-10-02 硬约束取代**（界面不提供回滚，`docs/11` D19）；
⛔ Q8 已失效（旧数据目录已删）；🔧 其余（Q4/Q7/Q9/Q3/Q5）已给**默认值**，实施中不再需要逐项确认。

**开工顺序**：用户点头 → 在**仓库内**做 M1（骨架 + 命名空间分家，可自验） → `tsc` / `tsdown` / `vitest` 全绿 → **然后**才走**授权包 ①**（装配进 `web` profile → `dsh --profile web --dump-config` 无冲突 → **停下请用户重启**）。
⚠️ **在用户明确说"开始"之前，不写任何实现代码**（当前只做文档）。

**文档自检**：`node scripts/check-docs.mjs`（版本 / 目录 / 命名 / 计数 / 表格 / 重复标题 / A17）——改动文档后必须退出码 0。
