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
| X-08 | 维护 `docs/11-session-handoff.md`：每次收尾更新"最新提交/进度/卡点/demo 服务/浏览器工具状态"与那段可复制交接文本（换会话时用户直接粘贴） | DOING（本次已建） | `docs/11-session-handoff.md` |
| X-07 | **恢复官方浏览器控制**（用户选 B）：装 `@deepseek-ai/dsh-browser-use@0.2.0-rc.1` + `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.0-rc.1`（peer 钉在运行时 0.2.0-rc.1；`@playwright/mcp@0.0.80` 经 `require.resolve` 验证可解析；chromium / headless-shell rev 1243 已在 `~/Library/Caches/ms-playwright`）→ 取消 patch 里那段 `insert` 注释 → `dump-config` exit 0 且两行在合成树里；`package.json` 差异仅预期两行、其它插件完好。**回退**：还原 `cordis.patch.yml.before-browser-use-restore-20260930-184704` + `dsh plugin --profile web remove` 那两包 + 重启。**生效范围＝新建会话**（本会话不受影响） | DONE → **2026-09-30 新会话实测工具在位**（`browser_navigate/resize/screenshot/evaluate/console_messages` 均可用，已完成 M05-23/24 的实测）；另附一条限制：headless 无触屏，`(pointer: coarse)` 不命中 | `$DSH_HOME/profiles/web/{cordis.patch.yml,package.json,pnpm-lock.yaml}`（已各备份一份） |
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

## 2. M0.5 · 交互 demo（**44 / 45 DONE**，剩定稿）

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
| M05-23 | 浏览器实测（新会话有官方 Playwright MCP 后第一次跑）：1440 宽屏、880/879 断点、390 手机视口各截图 + 量布局（列宽、卡片高、趋势内容宽/可视宽、整页横向溢出、动作按钮高、console 条数）；原始数据落 `demo/screenshots/measure-log.md` | DONE → 1440 两列各 700 / 溢出 0px；880 仍两列、879 折单列（断点=880）；390 单列 362、趋势 `557>336` 内部滚动、整页溢出 **0px**、console **0 条**；截图 6 张 | `demo/screenshots/**`、`docs/03-ui-spec.md` §7 引言 |
| M05-24 | 实测抓出的真 bug：自测面板把刻度上限显示成 `undefined`（`renderTrend()` 把刻度计算排进 rAF，`render()` 紧接着渲染面板 → 读到刚重建、没算过的节点）→ 修（末尾同步先算一次 + 刻度变化时刷新面板）；**先写红护栏**：把冒烟测试的 rAF 桩改成**后置队列**（同步 rAF 看不见这类时序 bug），新增 4 条断言，先在旧代码上跑出 4 红、修完 4 绿 | DONE → 修前 **4 红**（`❌ 刻度上限有值…→ undefined` 等）、修后 **58/58 绿**；浏览器复验 `当前刻度上限 7270`（与 `data-max` 一致）、无 `undefined` | `demo/demo.js`、`demo/check-runtime.mjs`、`demo/redline-panel.html`(?v=5)、`demo/redline-panel.standalone.html` |
| M05-25 | 用户问"10.0.0.30:5180 上看到的是最新 demo 吗"暴露的两个坑：① 单文件版是生成物、**没有 `?v=N`**，改完 css/js 忘了重打包时外观完全看不出 → 打包时把 `sha256(demo.css+demo.js)` 前 7 位写进页头标签（`单文件版 <指纹>`，内容是哈希所以**重打包幂等**），并让 `check-static.mjs` 比对指纹；② `python3 -m http.server` 不发 `Cache-Control` → 浏览器把单文件版缓存住（实测：普通刷新拿到的仍是旧页头）→ 换成 `demo/serve.py`（只读、统一 `no-store, must-revalidate`） | DONE → **先红**：加指纹检查后立刻跑 `check-static` → `❌ 单文件独立版不是最新的（指纹对不上，当前应为 2f0ecb0）` exit=1；重打包后 ✅ exit=0、连打两次 md5 不变；curl 核对服务端与本地同一份；浏览器**普通刷新**（无 `?t=`）页头即 `交互原型 v1 · 单文件版 2f0ecb0`、console 0 条 | `demo/build-standalone.mjs`、`demo/check-static.mjs`、`demo/serve.py`（新增）、`demo/serve.sh`、`demo/README.md` |
| M05-26 | 用户报"又打不开了" → 根因：demo 服务原本是**用 shell 后台任务**起的，寿命跟着父进程走，父进程一收工服务就没了（实测：端口 5180 无监听、`pgrep` 无 python 进程、`job_list` 空）。改成**守护进程**：`serve.py --daemon` 双 fork + setsid（PPID=1、无控制终端）；**先绑定端口成功才写 pidfile**（pidfile 存在 ⇒ 真的起来了，失败不误报成功）；日志 `/tmp/redline-demo-5180.log`；`serve.sh` 支持 `start/fg/status/stop`，`stop` 按 pidfile 并回退按端口查（修好以前失效的 stop）。**注意**：`--daemon` 的父进程用 `os._exit` 退出 → 报状态那行必须 `flush=True`，否则什么都看不到（已踩） | DONE → `ps`：`PID 98728 PPID 1 TTY ??`；**跨两次独立 shell 调用**仍 `在跑 (pid 98728)`；`curl 127.0.0.1 → 200`、`curl 10.0.0.30 → 200`、`Cache-Control: no-store`；浏览器走局域网地址：页头 `单文件版 2f0ecb0`、84 热区、溢出 0px、console **0 条** | `demo/serve.py`、`demo/serve.sh`、`demo/README.md` |
| M05-27 | 用户反馈「快照与子会话这部分的排列，没有其他几个部分好看」→ 按**其他卡片同一套行语法**重排（`docs/03` R5.1 的内容一个字没改，只改排布）：① 小节一律 `.subhead` 标题 + `.hint` 说明（原来把括号说明混在标题里）；② 每个子会话/成员行统一成**两行** —— 上行身份（`id` / 来源徽章 / 状态徽章 / 描述，超宽省略号），下行动作（缩进 22px，与浏览器卡片 `.actions` 同款），不再出现"`打开` 孤零零挂右上角、其余按钮换行后还带悬挂缩进"，同一张卡两行子会话排布也不再各不相同；③ 状态用**圆点 + 徽章**取代 ✅/⚠️ emoji（`docs/03` V5 本来就禁止 emoji，顺带纠规范）；④ 冻结记录收成一行（id + 元信息 + 人写备注）；⑤ 任务板 owner 右对齐、roster 做成 chips、`去官方面板` 从一行灰字改成真按钮；⑥ 说明文字挨着按钮，不顶到最右。**同一轮发现并修掉一个真 bug**：团队不可用时 `派活` 只是**置灰**、`建成官方任务`/`去官方面板` 照旧在 —— 而 R5.1 要求"**不出现**（不是报错）"，demo 自己的 README 也这么写；现在只剩 `打开 / 压缩 / 打断`（裸子会话通道），并按**按钮属性**（`data-act`）补了 7 条护栏 | DONE → 先写红护栏（按 `data-act` 判定）→ **2 红**；修后 **65/65 绿**；反向验证（把判断改回"置灰"）→ 又 **2 红**，改回即绿；静态契约 `41 id / 84 class / 29 讲解键` 绿。截图：`orch-before-1440.png`(633px) → `orch-after-1440.png`(683px)、`orch-team-off.png`、`orch-after-390.png`（390 整页溢出 0px、`.actions` 不溢出）、`orch-in-context-1440.png` | `demo/demo.js`、`demo/demo.css`、`demo/check-runtime.mjs`、`demo/README.md`、`demo/redline-panel.standalone.html` |
| M05-28 | 用户反馈「上下文趋势的柱状图，鼠标移过没有 hover 样式、点中了也没有和其它柱体不一样的样子，看不出移到/点了哪一根；参考插件 dsh-context 做得好」→ 对照参考插件 `src/client/styles/trendChart.css` 与 `src/client/components/trendChart.tsx` 实测出三处实质差异并逐条补齐：① **命中区**：参考的 `.lc-bar` 是 `height:100%` 整列可点、色块画在子元素里，我们的柱体只有色块本身（实测 bar0 = 69px，柱子上方空白命中不到）→ 改成整列 `<button class="tbar">` + 内层 `<i class="tbar-fill">`；② **hover**：参考有列底色 + 1px 虚线框，我们只有一根 1px 虚线（实测 `1px dashed rgb(139,139,245)`、无底色）→ 加列底色 + 色块 `brightness(1.25)`；③ **选中**：参考是 2px 实线框 + 整轮 `lc-bar-in-turn` 底色，且**规则声明在 hover 之后**（参考源码专门注释了这个顺序陷阱），我们只有 2px 白框 → 加 20% 品牌底色 + 同轮其它柱子 10% 底色，并把 `.tbar.sel` 排在 `.tbar:hover` 之后 | DONE → **先红后绿**：新增 5 条 CSS 契约（整列高度 / hover 要有底色 / 选中要有框+底色 / `.sel` 必须排在 `:hover` 之后 / 必须存在 `.tbar-fill` 与 `.tbar.in-turn`）+ 2 条结构契约（每根柱子都有色块、高度不写在外层）→ 修前 **7 红**（`柱子 72 根 · 色块 0 个` 等）；修后 **67/67 绿**、`check-static` 绿。浏览器实测：`elementFromPoint` 在柱子上方 5% 处命中 `button.tbar`（整列可点）；悬停计算值 `1px dashed #8b8bf5 + bg rgba(255,255,255,.07) + fill brightness(1.25)`；点中 `2px solid #f4f4f5 + bg brand 20%`，按步骤模式另 1 根同轮柱子得 `in-turn` 10% 底色；console **0 条**。截图 `trend-hover-1440.png`、`trend-selected-step-1440.png` | `demo/demo.css`、`demo/demo.js`、`demo/check-static.mjs`、`demo/check-runtime.mjs`、`demo/redline-panel.standalone.html` |
| M05-29 | 用户反馈「我以为讲解模式只是加个左上角数字编号的注解，不会影响原来的样式；实测在趋势柱体那里影响还比较多」→ 实测坐实两条：① 讲解高亮写在 `body.explain [data-explain] { outline: … }` 上，特异性 **(0,2,1)** 高于柱体自己的 `.tbar:hover` / `.tbar.sel`（都是 0,2,0）→ 实测"普通柱 outline = `1px dashed rgba(139,139,245,.518)`、选中柱 = `1px dashed rgb(189,189,245)`"，**选中那根的 2px 实线框被整片盖掉**，这才让用户以为柱体没有 hover/选中反馈；② 每根柱子各挂一个编号 → `#trendScroll` 里 **102 个编号**糊满图表。修法三条硬规矩（已写进 `docs/03` §7 引言）：高亮只画在 `::after` 伪元素上（不占用元素的 outline/background/border）；高亮**跟着编号走**（加 `.explain-num` 类）；**同类重复元素只标一个编号**（柱体标当前选中的那根、轮次刻度标第一格） | DONE → **先红后绿**：新增 5 条运行时护栏（3 个普通元素各 1 个编号 / 柱子只标 1 根且是选中那根 / 刻度格只标 1 个 / 只有带编号的元素被标亮 / 关掉后编号与标亮都清理）+ 2 条 CSS 契约（讲解规则不许给元素自身设 outline·background·border、高亮必须挂在 `.explain-num` 上、不许有针对 `.tbar` 的讲解覆盖规则）→ 修前 **3 静态红 + 3 运行时红**；修后 **静态绿 + 75/75 绿**。浏览器实测（讲解模式开着）：趋势区编号 **102 → 2**、28 根柱子里**只有 1 根带环**、选中柱仍为 `2px solid rgb(244,244,245)`、悬停柱 `1px dashed #8b8bf5 + bg rgba(255,255,255,.07) + fill brightness(1.25)`、console **0 条**；截图 `trend-explain-hover-1440.png`。踩坑记录：CSS 注释里为解释病因写了 `body.explain … .tbar` 字样，被自己的正则当成真实规则（已改成先剥注释再检查）；桩里 `classList` 与 `className` 是两套东西，导致"选中那根"判定误红（已同步） | `demo/demo.css`、`demo/demo.js`、`demo/check-static.mjs`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md` §7 引言、`demo/redline-panel.standalone.html` |
| M05-30 | 用户在趋势区一次提 4 条，逐条处置：① **柱体按类别分色堆叠**（总计 = 各段按该类占比自下往上堆；增量 = **围绕零线**正差向上 / 负差向下，颜色仍是类别）—— 照参考插件 `trendChart.tsx` 的 `lc-cat-seg` 与它的原注释 "positive category deltas pile UP from the zero line, negative ones hang DOWN from it, both in category colors"，零线按 `maxUp:maxDown` **成比例**分割（`deltaScale = CHART_H / span`）；②③ **讲解编号必须稳定**：改成按"元素类别"（讲解词典里的固定序号）编号 + 同类只标一个 → 切换粒度/内容都不再变号；④ **删掉趋势卡底部的步级快捷片与顺序导航**（用户原话：hover 就报第几轮第几步、点一下就选中，那排只是重复信息还抢注意力），轮号刻度带保留（它是坐标轴） | DONE → 先红后绿：新增 6 条结构护栏（柱子有内层图形 / 段带 `data-cat` / 段用类别色 / 总计模式不渲染零线与两臂 / 增量模式有零线与两臂且**两臂总高 ≤ 112px** / 底部已无快捷片与导航）+ 1 条静态类名撞车护栏 → 修前 **3 红**（`段 0 个`、两臂总高超 112、`.seg` 规则 2 条）→ 修后 **静态绿 + 88/88 绿**；反向验证两条（去掉正负号筛选 → 1 红；类别段改回 `.seg` → 2 红）。浏览器实测：总计 28 柱 × 4~6 段、7 种类别色、末柱段高之和 111 ≈ 柱高 112；增量模式 `红色段 0`、上臂 `assistant:1 tool:2` / 下臂 `user:1`、零线 `bottom:30px`、轴 `+4.5k / −1.6k`；**编号稳定性实测**（按轮次 vs 按步骤）`trend.gran=6 / mode=7 / adaptive=8 / jump=10 / mark=12 / pick=11` 两模式**完全一致**，步骤模式只多一个 `trend.strip=13`；底部"上一轮/下一步"已消失；console 0 条。截图 `trend-total-cats-1440.png`、`trend-delta-1440.png`。**顺带修掉两个自己引入的 bug**：类别段类名 `.seg` 与分段控件按钮撞名（会把按钮撑成整行）、增量两臂未按正负筛选导致内容重复渲染 | `demo/demo.js`、`demo/demo.css`、`demo/check-static.mjs`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R1.6 / R1.11 / R1.13 / R1.15 / §7）、`demo/README.md` |
| M05-31 | 用户四条续评：① **深色/浅色按钮不要了，跟随系统** → 删按钮，`demo.js` 依据 `prefers-color-scheme` 给 `body` 设 `data-ds-dark-theme`（正是 DSH 自己的深色选择器，demo 与真机走同一条通道），`?theme=dark\|light` 仅作验证钩子；② **自测面板是干什么的** → 它是自报尺寸/溢出的**验证工具**，改为 `?dev=1` 打开、不再占顶栏；③ **编号不连续**（用户问"13、15、16、17、22、23、25 在哪里"）→ 编号同时满足"连续"与"稳定"：取当前**存在的类别**按词典顺序排，依次编 1..N（既无空号，切粒度时柱子编号也不变）；④ **柱体颜色与分类树对不上** → 实测两边 computed 色值**本来就完全一致**（如注入内容都是 `rgb(192,132,252)`），真正的元凶是我给选中/悬停柱子加的 `filter: brightness(1.15/1.25)` —— 它把整根柱子的类别色提亮了；已删除该滤镜，反馈只走"列底色 + 框"，并加护栏锁死 | DONE → 实测：颜色一致性逐类**全部"一致"**（浅色 7 类 / 深色 6 类，含 no-filter 校验）；编号 **空号 0**（按轮次 max 25、按步骤 max 26），柱体编号两模式都是 **8**；顶栏只剩 `讲解模式 / 重置原型`；`?theme=dark` → `data-ds-dark-theme` 生效、body 令牌 `#8b8bf5`/`#f4f4f5`、卡底色 `rgb(35,35,36)`；`?dev=1` → 自测面板可见且无 `undefined`。护栏：新增/改写 8 条（编号连续、编号顺序按类别、主题挂 `body[data-ds-dark-theme]`、不许回 `html[data-theme]`、顶栏不许有那两个按钮、必须保留 `?dev=1`、柱体与分类树共用 `CATS` 色值、柱体不许 `filter:brightness`）→ 修前 2 红 + 反向验证 3 红（加回 brightness / 改回 html[data-theme]）→ 修后 **静态绿 + 91/91 绿**。截图 `trend-light-1440.png`、`trend-dark-1440.png` | `demo/demo.js`、`demo/demo.css`、`demo/redline-panel.html`、`demo/check-static.mjs`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（V2/§7）、`demo/README.md` |
| M05-32 | 用户两条实测：① **「改这一轮的用户消息」点了没反应**（讲解模式 #10）→ 根因：它的 inline `onclick` 是 `document.querySelector('[data-turn=N]').click()`，而 `[data-turn]` **只在"按步骤"模式的刻度格里存在**（按轮次模式的刻度格带的是 `data-seq`）→ 默认模式空操作；而且它压根没做 R1.4 要求的后两件事。改为直接调 `editTurnUserMessage(turn)`：切到**该轮最后一条用户消息**那一步 → 展开「用户消息」类 → 打开该条的内联编辑器（预填全文）→ 滚到那一行；并补上 R1.4 的置灰态。② **编号 11 找不到** → 根因：`step.pick` 挂在 `<select>` 上，而编号 `<span>` 被塞进了 `<select>` 里 —— **select 只能装 option，浏览器直接丢掉**。改为把两个下拉包在 `.pickwrap` 里、`data-explain` 挂包层；并在 `applyExplain` 加通用兜底：遇到 select/input/textarea/img 就把编号挂到父节点 | DONE → 先写红护栏：静态 2 条（不许把 `data-explain` 挂在 select/input/textarea 上、不许再用 `[data-turn]` 跨卡片点按）+ 运行时 5 条（点按钮真的切到该轮最后一条用户消息 / 展开「用户消息」/ 打开编辑器且 seq 正确 / 无用户消息时返回 false / `data-explain` 落在 select 上时编号挂父节点且父节点被标亮）→ 修前红、修后 **静态绿 + 97/97 绿**；反向验证：把按钮改回 `[data-turn]` 点按 → 静态 1 红。浏览器实测：按轮次模式（旧实现无效的那种）点按钮 → 回执 `已切到第 28 轮最后一条用户消息 #1301，编辑器已展开`；切到第 5 轮再点 → 右侧切到 `第 5 轮 · 第 2 步`、用户消息类展开、#262 编辑器打开且正文已预填（截图 `r14-edit-turn-user.png`）；编号 10 挂在按钮上、编号 11 挂在 `.pickwrap` 上且**可见**（`getBoundingClientRect().width > 0`）；新增状态开关「本轮没有用户消息」→ 按钮 `disabled` + title 正确。**注意**：demo 现有 28 轮每轮都有用户消息，故置灰态只能靠这个开关演示 | `demo/demo.js`、`demo/demo.css`、`demo/check-static.mjs`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R1.4/§7） |
| M05-33 | 上一轮自查发现的门禁空缺：demo 里的消息都是短句，**没有一条 >200 字、多段的用户消息** → `docs/03` R3.4（编辑器必须预填宿主**全文**、多段会被合并成一段时要在提交前提示）与人工门禁第 5 条**在 demo 上根本验不了**（而真机上这正是最容易出错的地方，早期就是把它当正文栽过一次）。按用户「按照建议执行」：新增一条 **213 字 / 4 段**的演示用户消息 `#1305`，接到最后一轮最后一步的 surface 末尾 → 它成为该轮「最后一条用户消息」，也就是 R1.4 按钮的目标；并在 `editorHtml()` 实现 R3.4 的多段提示（`这条消息有多个文本段落；改写后会合并为一段。`，**仅**原消息确实是多段时出现） | DONE → 先写红护栏：运行时 5 条（演示数据里必须有一条 >200 字且多段的用户消息 / R1.4 的目标就是它 / 编辑器预填字数 = 原文全文字数且 >200 / 多段时出现提示 / 单段时不出现提示）+ 静态 2 条（R3.4 提示文案必须在；长消息与 R1.4 链路必须在）→ 反向验证：删掉多段提示 → 运行时 1 红 → 改回即绿。浏览器实测（页面默认状态，未 apply 过任何草稿）：点「改这一轮的用户消息」→ 编辑器标题 `编辑 #1305（遮蔽原文）`；**编辑器正文 213 字 / 4 段**，而同一行的列表预览只有 **90 字**且 `text-overflow:ellipsis` 真截断（`scrollWidth > clientWidth`）→ R3.4「预览 ≠ 全文」在界面上看得见；提示行两条并列：`这一步只存本地草稿…` + `这条消息有多个文本段落；改写后会合并为一段。`截图 `r34-fulltext-multipara.png`。**顺带记一个测试坑**：护栏里必须先清掉前面用例 apply 出来的替换体（seq=1300 会被追加到该轮末尾，从而变成「最后一条用户消息」），否则验的不是演示数据的原始状态 | `demo/demo.js`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（R3.4）、`demo/README.md` |
| M05-34 | 用户 2026-10-01：「我们上下文编辑不只是编辑用户的消息吧，应该也是要编辑**注入的内容**，也就是 AI 可能理解错的内容」→ 核实后发现 demo 对注入类只有「能编辑」半条腿，另外三条**全缺**：① 存下来的固定块**没有列表**（存完就消失，只剩一句回执）；② **没有漂移检查**（S4 / 门禁第 18 条要求）；③ **没有重注入 / 退休**（R4.3 连确认框文案都写好了）；④ 快捷入口只有用户消息那一个。补齐：新增 **R1.16**「改这一轮的注入内容」（R1.4 的对称入口，直接调 `editTurnInject()`）；新增 **R2.4 固定块（不变量）面板**（右列新卡片：列表 + **逐字包含**漂移检查 + 重注入 + 退休，动作都过 R4.3 确认框）；R5.2 的「没有固定块就给建议」也补上。**顺带修掉一个真实演示数据缺陷**：apply 生成的新条目 seq 从 `1300 + 已应用数` 起算，而演示数据里已有 1300/1301/1303/1305 → **连改两次就撞号**（`nodeOf()` 命中同名 seq，张冠李戴，浏览器里真的复现了）→ 改为从 **1600** 起算 | DONE → 先写红护栏（运行时 11 条 + 静态 4 条）→ 修前红（含 `data-explain 没有讲解词：turn.inject/act.reinject/act.retire`）→ 修后 **静态绿 + 114/114 绿**。浏览器实测（真实点击路径）：空态提示「还没有固定块…」；点「改这一轮的注入内容」→ 展开「注入内容」类 + 编辑器 `#1303` + 回执；对 `AGENTS.md` 点「存为不变量」→ 面板出现 `inv-AGENTS.md-1 | 在效 | AGENTS.md · v1 · workspace 级 · 逐字命中 #3（AGENTS.md）`；把这条注入**改写掉**并应用 → 面板实时变 `漂移 | … 这一步的注入被改写过（#1600），钉住的原文已不在里面`；`重注入` 确认框短警示「会往会话追加一条消息，不可撤销。」+ 逐字清单 → 确认后逐字追加；`退休` → `已退休：不再生效（历史版本保留）`。截图 `blocks-drift.png`。**踩坑记录**：① 护栏把动作名写成 `reinject`，而按钮/实现用的是 `breinject` → 静默什么都不做白调一轮；② 「注入类默认折叠」时行根本没渲染，把「行上没有 pin 按钮」误判成缺失 → 断言必须放在展开之后 | `demo/demo.js`、`demo/redline-panel.html`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（§0 / R1.16 / R2.4）、`demo/README.md` |
| M05-35 | 用户问「除了用户消息和注入消息外，还有哪些内容可以编辑，作为后期的上下文快照吗？」→ 先把每一类的按钮**从页面实测**出来，对照 `docs/03` R2.1/R2.2/R3.2 发现 demo 有**三处没对齐**：① 系统提示词行**多给了「批注」**（规格要求「无动作条、也不留空占位」）；② **技能注入少了「存为不变量」**（R2.1 表里 ✅ —— 它和注入内容一样每轮被重新注入）；③ **工具结果的编辑器缺 `isError` 开关**、还多给了「思考文本」（R3.2：工具结果只给内容文本 + 错误标记）。三处都修：`ability()` 增加 `inert`（系统提示词/工具定义：一个动作都不给、也不渲染空动作区）与 `pinnable`（注入内容 + 技能注入）；编辑器字段改为**按底层类型**给（工具结果 = 结果文本 + isError；其它 = 可见文本 + 思考文本）；`isError` 的改动能落进草稿并带到 apply 后的新条目。另在 R2.1 后补一段「这些改动怎么进上下文快照」的回答 | DONE → 新增 **A17 式按钮集合护栏**（按底层事件类型锁定 7 类行的按钮集合：系统=无动作条 / 用户=编辑+批注 / 注入=编辑+批注+存为不变量 / 技能=编辑+批注+存为不变量 / 助手=批注 / 工具结果=编辑+批注 / 被压缩埋掉=批注 + 被遮蔽的原文不给编辑且给原因）+ 两条编辑器字段护栏 + 两条 isError 流转护栏 → 修前红、修后 **静态绿 + 127/127 绿**；反向验证：把 `inert` 改回 false → `系统/system/message` 一条变红（实测拿到 `编辑+批注`）。浏览器实测：`#1 动作条=无`；技能注入 = `编辑+批注+存为不变量`；工具结果编辑器字段 = `结果文本（工具结果只能改内容文本与错误标记…）` + `标记为错误（isError）`，**没有思考文本**（截图 `tool-result-editor.png`） | `demo/demo.js`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R2.1）、`demo/README.md` |
| M05-36 | 用户提议「技能注入 / 助手消息 / 工具结果是不是可以做高级编辑，一般用户用不到？」→ 先纠正划分依据：**漂移**只跟「这条内容下一轮会不会被宿主重新注入」有关（注入内容 ✅、**技能注入 ✅** 同族会漂；用户消息/助手消息/工具结果都是历史，不漂）——所以**技能注入不能归高级**；真正的依据是「用户需要动手的概率」。据此新增 **R2.5「高级编辑」开关**（默认关）：**常用**＝用户消息 / 注入内容 / 技能注入（始终可见，都是「我告诉模型什么」）；**高级**＝工具结果（默认收起「编辑」）+ 助手消息（本来只有批注）。只收「编辑」入口，`批注` 永远保留；并且守住 R2.3「按钮不许凭空消失」——收起时留 `高级编辑` 小标记 + title 说明在哪打开 | DONE → 先写红护栏（运行时 6 条 + 静态 3 条：关档时工具结果无「编辑」但有标记与说明、批注仍在；开档时「编辑」出现；注入内容/技能注入在关档时**不受影响**）→ 修后 **静态绿 + 133/133 绿**；反向验证：把 `advancedOnly` 扩到 inject → `注入内容的「编辑」不受影响` 一条变红。浏览器实测（逐类读按钮）：默认 `aria-pressed=false`；工具结果 = `高级编辑 + 批注`，打开开关后 = `编辑 + 批注`；注入内容/技能注入在关档下仍是 `编辑 + 批注 + 存为不变量` | `demo/demo.js`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（R2.5 / R2.1）、`demo/README.md` |
| M05-37 | 用户问：「批注以后，在新的会话快照中，这个批注起到什么作用？」→ 核实发现两件事：① 文档只写了批注**会进**快照，**没写它在快照里起什么作用**（这正是「批注 ≠ 改写」的关键）；② demo 的批注提交**连确认框都没有**（直接追加），违反 `docs/03` R3.3.1（凡写入型提交按钮都要先出 R4.3 确认框，唯一例外是保存草稿）与人工门禁 #12。两件一起修：批注提交走 R4.3 确认框，并在「本次清单」里加两行 —— **在快照里**（会随快照/fork 种子进子会话；请求式：不遮蔽原文、不保证模型照做；长对话或压缩后可能被摘要吞掉）与 **想要「确定生效」**（用「编辑」+「应用到会话」；想长期有效则「存为不变量」）；编辑器提示行、讲解词 `act.annotate` 同步；`docs/03` 在「怎么进快照」那段后补 6 条批注语义 | DONE → 先写红护栏（运行时 7 条 + 静态 2 条）：批注提交**不直接写会话**且弹确认框 / 框里写明在快照里的作用 / 写明「请求式」/ 给出确定生效的替代路径 / 短警示含「原文保留，模型两者都能看到」 / 清单含目标·范围·理由 / 确认后真的追加带结构化头部的更正 → 修后 **静态绿 + 140/140 绿**。浏览器实测确认框逐字： 标题`提交更正到会话（批注）`、短警示`会向会话追加一条消息，不可撤销；原文保留，模型两者都能看到。`、清单 `更正目标 #1240 | 作废范围 seq=1240..1240 | 理由 … | 在快照里 这条更正会随快照（fork 种子）进子会话 —— 但它只是「请求式」的：不遮蔽原文、不保证模型照做；而且长对话或压缩之后，它可能被摘要吞掉 | 想要「确定生效」 …` （截图 `annotate-confirm.png`） | `demo/demo.js`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（R2.1 段后）、`demo/README.md` |
| M05-38 | 用户问（贴了别人的真实截图：主会话收集汇总、子会话跑 1635 轮）：「创建子会话之后，子会话可以对上下文进行编辑吗？官方智能体团队模式好像看不到它的上下文，是不是这种情况？」→ 核对平台事实后确认：**能编辑，关键动作是「打开它」** —— 子会话是真会话（独立 sessionId/日志，`docs/01` F13），我们的面板挂在会话视图上、永远显示「当前选中的会话」，所以打开子会话后面板就切到它的上下文，编辑能力与父会话完全一样（不需要两套界面）；而「在父会话里就地改它」平台不给（apply/annotate 要求目标会话自己的 live Agent），官方团队面板也只给成员导航 + 只读任务板（F30）。两条前提必须写在界面上：**轮次闭合**（长子会话几乎总在跑 → 只能等空闲或先打断）与**在本进程**。落地：子会话索引行按状态给出提示（运行中 → `轮次闭合前只能看，不能改`；空闲 → `打开它…就能像这里一样编辑`）；`child.open` 的讲解词写明「子会话的上下文同样能编辑」与两条前提；`docs/03` 新增 **R5.1.3** | DONE → 新增运行时护栏 4 条（运行中/空闲两种行各自的提示文案、讲解词里点出「能编辑」、点出两条前提）→ **静态绿 + 144/144 绿**。规格：新增 R5.1.3（含「为什么跨会话就地改不做」的理由 + 两条前提表 + 建议流程） | `demo/demo.js`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R5.1.3）、`demo/README.md` |
| M05-39 | 用户四条「界面没说人话」：① 用户消息的编辑器为什么有「思考文本 + 可见文本」两条；② 批注里的 seq 是什么、为什么要用户输准确数字；③「提交更正到会话」点了会怎样；④「保存草稿」是什么意思、之后要怎么做。核实后**其中一条是我违反了自己写的规格**：`docs/03` R3.2 早就写「思考文本（可选，**折叠在"高级"里**）」，demo 却没折叠；批注的作废范围按 R3.2 写成「seq 区间」后，我实现成了**两个数字输入框**（用户不可能知道 seq）。改法：① 主字段改名**「正文」**（并写明「模型看到的就是这一段、预填的是宿主全文」），思考文本收进 `<details>` **默认收起**；② 作废范围改成**选择器** —— 默认「就这一条（#seq）」，要扩大就从**当前这一步的行列表**里选终点（下拉带"类别 · 正文开头 · #seq"），并配一句解释「seq 是什么、你不用记数字」；③④ 按用户自己提的做法：**给动态出现的按钮加「?」**（编辑器里的提交/取消、确认框里的确认，点它弹出与讲解模式同一份说明），并在提交按钮旁写清**两步流程**（保存草稿 → 只存本地 → 行上出现「未生效」→ 点「应用到会话」才生效） | DONE → 先写红护栏（运行时 9 条 + 静态 4 条）：主字段叫正文 / 思考文本在 `<details>` 且默认收起 / 两步流程文案在 / 编辑器有 `?` 且指向正确讲解键 / 批注**没有** `type="number"` / 范围默认「就这一条」且下拉默认禁用 / 解释文案在 / 确认框里范围显示成「就这一条（#seq）」 → 修后 **静态绿 + 153/153 绿**。浏览器实测：编辑编辑器字段只有「正文」+「高级：思考文本」（收起）、两步流程一行、`保存草稿` 旁有 `?`（指向 `act.edit`）；**点 `?` → 讲解抽屉真的打开**（标题「编辑（遮蔽原文）」）；批注编辑器无数字输入框、`voidOne/voidRange/edTo` 三件套、默认就这一条、下拉禁用。截图 `editor-plain-language.png`、`annotate-plain-language.png`。**顺带修**：编辑器里那句解释的 `**` 会原样显示（改用 `<b>`） | `demo/demo.js`、`demo/demo.css`、`demo/redline-panel.html`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（R2.2 / R3.2 / R3.3）、`demo/README.md` |
| M05-40 | 用户三条（针对上一轮的补救）：①「`就这一条（#1240）` 我还是不知道这一条指的是哪一条」；②「从这一条到后面是个下拉列表；那个用户 2000 多条、总数可能上万条，会影响性能吗？**从质量测试角度你考虑过这些问题吗**？这个批注是不是只针对当前一条就可以了？要修的范围让用户写在批注里就好了 —— 给这个选择反而会带来很多问题」；③「我说的问号不是按钮后面单独加一个，要像讲解模式那样**左上角飘一个小问号**……真要实现时不能这么做，看着很差；demo 也要尽量拟真」。处置：① 更正目标改成**人话**（`第 N 轮 · 第 M 步 · 类别` + 正文开头），`#seq` 退居括号并注明「供追溯、你不用记它」；② **删掉范围下拉**：批注只针对点的那一条，更大范围由用户写在**理由**里（模型读的正是理由）；③ 「?」改成 `.qwrap + .qfloat`：贴着按钮**左上角飘的小圆标**（与讲解模式 `.exnum` 同一套定位 `top:-9px left:-8px`），不再是「按钮后面再挂一个按钮」 | DONE → 先写红护栏（运行时 6 条 + 静态 4 条）：目标用人话且 seq 退居括号 / **没有**范围选择器 / 写明「只针对这一条、更大范围写在理由里」/ `?` 是 `.qfloat` 且在 `.qwrap` 里 / 静态：不许 `type="number"`、不许 `id="edTo"`、必须有 `.qfloat`+`.qwrap`、必须有 `.targetbox` → 修后 **静态绿 + 154/154 绿**。浏览器实测：目标框文字 = `第 28 轮 · 第 3 步 · 用户消息「这条消息我后来发现写错了…」（事件序号 #1240：写进更正消息里供追溯；你不用记它）`；范围选择器**已不存在**；问号 `position:absolute` 且相对按钮 `dx=-8, dy=-9`（左上角外飘，与讲解模式一致）。截图 `annotate-v2.png`。**并记下质量教训**（docs/05 §1.5）：新增交互控件前先问量级与语义；界面里不许出现全量条目选择器。顺带修：批注说明里的 `**` 会原样显示（改 `<b>`） | `demo/demo.js`、`demo/demo.css`、`demo/redline-panel.html`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/03-ui-spec.md`（R2.2 / R3.2）、`docs/05-test-plan.md`（§1.5） |
| M05-41 | 用户四条：「① 「存为不变量」是什么意思、右侧提示也没看懂；② 左下角「上下文事件」起什么作用；③ 「冻结当前位置」是干什么的；④ 「开子会话」——他另外有个想法：微信群里有人把子会话**缩进嵌在左侧会话列表**里，问 DSH 能不能做到「主会话开子任务 → 子会话执行完通知主会话 → 主会话接着干」」。处置：**说明改成大白话**（固定四段结构：一句话是什么 / 为什么需要 / 你什么时候会用它 / 它不做什么；并补「点了会发生什么 / 能不能撤回 / 要不要确认」），「存为不变量」「冻结当前位置」「开子会话」三条讲解词全部重写；「上下文事件」卡补一句「这一栏是干什么用的」（被压掉的条目从此改不了、压缩不可逆）。④ 核实出**新平台事实 F36**：官方会话侧边栏**隐藏/省略** subagent 来源的会话，插件能占的行内插槽只有 action 类、**没有「插入新行」的插槽** ⟹ 微信里那种「左侧缩进两行」**不是官方 DSH 界面**；但**能力上没缺口**（可续接子会话 + 结算通知回流就是官方推荐形态）。规格新增 **R5.1.1.1** 说明为什么我们不做左侧嵌套 | DONE → 新增护栏：运行时「说明说人话」4 条（三段讲解词必须含固定四段结构；上下文事件卡必须说明用途）+ 静态 1 条（**不许把 markdown 的 `**` 直接写进 HTML 字符串** —— 先剥注释再查，第三次踩同一个坑）→ 静态绿 + 158/158 绿；反向验证：把 `**` 写回事件卡 → 静态 1 红 → 改回即绿。浏览器实测：点「存为不变量」的序号 → 抽屉正文为「一句话 / 为什么需要 / 你什么时候会用它 / 它不做什么 + 会发生什么 / 能不能撤回 / 要不要确认 / 对应规格」，`**` 均渲染为粗体（不原样显示） | `demo/demo.js`、`demo/check-runtime.mjs`、`demo/check-static.mjs`、`docs/01-platform-facts.md`（F36）、`docs/03-ui-spec.md`（R5.1.1.1） |
| M05-42 | 用户四条：① 「存为不变量」应该是**整个上下文的公共选项**，不该只挂在注入内容/技能注入下面；② 「上下文事件」内容**一直不变**、不拟真（「我在移动某一个步骤时它应该有变化」）；③ 「冻结当前位置」能不能点多次、是覆盖还是历史；④ **重新定义子会话**：他以为官方团队「只能一轮」，想要能**多轮互通**；并问能否**新建普通会话**（标题加 `[子会话]`、指定模型与上中下推理档）当子会话。处置：① 固定块面板标题与说明改成**全局（workspace 级）**，并解释「按钮之所以长在条目行上，只是因为要选钉哪一段」；② 事件卡改成**随当前位置变化**（`已发生 N 条 / 还没发生 M 条`，未发生的灰色标「尚未发生」）；③ 界面与讲解词写明它是**历史机制**（每点一次加一条、不覆盖，可删）；④ **调研出新平台事实 F37**：`ctx.subagents.prompt({delivery:queue/steer})` = 人写的话成为子会话**新轮次**、`sendMessage` 双向（父忙→最近步骤边界 / 父闲→起轮次 / **父不在进程→冷恢复**）、`agentOptions` 可指定 provider/model/**reasoningEffort**、`label` 是子会话短标签 ⟹ **「只能一轮」是对 one-shot 的印象，我们选的 continuable 本来就是多轮**；并据此**实现「发消息」**（`cprompt`，走子会话通道、**不依赖团队**）与「派活」（`csend`，团队通道、团队不可用时不出现）分家；用户提的「新建普通会话」方案**不采纳**（无父子邻接 ⟹ 无回程通道、无 fork 种子），记入 `docs/08` §8.5 | DONE → 新增护栏 11 条：固定块面板写明全局 + 解释按钮为何在行上 / 事件随位置变化（早期标「尚未发生」、后一步全程已发生、两者内容不同）/ 冻结连点两次 = 两条记录 / 讲解词写明多轮·双向·可指定模型与推理档 / 发消息先出确认框且写明走官方 `prompt(queue)`、确认后行上出现已排队 / **发消息不依赖团队而派活依赖团队** ⟹ **静态绿 + 171/171 绿**。浏览器实测：事件卡最后一步 `已发生 2 / 还没发生 0`、第一步 `已发生 1 / 还没发生 1`（`#1296` 标「尚未发生」）；冻结连点出现两条带时间的记录；发消息确认框正文`这条消息会成为它的一个新轮次（子会话是多轮的）；它现在忙就排队…`、清单写明`官方 ctx.subagents.prompt({delivery:queue})`，确认后行上出现「已排队 1 条」 | `demo/demo.js`、`demo/check-runtime.mjs`、`docs/01-platform-facts.md`（F37）、`docs/06-orchestration.md`（§A3/A4）、`docs/03-ui-spec.md`（R5.1.4）、`docs/08-open-questions.md`（§8.5） |
| M05-43 | 用户三条：① 「冻结」为什么会出现多条？「同一位置再点一次的意义是什么？我没理解」；而且多条就要能改（「我冻结了 5 条，写错了要一条条改」）；② 「上下文事件」里**会变的和不变的都堆在一起、都是浅灰、不醒目**，要求美化。处置：① 冻结改成**幂等** —— 一条记录的身份 = 「切点 + 当时在效的固定块版本」；同身份再点**不新增**，而是弹「这一刻已经冻过了」并问要不要**更新备注**；记录行给 `改备注` / `删除`；**备注可改，切点/条目数/时刻/固定块版本不可改**（客观读数，改了就不是凭证），删除要确认。② 事件卡重做视觉：**会变的**做成事件行（`✂` + 事件名 + 说明 + 发生在第几轮第几步 + 状态徽章 `已发生`（实心、左侧品牌色竖条）/ `尚未发生`（虚线、降透明）），顶部一行汇总计数；**不变的**说明收成底部一行小字。顺带**去掉一处重复说明**（标题下的旧长说明与底部新小字重复了） | DONE → 先写红护栏：把旧的「每点一次加一条」断言**按新规格重写**成 6 条（同位置再点不新增且弹框说明只保留一条 / 备注能更新且仍只有一条 / **不同位置**才新增 / 改备注不影响另一条 / 可删除 / 事件卡 is-done·is-todo + 计数分开）→ 修后 **静态绿 + 177/177 绿**。浏览器实测：事件卡第 28 轮第 1 步 = `已发生 1 / 还没发生 1`，`剪枝` 行虚线降透明并标 `尚未发生`（截图 `events-card-v2.png`）；冻结同位置连点两次 = 仍一条记录。**修 bug 一枚**：我第一版给「数组里只有一条时删掉身份字段」的兼容代码会把幂等身份删掉，导致幂等失效（护栏抓住） | `demo/demo.js`、`demo/demo.css`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R1.12.1 / R5.1）、`demo/README.md` |
| M05-44 | 用户追问：「如果现在可以修改了，那我冻结多条的意义是什么？我直接改这一条不就可以了吗？冻结多条的作用是什么？」→ 查明**我上一轮只讲了幂等、没讲用途**，而规格 `docs/03` R5.1 第 2 条本来就写着「开子会话 = 选一条冻结记录（或当前）」，**但 demo 把种子硬编码成「现在这一刻」，从没让人选过** —— 所以多条记录在界面上看着毫无用处。补齐：① 快照卡新增 **`从这一刻分叉：`** 选择器（列全部冻结记录、**新的在上**、默认最新）；② 开子会话确认框的第 ① 项改成**所选那条记录的客观字段**（切点/条目数/固定块版本），不再写死「现在」；③ 建出的子会话 `from` = **选中的那条起点**（不是「列表里最新那条」）；④ 还没有冻结记录时**自动补记一条**并标明「开子会话时自动记录」（每次分叉都有凭证，不必先手动冻）；⑤ 规格里把用途写清：**冻结记录 = 一个可选的分叉起点**，三条客观字段就是种子参数，多条 = 多个可选起点 | DONE → 新增运行时护栏 4 条：选择器存在且空态提示「自动补记」 / **不同切点 → 两条记录（两个可选起点）** / 确认框 ① 写的是**所选记录**的客观字段（不是硬编码「现在」）/ 建出的子会话 `from` = 选中的那条起点 → **静态绿 + 181/181 绿**。浏览器实测：起点下拉 = `（最新）snap-…120137 · 第 28 轮末 · 15 条` 与 `snap-…120412 · 第 27 轮末 · 41 条`；**选最早那条** → 确认框 ① = `snap-20260930-120412 · 第 27 轮末 · 41 条 · 固定块版本：无`，子会话行显示 `来自快照 snap-20260930-120412`。**顺带修**：初始冻结记录补上客观字段，选择器里不再显示 `undefined`；我自己的护栏又抓了我一次（`data-explain` 挂在 `<select>` 上 → 必须包 `.pickwrap`，就是当初 #11 的坑） | `demo/demo.js`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R5.1）、`demo/README.md` |
| M05-45 | 用户第二次纠正结构：「冻结当前位置之后是不是下一步就该开子会话？……**我应该在我冻结的那一条后边加上开子会话**，而不是在子会话跟冻结当前位置是同一条」＋「我冻结了多条，我在哪一条上分叉我还是不清楚」。→ 采纳：上一轮我加的「从这一刻分叉」下拉是把同一件事拆到别处再问一遍，反而绕。改为**每条冻结记录行上直接放主按钮 `从这里开子会话`**（其后是 `改备注`/`删除`），并删掉**全局的开子会话按钮**与**下拉**；行上写明 `种子 = 这一条（第 N 轮末 · 条数 · 固定块版本 X）`；没有记录时不出现任何开子会话入口，只提示「先点冻结当前位置」（冻结 → 在那条上开子会话是**两步**，第二步长在第一步的产物上）；冻结按钮旁常驻指引句。实现上 `seedAt(i)` 只接受真实记录，记录被删后再点必须**拒绝建会话**（不许拿最新那条顶上） | DONE → 护栏按新结构重写为 7 条（无记录时没有 spawn 按钮且提示「先冻结」/ 不同切点 = 两条出发记录 / **每条记录行上各有一个按钮**（按钮数 = 记录数）/ 行上写明「种子 = 这一条」 / 点第 i 行 → 确认框 ① = 那一条的客观字段 / 建出的子会话 `from` = 点的那一条 / 起点不存在时**不建会话**）→ **静态绿 + 184/184 绿**。浏览器实测：两条记录各自带 `从这里开子会话` + `种子 = 这一条（第 27 轮末 · 41 条 · 固定块版本 无）`；下拉已不存在（截图 `freeze-rows-spawn.png`）。顺带：删掉已无入口的 `orch.seed` 讲解键，内容并进 `orch.spawn` | `demo/demo.js`、`demo/check-runtime.mjs`、`docs/03-ui-spec.md`（R5.1）、`demo/README.md` |
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
| X 横切 | 8 | **2** | 4 | 1 | 1 |
| M0 文档集 | 20 | **20** | 0 | 0 | 0 |
| M0.5 交互 demo | 45 | **44** | 0 | 0 | 1 |
| M1 骨架与身份 | 14 | 0 | 0 | 13 | 1 |
| M2 编辑面 | 28 | 0 | 0 | 28 | 0 |
| M3 右侧界面 | 22 | 0 | 0 | 21 | 1 |
| M4 轮次联动 | 4 | 0 | 0 | 4 | 0 |
| M4.5 能力验证 | 18 | 0 | 0 | 15 | 3 |
| M5 编排 | 26 | 0 | 0 | 25 | 1 |
| M6 入口与发布 | 10 | 0 | 0 | 10 | 0 |
| M7+ 后续 | 4 | 0 | 0 | 4 | 0 |
| **合计** | **199** | **66** | **4** | **121** | **8** |

> ⚠️ 改完任何一张表，**必须回来同步这一张**（否则这里就成了第二个"真相"）。
> 当前卡点：**M05-15 交互定稿（等你）**；其后 **M1-01 授权包①（等你重启）**。
