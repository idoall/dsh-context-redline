# 10 · 长任务执行清单（**唯一状态源** · 细粒度）

> **这是本项目的唯一进度状态源。** 任何"做到哪了"的问题，答案都在本文件；与其它文档冲突时，先改本文件再改别的。
>
> **列定义**
>
> | 列 | 含义 |
> |---|---|
> | **ID** | `阶段-序号`（子步骤加字母，如 `M2-07b`）。**ID 一旦分配不再复用**；作废的行标 `作废` 而不是删掉 |
> | **子模块 / 子任务** | **一件事**：动什么、动到什么程度。不写"做 A 模块"，而写"在 A 里做 X；输入是…；输出是…" |
> | **状态** | `DONE` 完成 · `DOING` 在做 · `TODO` 未开始 · `WAIT🙋` 等你（授权/点头/看界面）· `BLOCK` 被前置卡住 |
> | **文件动作（范围冻结）** | **本任务只许动这些文件**。做到一半发现要动别的文件 → 先回来加一行，再加文件 |
>
> **规则**
> 1. **一个阶段一停**：上一阶段的 `DONE` 没带证据，不进下一阶段。
> 2. **证据**写在 `→` 后面（测试名 / 原始输出 / 截图路径 / commit）。**不写"已通过"三个字。**
> 3. **用户未说"开始"之前，M1 及之后一律 `TODO`**，不写实现代码。
> 4. **`WAIT🙋` 是唯一会停下来的状态** —— 只有需要你授权/点头/看界面时才用它。
> 5. 本文件是**施工表**；[`docs/04`](04-roadmap.md) 是**阶段说明书**（为什么这样切）。冲突时以 `docs/04` 为准并回来修本表。

---

---

## 0. 横切（贯穿所有阶段 · 每次收尾都要看）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| X-01 | push 前清理：本机绝对路径占位化、早期实现线文档删除、模型名/插件名按你要求保留原样 | DONE → commit `eae9ad2`、`ee0a0f2` | 全仓 `*.md` |
| X-02 | 四个一次性授权包的执行记录（①装 profile+重启 ②破坏性验证 ③E2E 验收 ④push）：谁批的、何时、结论 | TODO | `docs/08-open-questions.md` §9 |
| X-03 | 每个阶段收尾时回写本表的 `状态` 与 `→ 证据` | DOING | 本文件 |
| X-04 | 新发现的平台事实回写 `docs/01`；未核实的进"待验证"，不得当依据 | DOING | `docs/01-platform-facts.md` |
| X-05 | 每阶段收尾同步 §11 进度总览（防止出现第二个"真相"） | DOING | 本文件 §11 |
| X-07 | **恢复官方浏览器控制**（用户选 B）：装 `@deepseek-ai/dsh-browser-use@0.2.0-rc.1` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.0-rc.1`（peer 钉在运行时 0.2.0-rc.1；`@playwright/mcp@0.0.80` 经 `require.resolve` 验证可解析；chromium / headless-shell rev 1243 已在 `~/Library/Caches/ms-playwright`）→ 取消 patch 里那段 `insert` 注释 → `dump-config` exit 0 且两行在合成树里；`package.json` 差异仅预期两行、其它插件完好。**回退**：还原 `cordis.patch.yml.before-browser-use-restore-20260930-184704` + `dsh plugin --profile web remove` 那两包 + 重启。**生效范围＝新建会话**（本会话不受影响） | DONE（**待你在新会话验证工具是否出现**） | `$DSH_HOME/profiles/web/{cordis.patch.yml,package.json,pnpm-lock.yaml}`（已各备份一份） |
| X-06 | 🙋 push（最后单独授权）：`git push -u origin main` | WAIT🙋 | 远端 `origin` |

## 1. M0 · 文档集（**20 / 20 DONE**）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M0-01 | 目标 G1–G11（含 G9 可回滚 / G10 不膨胀可观测 / G11 可追溯）+ 非目标 N1–N8 | DONE → R1–R7 七轮评审 | `docs/00-scope.md` §2 |
| M0-02 | 成功标准 S1–S10 写成"可验收"（计数口径、证据格式） | DONE | `docs/00-scope.md` §3 |
| M0-03 | 术语表：遮蔽/替换体/被遮蔽原文/行身份/可续接子会话/快照化子会话 | DONE | `docs/00-scope.md` §6 |
| M0-04 | 平台事实 F1–F13：命名空间冲突、废弃读 API、80 字预览陷阱、surface 替换语义 | DONE → 探针实测 PASS | `docs/01-platform-facts.md` §2–§4 |
| M0-05 | 平台事实 F14–F27：依赖树、dump-config、主题选择器、面板目标会话判据、fork 种子、压缩前置 | DONE | `docs/01-platform-facts.md` §5 |
| M0-06 | 平台事实 F28–F35：官方团队走 subagent seam、`ctx.agentTeams` 对接面、`spawnTeammate(context:'fork')`、`agentTeam` 投影、80 字预览 | DONE → 源码 `$DSH_SRC` + 安装树 `.d.ts` | `docs/01-platform-facts.md` §4 |
| M0-07 | 待验证项 V1–V13：每条写"验什么 / 怎么验 / 失败怎么办" | DONE | `docs/01-platform-facts.md` §6 |
| M0-08 | 架构 L0–L4 + 两条数据流（含 A′ 的建成员与回流） | DONE | `docs/02-architecture.md` §2–§3 |
| M0-09 | RPC op 表（读 12 + 写 13 + `team.*`）+ 命令/内部服务入口 | DONE | `docs/02-architecture.md` §5.2 |
| M0-10 | 存储布局：草稿文件 + `history.sqlite` 六表（**无 children 表**，子会话读平台投影） | DONE | `docs/02-architecture.md` §6 |
| M0-11 | 界面规格 R1.1–R1.4（轮次联动） | DONE | `docs/03-ui-spec.md` §1 |
| M0-12 | 界面规格 R2.1–R2.3（每类行的按钮矩阵 + 原因码） | DONE | `docs/03-ui-spec.md` §2 |
| M0-13 | 界面规格 R3.1–R3.6（三模式合一编辑器、全文预填、确认框、未保存提醒） | DONE | `docs/03-ui-spec.md` §3 |
| M0-14 | 界面规格 R4.1–R4.6（未生效吸顶、确认框清单、版本历史、**行身份 × 状态矩阵**） | DONE | `docs/03-ui-spec.md` §4 |
| M0-15 | 界面规格 R5.1–R5.3（快照与子会话面板、来源徽章、V10 降级契约、压缩体检） | DONE | `docs/03-ui-spec.md` §5 |
| M0-16 | 视觉约束 V1–V8 + **30 条人工门禁** | DONE | `docs/03-ui-spec.md` §6–§7 |
| M0-17 | 测试计划：lane 划分（edit/channel）+ A1–A24 断言 + 反向验证 + op 追溯 | DONE | `docs/05-test-plan.md` §1–§8 |
| M0-18 | 编排规格：快照→成员→压缩→派活语义、授权清单 A1–A10、失败码人话、`plan.next` 次序 | DONE | `docs/06-orchestration.md` §1–§7 |
| M0-19 | 开放问题 Q1–Q12（选项/推荐/阻塞阶段）+ 评审附录 R1–R7（58 条全部采纳） | DONE → 逐条处置表 | `docs/08-open-questions.md` |
| M0-20 | 需求追溯：U1–U8 + 图 2①–⑥ / 图 3 / 图 4-1…4-5 → 落到哪条目标 | DONE | `docs/09-requirements-traceability.md` |

---

## 2. M0.5 · 交互 demo（**14 / 15 DONE**，剩定稿）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M05-01 | 三文件无构建骨架（HTML 结构 / CSS 令牌 / JS 逻辑），深浅主题同一套令牌名 | DONE → commit `b3b65f4` | `demo/redline-panel.html`、`demo/demo.css` |
| M05-02 | 假数据做全边界态：原始 / 替换体 / 旧替换体 / 被遮蔽原文 / 助手消息 / 工具结果 / 注入类 / 被压缩埋掉 | DONE | `demo/demo.js` |
| M05-03 | 左列：统计卡 + 趋势轮次条（用户消息/注入内容计数）+ 步卡片 + 事件列表 | DONE | `demo/demo.js` |
| M05-04 | 右列浏览器：7 类分类树（条数/≈token/占比）+ 步级下拉 + 轮次联动 + 行展开 | DONE | `demo/demo.js` |
| M05-05 | 行动作条按"行身份 × 状态"给按钮；被遮蔽行灰显 + 删除线 + 原因提示 | DONE → 修 bug#2 | `demo/demo.js`、`demo/demo.css` |
| M05-06 | 内联编辑器三模式 + 草稿/未生效/吸顶计数 + 应用到会话 | DONE → 修 bug#3 | `demo/demo.js` |
| M05-07 | 版本历史：**按行身份跨替换体**串联（原始 → 改写 → 回滚）+ 恢复 + 二次确认 | DONE → 修 bug#4 | `demo/demo.js` |
| M05-08 | 快照与子会话：冻结→五项确认框开成员→索引（来源徽章/`活跃 N/8`）→派活·建成官方任务·压缩·打断 | DONE | `demo/demo.js` |
| M05-09 | 待处理结果三态 + 只读官方团队区块（roster + 任务板）+ 团队不可用时对接点全隐 | DONE | `demo/demo.js` |
| M05-10 | 状态开关驱动可见性：轮次未结束 / 会话在本进程 / 团队可用 / 子会话正忙 / 草稿数 / 回流未确认 | DONE | `demo/demo.js` |
| M05-11 | 讲解模式：40 个编号热区 + 右侧说明卡（做什么/会发生什么/能否撤回/是否确认/对应 R）；开启时拦截点击 | DONE → `evaluate`：`explain:true, hotzones:40` | `demo/demo.js`、`demo/demo.css` |
| M05-12 | 自测面板：状态组合 + 该出现的按钮（对照 R4.6）+ 盒子尺寸/横向溢出 | DONE | `demo/demo.js` |
| M05-13 | 自验并修 5 个真 bug：`[hidden]` 被 `display:flex` 盖掉、遮蔽原文整条消失、保存草稿被吞、版本链不跨替换体、窄屏 26px<44px | DONE → 截图 + `node --check` + 页面 console 0 条 | `demo/*` |
| M05-14 | 单文件独立版（内联 CSS/JS、无 fetch/XHR/存储/模块）→ 解决"远程打不开" | DONE → `node demo/build-standalone.mjs`（76007 B，实测 7 类/40 热区/0 报错） | `demo/build-standalone.mjs`、`demo/redline-panel.standalone.html` |
| M05-16 | 趋势区按参考插件重做：粒度开关（按轮次/按步骤）、模式（总计/增量）、自适应刻度、聚焦某一类、固定柱宽+横向滚动、轮次分组刻度带、步级快捷片、上一轮/下一步导航、✂ 压缩标记；演示数据扩到 **28 轮 / 72 次请求** | DONE → `node demo/check-runtime.mjs` 22/22 | `demo/demo.js`、`demo/demo.css` |
| M05-17 | 移动端适配（照参考插件思路：无 @media 的流式列 + 容器查询 + overscroll 兜底 + pointer:coarse 触控目标 + 安全区 + 页面不横向滚） | DONE → 同上的冒烟测试 + 结构自检 | `demo/demo.css`、`demo/demo.js` |
| M05-18 | 无浏览器工具后的自检替代：静态契约检查 + 运行时冒烟测试（最小 DOM 桩真的执行 demo.js） | DONE → `node demo/check-static.mjs`（40 id/69 class/27 讲解词全绿）、`check-runtime.mjs` 22 项全绿 | `demo/check-static.mjs`、`demo/check-runtime.mjs`、`demo/serve.sh` |
| M05-19 | 趋势图 hover 提示：2 行式自绘 tooltip（文案照参考插件 i18n：按步骤 `第 t 轮 · 第 s 步 (共 n 步)`／按轮次 `第 t 轮 · 共 n 步`；第二行 `合计 ≈ n`／`{类} ≈ n`／`Δ n`；✂ 事件再加一行），渲染在滚动容器**之外**、transform 夹在可视区、pointer-events:none；触屏点选后常显；去掉原生 title | DONE → 冒烟 **32/32** | `demo/demo.js`、`demo/demo.css` |
| M05-20 | 修正 ✂ 语义并让它自我说明：一个事件只标一根柱（原来会重复标 → 2 个事件显示 3 个剪刀）；按轮次合并成 `✂×N`；✂ 自身可 hover 出提示、可点击跳转；事件类型文案对齐参考插件（压缩 / 剪枝） | DONE → 冒烟 **41/41**（含"同一事件不会被标两次"） | `demo/demo.js`、`docs/03-ui-spec.md` |
| M05-21 | 讲解面板改为**推挤式**（像 DSH 右侧栏）：打开时 body 加 `drawer-open` → 内容被挤窄而不是被盖住，宽屏无需关闭即可继续对照；窄屏（<900px）回退成遮罩式，点面板外或 Esc 关闭；关掉讲解模式时面板一并收起 | DONE → 冒烟 **46/46**（含 drawer-open 类的加/收） | `demo/demo.css`、`demo/demo.js` |
| M05-22 | 讲解模式改为「**只有序号可点**」：序号用真实节点（伪元素点不到）注入，点它出讲解、点按钮本身照常交互（旧实现会在捕获阶段拦掉所有 [data-explain] 点击 → 开着讲解就没法试按钮）；序号可键盘触达、带 title 说明；关掉讲解模式即清理。加了两道回归护栏（冒烟：开着讲解时点按钮不被 preventDefault；静态：禁止旧的点击拦截写法回来） | DONE → 冒烟 **54/54** | `demo/demo.js`、`demo/demo.css`、`demo/check-runtime.mjs`、`demo/check-static.mjs` |
| M05-15 | 🙋 **交互定稿**：你逐条按 R 编号确认 → 结论回写 `docs/03` | WAIT🙋 | `docs/03-ui-spec.md`（只改对应 R 各条） |

---

## 3. M1 · 骨架与身份（**0 / 14**）—— 先要授权包①

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M1-01 | 🙋 授权包①：把本仓库装配进 `web` profile；**你**重启 `dsh web`；我做复验 | WAIT🙋 | `$DSH_HOME/profiles/web/{package.json,cordis.patch.yml}`（先备份） |
| M1-02 | 复验：插件日志 `host loaded (/api/dsh-context-redline)`、两个面板并存、console 无注册错误 | TODO | 只读日志 + 浏览器 |
| M1-03 | 从上游 tag `v0.59.2` 复制 `src/`（不带 `.git`、不带上游 `.github/workflows`） | TODO | `src/**`、`package.json` |
| M1-04 | 路由改名：`/api/dsh-context/{detail,balance,backfill}` → `/api/dsh-context-redline/*` | TODO | `src/host/**` |
| M1-05 | 投影改名：`contextTimeline|contextHeaders|contextActivity` → `redlineTimeline|redlineHeaders|redlineActivity` 并定版 `stateVersion` | TODO | `src/host/**` |
| M1-06 | 插槽 id / 文案命名空间 / 消息 kind / 数据目录 四处分家 | TODO | `src/client/**`、`src/host/**`、`locale/**` |
| M1-07 | 客户端 bundle 注册 id = 包名（否则 `loaded without registering`） | TODO | `package.json`、客户端入口 |
| M1-08 | 依赖安装按安全顺序（防 `pnpm install` 写穿共享 profile 链接） | TODO | `node_modules/@deepseek-ai`、`scripts/link-dsh-runtime.mjs` |
| M1-09 | 配置来源表：每个配置文件从哪来、改了什么、为什么 | TODO | `UPSTREAM.md` §4 |
| M1-10 | 自建 CI（上游 workflows 已删；它会跑不存在的 `pnpm run verify`） | TODO | `.github/workflows/**`、`package.json` scripts |
| M1-11 | `namespace-contract` 机器检查覆盖 8 个面 | TODO | `scripts/namespace-contract.mjs` |
| M1-12 | 反向验证：手工改坏一处命名空间 → 检查必须变红 | TODO | `scripts/namespace-contract.mjs` |
| M1-13 | `tsc --noEmit` exit 0 + `vitest run --project edit --project channel` 可跑 | TODO | `tsconfig.json`、`vitest.config.ts` |
| M1-14 | `dsh --profile web --dump-config` 无路由/投影冲突 | TODO | 只读命令 |

---

## 4. M2 · 编辑面（**0 / 28**）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M2-01 | 读模型封装：`sessionQuery.readSurface()`（**全文**）+ `readEvent` | TODO | `src/host/redline-channel.ts` |
| M2-02 | 分类判定：表面节点 → 7 类（system/tools/user/inject/skill/assistant/tool） | TODO | `src/redline/classify.ts` |
| M2-03 | 行身份链：`seq → 家族`（跨替换体串联，供版本历史与按钮判定共用） | TODO | `src/redline/identity.ts` |
| M2-04 | 能力判定 a：`assistant/message` → `canRewrite:false` + `assistant-immutable` | TODO | `src/redline/eligibility.ts` |
| M2-05 | 能力判定 b：被遮蔽的原始节点 → `canRewrite:false` + `shadowed-by:#seq` | TODO | `src/redline/eligibility.ts` |
| M2-06 | 能力判定 c：替换体（当前可见）→ `canRewrite:true`（**连改可用的关键**） | TODO | `src/redline/eligibility.ts` |
| M2-07 | 能力判定 d：被压缩埋掉 → 只能批注 + `compacted-region` | TODO | `src/redline/eligibility.ts` |
| M2-08 | 能力判定 e：工具结果可编辑范围（内容文本 + `isError`；不得改工具名/参数结构） | TODO | `src/redline/eligibility.ts` |
| M2-09 | 草稿存储：按会话分文件的 `.json` 原子写（`.tmp` + rename） | TODO | `src/host/drafts.ts` |
| M2-10 | 轮次边界检查：open turn → 拒绝写会话类动作 + `turn-open` | TODO | `src/redline/write.ts` |
| M2-11 | `apply`：组装替换事件（目标 = 当前可见 seq、保留遮蔽来源、append 到日志尾） | TODO | `src/redline/write.ts` |
| M2-12 | `apply`：`sourceEventSeqs` 规则（覆盖被遮蔽节点；**assistant 不带**） | TODO | `src/redline/write.ts` |
| M2-13 | `annotate`：追加带"作废范围"的普通 user 消息（结构化头部，非伪造宿主内容） | TODO | `src/redline/write.ts` |
| M2-14 | `inject`：固定块正文作为普通消息追加（重注入入口） | TODO | `src/redline/write.ts` |
| M2-15 | 版本历史查询：读全量日志 → 家族内每版（seq/时间/正文/类型） | TODO | `src/redline/history.ts` |
| M2-16 | `apply.rollback`：目标 = 当前可见节点 → 追加替换使可见内容 = 选定版本 | TODO | `src/redline/write.ts` |
| M2-17 | V8 未通过时的降级：读不到正文 → `history-unavailable`，**禁止用 80 字预览冒充** | TODO | `src/redline/history.ts` |
| M2-18 | 固定块存储：`invariants`（标签/正文/作用域/版本/退休） | TODO | `src/host/invariants.ts` |
| M2-19 | 固定块作用域 workspace 级（新会话可见）+ 漂移检查（逐字比对当前 surface） | TODO | `src/host/invariants.ts` |
| M2-20 | 计数与增量：事件数 / 字节（为"不膨胀"提供可核对数字） | TODO | `src/redline/metrics.ts` |
| M2-21 | 测试 A1–A10（读模型/分类/能力判定/草稿/边界）先红后绿 | TODO | `test/edit/**` |
| M2-22 | 测试 A11–A16（固定块跨会话、漂移、应用、批注、**回滚逐字相等**） | TODO | `test/edit/**` |
| M2-23 | 测试 A17（按钮集合按事件类型锁定，**反向验证会红**） | TODO | `test/edit/**` |
| M2-24 | 测试 A18–A24（降级/失败码/压缩体检/团队 op 转发/服务缺失返回 `null`） | TODO | `test/channel/**` |
| M2-25 | 反向验证全表执行（逐条改坏 → 确认红 → 改回），结果贴 `docs/05` §6 | TODO | `test/**`、`docs/05-test-plan.md` |
| M2-26 | 计数契约自测：S1/S1.1 口径与界面数字一致 | TODO | `test/edit/**` |
| M2-27 | 错误码 → 人话映射（`bad-range`/`no-change`/`turn-open`/`assistant-immutable`/`shadowed`/`history-unavailable`） | TODO | `src/redline/errors.ts` |
| M2-28 | 冻结快照记录（只写本地：切点/条目数/时间/人写备注/在效固定块版本） | TODO | `src/host/snapshots.ts` |

---

## 5. M3 · 右侧界面（**0 / 22**，按 M05-15 定稿搬）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M3-01 | 面板骨架：左统计/趋势/步卡片，右浏览器（复用上游 shell 结构） | TODO | `src/client/**` |
| M3-02 | 分类树：7 类 + 条数/≈token/占比 + 展开折叠 + 空类不显示 | TODO | `src/client/**` |
| M3-03 | 步级下拉 + "当前（下一次请求）" + 与轮次入口交叉一致 | TODO | `src/client/**` |
| M3-04 | 行动作条：`#seq` + 编辑/批注/存为不变量/应用到会话/版本历史（按能力判定给） | TODO | `src/client/**` |
| M3-05 | 被遮蔽行样式：灰显 + 删除线 + "已被 #X 接替" + 仍可看版本历史 | TODO | `src/client/**` |
| M3-06 | 内联编辑器·编辑模式（思考文本 + 可见文本，**全文预填**） | TODO | `src/client/**` |
| M3-07 | 内联编辑器·批注模式（理由 + 作废范围 seq 区间） | TODO | `src/client/**` |
| M3-08 | 内联编辑器·固定块模式（标签 + 逐字正文） | TODO | `src/client/**` |
| M3-09 | 确认框：短警示 + 本次清单（按动作不同）+ 理由输入 + 二次确认 | TODO | `src/client/**` |
| M3-10 | 取消 = 零副作用（事件数不变、子会话数不变） | TODO | `src/client/**`、`test/channel/**` |
| M3-11 | 版本历史面板：每版一行 + 当前可见标记 + 恢复按钮 | TODO | `src/client/**` |
| M3-12 | 不可恢复态：跨压缩 / 读不到正文 / 目标已被接替 → 只显示链、不给恢复按钮 | TODO | `src/client/**` |
| M3-13 | 未生效吸顶条：`还有 N 条改动未生效` + 逐条应用 / 放弃 | TODO | `src/client/**` |
| M3-14 | 状态说明条（提示样式）：轮次未结束 / 会话不在本进程 | TODO | `src/client/**` |
| M3-15 | 快照面板：冻结（人写备注）→ 记录列表 | TODO | `src/client/**` |
| M3-16 | 开子会话确认框五项（切点/首条任务/继承与不继承/副作用/取消语义） | TODO | `src/client/**` |
| M3-17 | 子会话索引行：来源徽章（`tryMembership`）+ 状态 + `活跃 N/8` + 动作 | TODO | `src/client/**` |
| M3-18 | 待处理结果三态（已收到结算通知 / 父会话下一轮已开始 / **回流未确认**） | TODO | `src/client/**` |
| M3-19 | 官方团队只读区块（roster + 任务板；投影 `failure` 时在最后有效数据上显示失败） | TODO | `src/client/**` |
| M3-20 | 降级：`ctx.agentTeams` 不存在时对接点全隐（不报错、不留空面板） | TODO | `src/client/**` |
| M3-21 | 视觉与可达性：深浅主题、640px 无横向滚动、触控 ≥44px、Esc/Cmd+Enter | TODO | `src/client/**` |
| M3-22 | 🙋 人工门禁 30 条（你逐条看）+ 与 demo 的逐条一致性核对 | WAIT🙋 | `docs/03-ui-spec.md` §7 |

---

## 6. M4 · 轮次联动（**0 / 4**）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M4-01 | 轮次条数据：每轮 `用户消息 N · 注入内容 N`（口径与 S1 一致） | TODO | `src/client/**`、`src/redline/metrics.ts` |
| M4-02 | 点击某一轮 → 右侧切到该轮**最后一步**（标题写"共 N 步，显示末步"） | TODO | `src/client/**` |
| M4-03 | 目标会话判据落地（"当前标签页选中的会话" vs agent 在跑的会话，必须可指认） | TODO | `src/client/**` |
| M4-04 | 产物重打后硬刷新即生效（不重启 `dsh web`）—— 留证据 | TODO | 构建 + 浏览器验证 |

---

## 7. M4.5 · 平台能力验证（**0 / 18**）—— M5 的硬前置

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M45-01 | 包 A（只读）：`ctx.agents.get(sessionId)` 对当前会话是否可得（V3） | TODO | 探针脚本（临时目录） |
| M45-02 | 包 A：能否读到替换前的**原文**（V8 关键） | TODO | 探针脚本 |
| M45-03 | 包 A：`subagents.getProvider('fork')` 是否在册、`startContinuable` 是否可用（V12） | TODO | 探针脚本 |
| M45-04 | 包 A：`agentTeam` 投影可读性（V10）+ `tryMembership` 对 Lead 的判定（V13） | TODO | 探针脚本 |
| M45-05 | 🙋 包 B（一次授权）：在**专用可弃会话**里真跑 替换 → 再替换 → 回滚（V7） | WAIT🙋 | 专用会话日志 |
| M45-06 | 包 B：跨压缩 checkpoint 的版本能否恢复（V9） | WAIT🙋 | 专用会话日志 |
| M45-07 | 包 B：`spawnTeammate(context:'fork')` 建出的成员是否进 roster、种子是否正确 | WAIT🙋 | 专用会话 + 官方面板 |
| M45-08 | V1–V6 逐条给结论（读路径与判定是否与真机一致） | TODO | `docs/01-platform-facts.md` §6 |
| M45-09 | V10 降级契约实测（不可读时行为符合 `docs/03` R5.1.2.1） | TODO | `docs/03-ui-spec.md` |
| M45-10 | V11：可续接子会话端到端（含**父不在进程** / **父正忙** 两个分支） | TODO | 专用会话日志 |
| M45-11 | V12：官方团队启用时服务层仍可用（并记录会话里实际存在的 subagent 工具） | TODO | `dump-config` + 真机 |
| M45-12 | V13：对接面五项（可选注入 / Lead 判定 / spawnTeammate / 任务板 / 投影） | TODO | `docs/01-platform-facts.md` §6 |
| M45-13 | 失败决策表：V1–V13 每条失败 → 降级路径（禁止"以后再想"） | TODO | `docs/04-roadmap.md` M4.5 |
| M45-14 | 能力开关（`{agents,fork,compaction,team}`）默认值定死并写进文档 | TODO | `docs/04-roadmap.md` |
| M45-15 | 同步变更表：开关一变，`docs/00`/`docs/03`/`docs/05` 三处同改（逐项提交 diff） | TODO | 三份文档 |
| M45-16 | 授权包 A/B 的记录归档（谁批的、何时、结论） | TODO | `docs/08-open-questions.md` §9 |
| M45-17 | 真机证据回写：每条结论附命令 + 输出片段 | TODO | `docs/01-platform-facts.md` |
| M45-18 | 复核：M4.5 全绿前不进 M5（硬门禁写进本文件头部） | TODO | 本文件 |

---

## 8. M5 · 快照 → 子会话 → 压缩 → 对接官方团队（**0 / 26**）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M5-01 | `child.create` 优先路径：`agentTeams.spawnTeammate(lead,{context:'fork',provider:forkProvider,…})` | TODO | `src/host/orchestrate.ts` |
| M5-02 | 兜底路径：`subagents.startContinuable({provider:'fork'})`，界面如实标注"裸子会话" | TODO | `src/host/orchestrate.ts`、`src/client/**` |
| M5-03 | 可选注入 `agentTeams`：团队未启用时插件仍能加载、对接点全隐 | TODO | 插件入口 |
| M5-04 | 首条任务必须人写（空则拒绝创建） | TODO | `src/host/orchestrate.ts` |
| M5-05 | 确认框五项内容生成 | TODO | `src/host/orchestrate.ts`、`src/client/**` |
| M5-06 | 取消零副作用：`child.list` 无新项 + 事件数不变 | TODO | `test/channel/**` |
| M5-07 | 官方对接（读）：`agentTeam` 投影 / `listTasks` → 面板显示官方那份数据 | TODO | `src/host/team-bridge.ts` |
| M5-08 | 官方对接（写）：`createTask({subject,description,blockedBy,writeScopes})` | TODO | `src/host/team-bridge.ts` |
| M5-09 | 官方对接（写）：`updateTask`（`expectedRevision` 过期被拒，不覆盖） | TODO | `src/host/team-bridge.ts` |
| M5-10 | 派活：`sendMessage(lead,{target,content})` + 如实显示 `accepted`/`queued`（queued 不重发） | TODO | `src/host/team-bridge.ts`、`src/client/**` |
| M5-11 | 打断：团队成员走 `agentTeams.interrupt`；裸子会话走 `interruptByParent` | TODO | `src/host/orchestrate.ts` |
| M5-12 | 来源判定 `tryMembership` → 徽章（本项目发起 / 来自 Agent Teams），不按 label 猜 | TODO | `src/host/team-bridge.ts` |
| M5-13 | 容量：显示 `活跃 N/8` + 触顶给人话（不含糊、不说"稍后重试"） | TODO | `src/client/**`、`src/host/orchestrate.ts` |
| M5-14 | 压缩体检：在跑 / 未闭合 / 已在压 / 不在本进程 / 服务缺失 → `canCompact` + 理由 | TODO | `src/host/orchestrate.ts` |
| M5-15 | 压缩确认：列出将被替代的区间与条目数 + 不可逆提示 | TODO | `src/client/**` |
| M5-16 | 压缩执行：`compactNow` + 失败码人话（busy/cancelled/changed/summary/commit/persistence） | TODO | `src/host/orchestrate.ts` |
| M5-17 | 压缩后如实显示**实际**范围（不是预估） | TODO | `src/client/**` |
| M5-18 | 结果回流：读父会话 `subagent-settled` + `pending_results` 已查看标记 | TODO | `src/host/orchestrate.ts` |
| M5-19 | 三态判定：已收到结算通知 / 有可关联的后续 `turn/start` / 未确认 | TODO | `src/redline/pending.ts` |
| M5-20 | `plan.next` 次序机器化：waitTurn > applyDrafts > pinInvariants > startChild > compactChild > reviewChild | TODO | `src/redline/plan.ts` |
| M5-21 | 不膨胀可观测：周期内父会话事件数/字节增量 + 逐条说明来源 | TODO | `src/redline/metrics.ts` |
| M5-22 | 单测：`plan.next` 每种输入组合（含"到我这为止"） | TODO | `test/edit/**` |
| M5-23 | 单测：草稿不进种子（只写本地） | TODO | `test/edit/**` |
| M5-24 | 单测：团队服务缺失 → `team.*` 返回 `null` 且界面隐藏对接点 | TODO | `test/channel/**` |
| M5-25 | 🙋 端到端验收（授权包③，你在场点按钮）：冻结 → 建成员 → 压缩 → 回流 | WAIT🙋 | `docs/00-scope.md` S5.5 |
| M5-26 | 回流未确认的人工入口（"让主会话接着做"）可用 | TODO | `src/client/**` |

---

## 9. M6 · 入口与发布准备（**0 / 10**）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M6-01 | RPC ops 全量可用（读 12 + 写 13 + `team.*`），逐个可调 | TODO | `src/host/redline-channel.ts` |
| M6-02 | `/redline` 命令：只读报告 + 一句话建议（`plan.next` 的 reason 必显） | TODO | `src/host/command.ts` |
| M6-03 | 内部服务导出（`ctx.redline`）：`inspect/apply/annotate/invariants.*/freeze/plan` | TODO | `src/host/service.ts` |
| M6-04 | README 双语（成对）+ 截图 + 安装/使用/限制 | TODO | `README.md`、`README.zh.md` |
| M6-05 | CHANGELOG / release notes（简洁双语版式：锚点 + 兼容性一行 + 分类 bullet + 升级命令） | TODO | `CHANGELOG.md`、`docs/releases/**` |
| M6-06 | 打包与安装说明（本地目录 → npm 的路径） | TODO | `package.json`、`README*.md` |
| M6-07 | 干净环境安装验证（装得上、卸得掉、无残留） | TODO | 独立 profile 或临时目录 |
| M6-08 | 许可与来源复核（`LICENSE-Apache-2.0` 原样、`NOTICE`、`UPSTREAM.md` 与 diff 对齐） | TODO | `LICENSE*`、`NOTICE`、`UPSTREAM.md` |
| M6-09 | 版本与 tag 策略（tag = `package.json` 版本） | TODO | `package.json` |
| M6-10 | 发布前自检（本文件全绿 + `dump-config` 无冲突 + 两面板并存） | TODO | 本文件 + 只读命令 |

---

## 10. M7+ · 本轮明确不做（要动之前先单独立项）

| ID | 子模块 / 子任务 | 状态 | 文件动作（范围冻结） |
|---|---|---|---|
| M7-01 | 装配层：**先盘官方**（preset / agent-preset-registry / persona / agent-instructions / 补丁方言）缺什么 | TODO | `docs/00-scope.md` §4.1（只写调研结论） |
| M7-02 | 只读工具入口（让模型读"有哪些漂移/成员"）—— 默认不做 | TODO | — |
| M7-03 | 父不在进程时的冷恢复体验（当前：尽力而为 + 如实显示未确认） | TODO | — |
| M7-04 | 从更早切点分叉（"从某条旧快照重开"）—— 当前只用最新 `turn/end` | TODO | — |

---

## 11. 进度总览（**每次收尾回来改这里**）

| 阶段 | 项数 | DONE | DOING | TODO | WAIT🙋 |
|---|---|---|---|---|---|
| X 横切 | 7 | **2** | 3 | 1 | 1 |
| M0 文档集 | 20 | **20** | 0 | 0 | 0 |
| M0.5 交互 demo | 22 | **21** | 0 | 0 | 1 |
| M1 骨架与身份 | 14 | 0 | 0 | 13 | 1 |
| M2 编辑面 | 28 | 0 | 0 | 28 | 0 |
| M3 右侧界面 | 22 | 0 | 0 | 21 | 1 |
| M4 轮次联动 | 4 | 0 | 0 | 4 | 0 |
| M4.5 能力验证 | 18 | 0 | 0 | 15 | 3 |
| M5 编排 | 26 | 0 | 0 | 25 | 1 |
| M6 入口与发布 | 10 | 0 | 0 | 10 | 0 |
| M7+ 后续 | 4 | 0 | 0 | 4 | 0 |
| **合计** | **175** | **43** | **3** | **121** | **8** |

> ⚠️ 改完任何一张表，**必须回来同步这一张**（否则这里就成了第二个"真相"）。
> 当前卡点：**M05-15 交互定稿（等你）**；其后 **M1-01 授权包①（等你重启）**。
