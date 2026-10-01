# 11 · 会话交接（把下面那段贴到新会话）

> **用法**：新开一个会话（新会话才有浏览器工具），把下面代码块**整段复制粘贴**进去即可接着干。
> 每次交接时，我（助手）负责更新这个文件，保证它反映**当前真实状态**。
> 交接的真相仍在 [`docs/10-execution-checklist.md`](10-execution-checklist.md)（唯一状态源）与 [`AGENTS.md`](../AGENTS.md)（唯一必读入口）。

```text
接着干 dsh-context-redline 这个插件项目（不是新任务，请先读现状再动手）。

【项目】把参考插件 dsh-context（本机 ~/my_project/_dsh/dsh-context，v0.59.2）的"上下文浏览器"
改造成"可编辑的上下文批改台"：改条目 → 冻结快照 → 用编辑过的上下文开子会话/官方 teammate
→ 压缩 → 主会话据此继续；并与官方 Agent Teams 对接（不自己造协作层）。
仓库：/Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline （分支 main，本地提交未 push）

【先读这三份，再动手】
1) AGENTS.md —— 唯一必读入口：硬约束、平台坑、测试与验证纪律、当前状态
2) docs/10-execution-checklist.md —— 唯一状态源（细粒度任务表：ID/子任务/状态/文件动作（范围冻结））
3) docs/03-ui-spec.md —— 界面规格（R 编号；用户提意见就是按这些编号提）

【现在在哪】
- M0 文档集：已完成（docs/00–docs/11，过了 7 轮外部模型评审）
- M0.5 可交互 demo：已交付（demo/），**浏览器实测已完成**（1440 / 880 / 879 / 390 四种视口，
  原始数据 + 截图在 demo/screenshots/measure-log.md），修掉了实测抓出的"自测面板显示 undefined"，
  冒烟测试 **206/206**（`node demo/check-runtime.mjs`；静态契约另跑 `node demo/check-static.mjs`）。**当前卡在等用户按 R 编号提交互意见 → 改到"交互定稿"**
- M1 及之后：未开工；**插件实现代码仍是零行**（用户没点头前不写）

【硬约束（必须遵守）】
- 只动本仓库；不 push、不开 PR（各自需单独授权）
- 不改 DSH 安装目录、不改 ~/.dsh（**读**它核实平台事实是允许的）
- **dsh web 重启一律由用户本人执行**（这台机的 web 实例承载用户会话）
- 不产生任何 AI 生成内容（进入会话的每个字都必须人写）
- 界面/交互改动：先在 demo/ 里改，用户确认后再搬进插件

【环境现状（2026-09-30 起）】
- 浏览器工具已恢复，**新会话可用，且已实测跑通**：官方 @deepseek-ai/dsh-browser-use +
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp（**现行 0.2.0-rc.2**；历史记录里出现过 rc.1，headless Chromium；
  chromium rev 1243 已在 ~/Library/Caches/ms-playwright 缓存）。
  ⚠️ 两条限制：① 只是本机 headless，不是用户的手机/Chrome；② **无触屏** →
  `(pointer: coarse)` 不命中，44px 触控目标只能把 CSS 规则搬出来模拟验证。
- demo 本地服务：**给用户看一律用局域网地址** http://10.0.0.30:5180/redline-panel.html （本机自测才用 127.0.0.1）
  （bash demo/serve.sh 起 = **守护进程**、bash demo/serve.sh status 看、bash demo/serve.sh stop 停、
  bash demo/serve.sh fg 前台；**电脑重启后要再跑一次**）
  多文件版资源版本 ?v=5（改过 css/js 要升）；
  **单文件版** demo/redline-panel.standalone.html（连服务都不用、可 file:// / AirDrop 到手机）
  页头标签带**打包指纹** `单文件版 <7 位>`：用户报这个指纹就能确认他手上是哪一版。
  服务由 demo/serve.py 提供并统一发 Cache-Control: no-store（刷新即最新版）。
- demo 自检（不需要浏览器）：
  node demo/check-static.mjs   # id/class/讲解词契约 + **单文件版指纹是否最新**
  node demo/check-runtime.mjs  # 最小 DOM 桩真跑渲染与切换（206 项）
node scripts/check-docs.mjs   # 文档一致性（版本/目录/命名/计数/表格/重复标题/A17）
  node demo/build-standalone.mjs  # 改完 css/js 必须重打包单文件版（会打印新指纹）

【第一件事】
浏览器实测已经做过了（不用重做）。先问用户：是按 R 编号提交互意见，还是说"开始"进 M1。
若用户要提意见：用浏览器打开 demo 对着看，按 R 编号改 demo/、跑两个自检、重打包单文件版。

【接下来的两条路，等用户选】
① 用户给 R 编号意见 → 改 demo → 直到用户说"交互定稿" → 结论回写 docs/03
② 用户说"开始" → 走授权包①：把本仓库装配进 web profile → 先跑 dsh --profile web --dump-config
   挡命名空间冲突 → 停下通知用户重启 → 重启后复验 → 再进 M1
```

---

## 交接时要更新的字段（助手收尾时逐项核对）

| 字段 | 现在的值 |
|---|---|
| 仓库路径 | `/Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline` |
| 分支 / 是否 push | `main` / **未 push** |
| 最新提交 | 以 `git log -1` 为准（哈希不写死）；**本轮在改文档**：文档 review 裁定见本文末 + `scripts/check-docs.mjs` |
| 进度 | `docs/10`：**DONE 76 / 共 211**（DOING 4 · TODO 123 · WAIT🙋 8） |
| 当前卡点 | **M05-15 交互定稿（等用户按 R 编号提意见）**；其后 `M1-01 授权包①（等用户重启）` |
| demo 地址 | 给用户：`http://10.0.0.30:5180/redline-panel.html`（多文件版，资源 `?v=5`）· `http://10.0.0.30:5180/redline-panel.standalone.html`（单文件版，页头带打包指纹）；`bash demo/serve.sh` 起（`demo/serve.py`，发 no-store） |
| 实测记录 | [`demo/screenshots/measure-log.md`](../demo/screenshots/measure-log.md)（1440 / 880 / 879 / 390 原始数据 + 20 余张截图） |
| 浏览器工具 | 已恢复且**本会话已实测跑通**（`navigate/resize/screenshot/evaluate/console_messages`）；限制：headless、无触屏（`pointer:coarse` 不命中） |
| 回退（浏览器控制） | 还原 `$DSH_HOME/profiles/web/cordis.patch.yml.before-browser-use-restore-20260930-184704` + `dsh plugin --profile web remove` 两个包 + 用户重启 |

## 为什么不能"自动接着上一段对话"

客户端没有「分叉 / 在新会话继续」这类入口（已查本地化文案，无 `fork`/`分叉`/`在新会话继续`）。
所以跨会话只能靠**这段可复制的交接文本**；它的可靠性来自两点：
① 真相写在仓库文件里（`AGENTS.md` + `docs/10`），不依赖某一轮对话的记忆；
② 交接文本只写"现状 + 第一件事 + 两条路"，细节让新会话自己读文件。

---

## 实施共识（2026-10-01 用户拍板 · 实施前必须遵守）

| 议题 | 结论 |
|---|---|
| **打法** | **先垂直切片跑通再补齐**：M1 骨架 → M2 编辑核心 → M3 一个"能显示上下文"的只读面板（能构建、能装、能看）跑通一次完整链路，再横向补 M4 / M4.5 / M5 / M6 |
| **装 profile + 重启** | **等 M1+M2 构建全绿后**再装进 `web` profile；**重启 `dsh web` 仍由用户本人执行** |
| **依赖版本** | 对齐本机运行时 **0.2.0-rc.2**（签名以安装树 `.d.ts` 为准）；peer 上界按既有策略写 `<0.3.0` 或显式枚举 |
| **Agent Teams 权限** | teammate **只写 Lead 指定的写作用域**；**不 commit / 不装依赖 / 不跑 `dsh` / 不碰 `~/.dsh` 与 DSH 安装目录**；构建、依赖安装、git 提交、最终验收**全归 Lead** |
| **技能注入的动作集合** | **按底层事件类型**给「编辑」（底层 `user/message`/`tool/result` → 可编辑；底层 `assistant/message` → 只批注）＋ `批注` ＋ `钉住这一段`（合 `docs/03` R2.1/R4.6） |

**随之生效的技术约定**（Lead 定，写代码时必须遵守）：

1. **测试目录 = `tests/`（复数）+ `*.spec.ts`**（跟随上游惯例）；vitest 分 lane：`edit` / `channel` / `client`。
2. **lane 边界 = `src/redline/**`（纯逻辑：禁 `node:*`、禁 DOM、禁 React）+ `src/shared/**`**；
   `docs/05` 里旧的 `src/edit/pure/**` 是归档线命名，已废弃。
3. **不设路径别名**：测试用相对 ESM 导入（`../../src/redline/xxx.js`）；`moduleResolution: Bundler` 可解析到 `.ts`。
4. **`tsconfig.json` 的 `include` 必须含 `tests/**`** —— 否则护栏测试不进 `tsc --noEmit`，等于半个护栏。
5. **稳定错误码表放 `src/shared/redline-errors.ts`**（两半共用的对外契约），`src/redline/**` 只 import。
6. **「已遮蔽的 assistant 消息」两个原因同时命中时，assistant 判定优先**：按钮集合同为「只批注」，
   差异只在给用户看的原因与徽章；单测锁定这个优先级。
7. **每完成一条任务：在 `docs/10` 把该条验收标准打勾并附原始输出**；进度随时可用
   `node scripts/progress.mjs` 查看（哪些已完成 / 哪些未完成）。

---

## 文档 Review 裁定（2026-10-01 用户：「按照建议执行」）

> 这 7 条是**唯一口径**；docs/00–docs/11、README、UPSTREAM、AGENTS 全部按它对齐。
> 机器检查：`node scripts/check-docs.mjs`（版本 / 目录 / 命名 / 计数 / 表格 / 重复标题 / A17），**必须退出码 0**。

| # | 议题 | 裁定 |
|---|---|---|
| **D1** | 运行时版本 | **`0.2.0-rc.2`**（实测：安装树 `@deepseek-ai/dsh` 与 profile 内 `browser-use` 两包都是 rc.2）。peer 写 `>=0.2.0-rc.2 <0.3.0`。提到 rc.1 只允许出现在**显式标注「历史」**的行（如当时装了什么的记录） |
| **D2** | 参考插件 | **复制基线 = git tag `v0.59.2`**（写法必须带 `v` 前缀或「基线」字样）；**并存对手 = profile 实装 `0.60.0`**（npm 版本声明不许写 0.59.2）。已实测：0.60.0 仍注册同样的三条 `/api/dsh-context/*` 路由与 `contextTimeline/headers/activity` 投影 key ⟹ F1/F2 冲突结论不变 |

| **D3.1** | `src/host/` 下**只放我们自己的接线文件，且必须带 `redline-` 前缀**（`redline-channel.ts` / `redline-command.ts` / `redline-service.ts`）；其余逻辑（编排、冻结、团队桥、草稿、固定块、快照）一律 `src/redline/**`；**上游文件**（`src/host/index.ts`、`settings.ts`、`src/client/*` 等）只在必须接线处改动 |
| **D3** | 目录定版（**唯一一套**） | 实现 = `src/redline/**`（纯逻辑，禁 `node:*`/DOM/React）+ `src/host/redline-channel.ts`（**唯一**上游接线文件）+ `src/client/**` + `src/shared/**`；测试 = `tests/edit/**`、`tests/channel/**`（`*.spec.ts`）。`src/edit/**`、`src/orchestrate/**`、`src/edit/pure/**`、`tests/redline/**`、`test/**`（单数）**都是归档线旧名**，只允许出现在带「归档/历史/旧」的行 |
| **D4** | 装配时序 | **授权包① 是 M1 的收口动作，不是第一步**：仓库内骨架 + `tsc`/`tsdown`/`vitest` 全绿 → 装配进 web profile → `dsh --profile web --dump-config` 无冲突 → **停下等用户重启** |
| **D5** | 授权粒度 | `docs/06 §4` 的 A1–A10 清单是**界面确认框的内容规格**（用户点确认即授权）；**只有 §9 的 4 个包**需要用户本人动作（①装/重启 ②专用会话破坏性验证 ③端到端验收 ④push）。"不再逐动作确认"与"写会话必须有确认框"**不冲突**：前者说不用找人，后者说界面要拦 |
| **D6** | M2 断言载体 | 「模型看到什么」一律用**纯函数断言**（自写 fold 等价物，edit lane 可跑）；`deriveMessages()` 是 live Session 同步读（AGENTS §2.2 禁新代码调用），**不许进测试计划**（历史记录行除外）；`docs/05 §2` 必须补 **A17 三栏定义**（7 类行 × 按钮集合） |
| **D7** | 派活与命名 | 派活口径：**我们不做自己的派活投递；提供"调用官方派活"的入口，团队不可用时不出现**（Q12=A′）。按钮命名统一 **`钉住这一段`**（＝存为固定块）；`存为不变量` 是旧名，全部改掉 |

**连带要求**（review 里同批要清掉的）：

- `docs/00 §2.3/§4.1/§7`、`docs/09` 里"请确认/待用户确认"必须标为**已拍板**（结论回写）。
- 冻结记录字段不许叫「摘要」（N4：插件不生成摘要）；`digest` 定义成**内容哈希/计数**。
- `docs/06 §2` 的 fork 种子措辞：**由平台 fork provider 自算**（内部用的是已废弃同步读，与我们无关），切点 = 最后一个 `turn/end` **及其之前**；我们只传首条任务。
- `docs/02 §5.2` 写入 op 表**补 `child.interrupt` 与 4 个 team 写 op**（`team.createTask`/`team.updateTask`/`team.sendMessage`/`team.interrupt`），并把计数与实际一致。
- `docs/03` 增：**「帮助」入口 R**、**「不可用态 → 人话原因 → 我该怎么办」汇总表**；`R5.3` 补"压缩只在子会话暴露（我方策略，非平台限制）"；`§7` 门禁与 R2.1/R2.5/R4.6 对齐（**钉住只出现在注入内容与技能注入行**；技能注入的「编辑」按底层事件类型）。
- `README.md`/`README.zh.md`：项数改 **209**（或以 docs/10 为准），并修表格被引用块截断的问题（双语成对）。
- `docs/10`：「文件动作（范围冻结）」列**不许**再出现 `$DSH_HOME/**`（那由 Lead 在授权包内操作，teammate 永不触碰）；`test/**` 单数改 `tests/**`；补 **M6-11 用户帮助**、**M6-12 进度脚本** 两条任务。
