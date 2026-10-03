# 上游来源与我们的修改（UPSTREAM）

> 这份文件是许可合规的**唯一权威记录**：上游是谁、取的哪个版本、我们改了哪些文件。
> 评审时如果发现代码里有"看起来像上游"的东西，请以此文件核对。

## 1. 上游

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/bowenliang123/dsh-context` |
| 许可 | **Apache-2.0**（`LICENSE-Apache-2.0` 原样保留） |
| 我们复制的版本 | **tag `v0.59.2`**，commit `fc44fff9548d404da3c4935525d01b5e4fb62517` |
| 选择它的理由 | 它就是我们的**复制基线**（`git tag v0.59.2`）。本机 profile 里**实装的是 `dsh-context@0.60.0`**（同源的后继版本，见 D2）；选 `v0.59.2` 是因为它在本机运行时 **DSH `0.2.0-rc.2`**（2026-10-01 实测）上被真实跑过，且基线一旦选定就不再追上游。对比：早期的 v2 分支基于 `v0.59.0`（`addccdd4aa95b4e01b054d1d7f7e6ff9b468d2d4`），而它的验证运行时是 `0.1.7-rc.2`（**历史**） |
| 本机 clone（只读参考） | `<upstream-clone>`（带完整 history 与 tag，`git show v0.59.2:<path>` 即可取原文） |
| 上游**未发布**的更新 | 该 clone 的 `main` HEAD = `67787685fefc70d978d736e95680c7055ea9ff9b`（2026-09-29），**在 v0.59.2 之后**；我们**不**跟随，按需 cherry-pick |
| npm 包内容 | 只有编译产物（`files` = `lib/*` + `locale/*.json` + `icon.svg` + `cordis.patch.yml` + README + LICENSE），**没有源码**——所以"改"只能从 git 源码来 |

## 2. 许可要求与我们的落实

| 要求 | 落实位置 |
|---|---|
| 保留版权与许可声明 | `LICENSE-Apache-2.0` 原样复制；`NOTICE` 声明来源；`package.json` 的 `description` 与 `license` 字段 |
| 标注被修改的文件 | 本文 §3 的清单；被改动的上游文件头部保留原有注释，我们的改动另有说明 |
| 不暗示背书 | `README` 中明确本插件是独立 fork，与上游作者无隶属关系 |

## 3. 我们对上游源码的改动（清单式，M1 完成后逐个回填 commit）

> 到达 M1 之前，本表是**计划**；M1 落地后必须逐条改写为"实际改了什么 + commit"。

### 3.1 命名空间化（**必须**，理由是硬约束而非偏好）

复制上游源码会和 **profile 里实装的 `dsh-context@0.60.0`** 直接冲突（我们的**复制基线 = git tag `v0.59.2`**，两者同源；0.60.0 实测仍注册同样的三条路由与三个投影 key，所以下面的改动面一条都不少）。
其中 **1/2/3/6** 撞车会**抛错**，**4/5/7/8** 多半是**静默**的（偏好被共用、slot 被顶掉、localStorage 互相覆盖）：

| # | 冲突面 | 上游值 | 我们改成 | 依据 |
|---|---|---|---|---|
| 1 | HTTP 路由 | `/api/dsh-context/detail`、`/api/dsh-context/balance`、`/api/dsh-context/backfill` | `/api/dsh-context-redline/detail` 等（全部挂在我们自己的前缀下） | `connection.fetch.register` 对**同路径重复注册直接抛错**：`exact Fetch route "…" is already registered`（`dsh-client-connection/lib/index.js:633`） |
| 2 | 投影 key | `contextTimeline`、`contextHeaders`、`contextActivity` | `redlineTimeline`、`redlineHeaders`、`redlineActivity` | `ctx.sessionProjections.register` 对同 key：stateVersion 相同则**静默共用先注册者的定义**（我们的 fold 会被顶掉），不同则**抛错**（`dsh-session-projection/lib/index.js:84-91`） |
| 3 | 客户端 slot id | `conversation.view` 的 `context`；另有 `context-jump` / `context-modal` / `context-overview` | `redline` / `redline-*`（逐个改） | 同 slot id 并存会互相覆盖；**键控 slot**（`key: NS` 的 `settings.plugin.item` / `plugins.bundle.config` / `sidebar.right.pane.tab`）按 key 分派，也要一起换 |
> **⚠️ 与上游面板的关系（用户 2026-10-02 澄清）**：**不是"接管"上游面板** —— 我们的产品叫 **「上下文批改」**（包名 `dsh-context-redline`），
> **在我们自己的 demo 里重新写出来**；上游 `dsh-context` **只当参考**（它的趋势图那块代码可以复用，见 §3.2，但仍按 §3.1 改名）。
>
> **技术上的一条硬约束**（与"接管"无关，纯粹是机制）：两个插件若要出现在**同一个宿主 slot**，必须各用**自己的 slot id**
> （我们 `redline`，上游 `context`）；否则**晚注册者会静默顶掉先注册者**（不报错，属于最难查的一类）。
> 是否同时装两个、界面上是否只显示我们这一个，属于**装配选择**（`cordis.patch.yml` 的 `disabled` / `insert`，见 `cordis-composition-reference`），
> 不是我们"拿走"上游的 slot。

| 4 | locale 命名空间 | `dsh-context` | `dsh-context-redline` | 同一命名空间下文案互相覆盖 |
| 5 | 消息来源 kind | **无**——上游不注册任何 `MessageSourceMap` kind（`git grep MessageSourceMap v0.59.2 -- src/` 零命中） | `dsh-context-redline`（我们自 declare） | `MessageSourceMap` 是 merge-extensible、无 catch-all，各生产者声明自己的 kind |
| 6 | 插件 `name` / bundle 注册 id | `dsh-context` | `dsh-context-redline`（= 包名，客户端 bundle 的注册 id 必须等于包名） | DSH 的 `dsh-client-modules` 按包名校验，不一致会抛 `loaded without registering "<id>"` |
| 7 | 数据目录 | 无（上游只读） | `$DSH_HOME/dsh-context-redline` | 我们自己的草稿/固定块/快照存放处 |
| 8 | 其余命名面（**静默撞车**，最容易漏） | `SETTINGS_NAMESPACE` / `SIDEBAR_CONTEXT_ID` / `SIDEBAR_CONTEXT_KIND` 都是 `dsh-context`；localStorage key `dsh-context:platform-balance` | 一律换成 `dsh-context-redline` 系 | 逐项取值与出处见 [`docs/01` F4](docs/01-platform-facts.md)；机器断言必须用带排除的正则 `dsh-context(?!-redline)` |
| 9 | **CSS 类名前缀**（**静默撞车**，M1 实测新增） | 整套 chrome 用 `lc-*`（468 个不同类名；实装 0.60.0 的 `lib/client.js` 里 572 处） | 一律换成 `redline-*`（类名 + CSS 变量 `--redline-i` + Tailwind 动画键 `--animate-redline-*`/`@keyframes redline-*` + `data-redline-*`） | 插件的样式是**不分层地注进同一个 document**（`document.head.appendChild(<style>)`），同特异性下后注入者顶掉先注入者、不报错。实测与理由见 [`docs/01` F40](docs/01-platform-facts.md) |
| 10 | **客户端斜杠命令名** | `/context`（`src/client/command.ts` 的 `COMMAND`） | `/redline` | 斜杠命令名是全局的；与上游面板并存时不能两边都占 `/context`。与 `docs/02` §5.3 的 `/redline` 口径一致 |

### 3.2 上游文件的改动点（**M1 实际改了什么**，2026-10-04）

> 下表是 §3.1 那 10 项落地的**实际**改动面与读数（`node scripts/namespace-contract.mjs` 逐面把关）。
> 计数口径：`src` + `tests` + `locale` 全量文本替换，逐条复核过"注释里的出处说明不计入违规"。

| 上游文件 / 目录 | 实际改动 | 读数（M1 执行时） |
|---|---|---|
| `src/host/{timeline,headers,activity}.ts` | 投影 key `context*` → `redline*`（key 字面量、schema 标识符、`SessionProjectionStateMap` 键、`fallback.ts` 的 `PROBE_KEYS` 一起改） | 三个 key：`redlineTimeline` / `redlineHeaders` / `redlineActivity` |
| `src/host/{detail,balance,backfill}.ts` | 路由常量 `/api/dsh-context/*` → `/api/dsh-context-redline/*`（含注释里的出处） | 3 处 `/api` 字面量全部在我们的前缀下 |
| `src/host/index.ts` | **+1 行接线**：`watchRedlineChannel(ctx)`（挂在 baseline gate **之前**，两侧都生效） | `apply` 里第一句 |
| `src/host/settings.ts` | 仅加一段**实测注释**指向 `docs/01` F39（`register` 面在 0.2.0-rc.2 已不存在，本模块恒为 inert）；逻辑未改 | 见 `docs/10` M3-23 |
| `src/host/version.ts`、`src/host/backfill.ts`、`src/host/logShapes.ts`、`src/host/compat.ts`、`src/host/attribution.ts`、`src/shared/*.ts` | 包名 / 注释 / 模块标识符 `dsh-context` → `dsh-context-redline`（含 `SETTINGS_NAMESPACE`、错误码前缀、logger 标签） | `/dsh-context(?!-redline)/` 零命中 |
| `src/shared/version.ts` | `BASELINE_DSH_VERSION` `0.1.5-rc.1` → **`0.2.0-rc.2`**（= 我们的 `engines.dsh` 下界，`docs/11` D1） | 闸的基线与 `engines.dsh` 一致 |
| `src/client/index.ts` | slot id `context`/`context-jump`/`context-modal`/`context-overview` → `redline*`；locale `NS`、`settings.plugin.item` / `plugins.bundle.config` 的 `key` 全换 | 5 个 id，全部 `redline*` |
| `src/client/sidebar.ts` | `SIDEBAR_CONTEXT_ID` / `SIDEBAR_CONTEXT_KIND` → 包名 | `dsh-context-redline` |
| `src/client/command.ts` | `COMMAND` `/context` → `/redline` | 与 `docs/02` §5.3 一致 |
| `src/client/**`（16 张 CSS + 36 个组件 + 工具模块） | **`lc-` → `redline-` 全量改名**（类名、`--lc-i`、`--animate-lc-*`、`@keyframes lc-*`、`data-lc-current`） | `src`+`tests` 共 **3043** 处，`lc-[a-z]` 零命中（面 8 同时扫 `.tsx` 与 `.css`） |
| `src/client/components/{stackedBar,images}.tsx` | 改名后有 3 行注释超过 140 列 → 重新折行（`@stylistic/max-len`） | `oxlint` 0 error |
| `locale/{zh,en}.json` | 展示名与描述里的包名、`/context` → `/redline` | 2 个字典 |
| `cordis.patch.yml` | `id`/`name` → `dsh-context-redline`（带一段说明为什么必须等于包名） | 面 1 |
| `tests/host/{index,version}.spec.ts`、`tests/client/{command,index}.spec.ts`、版本探针夹具 | 断言里的旧命名空间值 / 旧命令名 / 旧基线版本**跟着改**（改的断言，不是放宽断言） | `host` lane 全绿 |
| `tests/client/setup.ts` | 加 `ResizeObserver` 桩（jsdom 没有，harness primitives 的 Tooltip 需要） | 见 `docs/01` F41 |
| `tests/{compat,baselines.ts}`、`tests/host/settings.spec.ts` | **删除**：前两者是"对多个上游基线跑矩阵"的 lane（我们只支持一个运行时，且它需要网络与 `DSH_REPO`）；后者测的是 0.2.0-rc.2 已移除的 `SettingsProvider` / `register(ns, schema)` | 见 §3.4 与 `docs/01` F39 |

**没改的**（刻意保持原样，改动越少越好）：`src/host/fold.ts`（1533 行，柱子的数字全来自它）、
`src/client/components/trendChart.tsx` / `stackedBar.tsx` / `requestDetail.tsx` / `styles/trendChart.css` 的**逻辑与视觉**、
`src/client/{categories,format,viewkit,brief,callSummary,overscroll}.ts`、`src/shared/types.ts` 的结构（只改 key 名）。

### 3.3 我们新增的文件（不是上游的）

| 文件 | 作用 |
|---|---|
| `src/shared/redline-route.ts` | 两半共用的路由常量（4 条，含 `/api` 前缀）、RPC 信封、`RedlineCall` 解析。**唯一**允许拼路由的地方（防 404，`docs/01` F1） |
| `src/shared/redline-errors.ts` | 稳定错误码表（`redline/*`）+ wire 文案 + `isRedlineErrorCode`。**它是客户端的查找键**（`docs/03` R4.7），改名 = 契约变更 |
| `src/shared/redline-paths.ts` | 数据目录常量 `dsh-context-redline`（`docs/02` §6）。纯逻辑，不 import `node:*` |
| `src/host/redline-channel.ts` | **我们唯一的上游接线文件**（`docs/11` D3.1）：注册 `/api/dsh-context-redline/redline`、按 `op` 分发、回统一信封。**M1 的 `OPS` 表是空的**（任何 op 回 `redline/unknown-op`），M2 往里填 |
| `tests/edit/namespace.spec.ts` | `edit` lane 起步用例：路由/错误码/数据目录/信封的契约断言 |
| `tests/channel/redline-route.spec.ts` | `channel` lane 起步用例：**真 cordis 上 boot 主机入口**、抓真实注册的路由、断言命名空间 + 信封行为 |
| `scripts/namespace-contract.mjs` | M1 的机器门禁（**11 个面** / 24 项），见 `docs/04` M1 DoD；逐面反向验证过 |
| `.github/workflows/ci.yml` | 自建 CI（不继承上游的 `ci.yml`/`publish.yml`；见 §4） |

### 3.4 明确**不**复用上游/归档代码的部分

- 早期那次尝试 里**不应带走**的东西：`simulator.editMessage`（无 importer 的重复编辑器）、`message-types.ts`、forge 前缀路由（这些都属于**早期那次尝试**，本仓库**不复用**；教训见 `docs/01`）。
- 上游的告警/遥测类入口：如"检查新版本""社交预览"等与本地编辑无关的部分，M1 复制时按需裁掉（`scripts/` 下上游的 `publish.sh`/`register.sh`/`web.sh`/`watch.sh`/`diff-fold.ts` **未复制**）。
- `tests/compat/**` + `tests/baselines.ts`：上游的**多基线兼容矩阵** lane —— 它要 `DSH_REPO` 与网络下载各 tag 的 vendored cordis，而我们**只支持一个运行时**（`>=0.2.0-rc.2 <0.3.0`），留着它只会引入"红是常态"。删除时的连带清理：`tests/{client,host}/compat/**`。
- `tests/host/settings.spec.ts`：测的是 0.2.0-rc.2 **已移除**的 `SettingsProvider` 基类与 `register(ns, schema)`（`docs/01` F39）。**不是**"为了让测试变绿而放宽断言"——被测 API 在这个运行时上不存在，且该 lane 本来就不是门禁。
- `src/host/settings.ts` 的注册效果：在 0.2.0-rc.2 上**inert**（见 `docs/01` F39）；是否保留整套偏好面由 `docs/10` **M3-23** 决定。

## 4. 骨架配置文件来源（M1 已落地 · 每个文件从哪来、改了什么、怎么验）

> M1-09 的产物。**"来自 tag `v0.59.2`"= 逐字复制后按本表改动**；"自建"= 本仓库新写。
> 所有改动都有一句**为什么**，以及一条**能跑的验证**。

| 文件 | 来源 | 保留什么 | 改成什么（redline 值） | 怎么验 |
|---|---|---|---|---|
| `package.json` | 来自 tag `v0.59.2`（同名文件） | `type`/`main`/`types`/`exports`/`files`/`engines.node`（`^22.19.0 \|\| >=24.0.0`）的形状；`dsh.bundle.patch` + `dsh.client.{platform,inject}` 的结构 | `name`/`version`(0.1.0)/`description`/`license`(MIT，见 README)/`icon`/`scripts`/`keywords`；`engines.dsh = >=0.2.0-rc.2 <0.3.0`（顶层，按 manifest 类型定义）；peer 上界 `<0.3.0`；`devDependencies` 里 `@deepseek-ai/*` 全部**钉到 `0.2.0-rc.2`**；**删掉**上游的 `dsh.compatibility.dshReleases`（0.1.x 时代的兼容矩阵，已由 `engines.dsh` 取代）；**删掉** `prepare: husky && tsdown`（不许 `pnpm install` 顺手构建） | `node scripts/namespace-contract.mjs` 面 1 + 面 11；`pnpm install` 后 `tsc`/`tsdown`/`vitest` 全绿 |
| `tsconfig.json` | 来自 tag `v0.59.2` | `target/module/moduleResolution/lib/jsx/strict/noEmit/skipLibCheck/isolatedModules/verbatimModuleSyntax/forceConsistentCasing` | `lib` 加 `DOM.Iterable`；`types` 从 `[]` 改为 `["node"]`；`include` **加 `tests/**` 与两个 config 文件**（`docs/11` 实施共识 §4：护栏测试必须进 `tsc --noEmit`，否则等于半个护栏）；**`noUncheckedIndexedAccess` 不加**（上游没开；加了会与上游代码的既有写法冲突，实测一次报 1262 个错） | `./node_modules/.bin/tsc --noEmit` → 退出码 0 |
| `tsconfig.tests.json` | 上游有 | — | **不再需要**：单一 `tsconfig.json` 已含 `tests/**` 且带 node 类型（合并的理由见上一行） | 同上（少一条命令，覆盖不变） |
| `tsdown.config.ts` | 来自 tag `v0.59.2`，**逐字复制** | 全部：平台外置模块表、bundle purity 门、CSS 三通道（module/inline/global，Tailwind 编译 + lightningcss）、`__DSH_CTX_*` 的 define、客户端 banner/footer | **零改动**（banner 的注册 id 来自 `pkg.name`，改包名即自动对齐——`docs/01` F3 的护栏） | `pnpm run build` → `lib/client.js` banner = `load({ id: "dsh-context-redline"`（面 1 断言构建产物）+ `lib/index.js` 导出 `{Config, apply, inject, name}` |
| `vitest.config.ts` | 来自 tag `v0.59.2` | reporters、jsdom + primitives 内联、`tests/client/setup.ts` | lane 重排为 **`edit` / `channel`（自有，门禁）+ `host` / `client`（上游，非门禁）**；**删掉 `compat` lane**（见 §3.4）；coverage 保留但**不设 thresholds**（上游的 perFile 100% 是针对它自己的全量覆盖，我们 M1 只有起步用例，设了就是逼人写假测试） | `vitest run --project edit --project channel` → 15/15；`vitest run` → 1689/1689 |
| `.oxlintrc.json` | 仓库自带（与 tag `v0.59.2` 的**逐字节相同**，实测 `diff` 为空） | 全部规则与 overrides | **零改动**：实测它已与本仓库文件集合匹配（`oxlint` 0 error / 0 warning，201 个文件） | `./node_modules/.bin/oxlint` → 退出码 0 |
| `.npmrc` | 仓库自带（归档线遗产） | `auto-install-peers=false` | 保留。**代价要记住**：平台包不会自动补，缺一个就整片 lane 加载失败（`docs/01` F41 列了必须显式声明的清单） | 依赖清单见 `package.json` 的 `devDependencies` |
| `.gitignore` | 仓库自带 | `node_modules/`、`lib/`、`coverage/`、`.dsh-code-index/`、`.playwright-mcp/` 等 | 保留（`lib/` 必须忽略：它是构建产物） | `git status --short` 里不出现 `lib/` |
| `.github/workflows/ci.yml` | **自建** | — | `push` + `pull_request`；Node `24.15.0`（= `engines.node` 的下界实测环境）+ pnpm `10.33.1`；跑 `tsc` / `namespace-contract` / `tsdown` / `vitest --project edit --project channel`。**明确不把 `host`/`client` 当 required**（环境依赖，`docs/05` §1）。安装步骤里写明了**为什么不做**上游的"删链接 → install → 建链接"三段式（`docs/01` F42） | YAML 结构由 `docs/04` M1 DoD 3 逐条对照；本机等价序列已全绿（见 `docs/10` M1-13 证据） |
| `scripts/namespace-contract.mjs` | **自建**（M1-11） | — | 11 个面 / 24 项断言；扫代码前**先剥注释**（注释里**应该**提到上游旧名，那是出处）；"上游旧值零命中"一律用带排除的正则 `dsh-context(?!-redline)`（`docs/01` F4） | 逐面反向验证（10 个 mutating 用例 + 1 个沙箱 symlink 用例，全部变红后恢复即绿），原始输出见 `docs/10` M1-12 |
| `scripts/{watch,web,register,publish}.sh`、`scripts/diff-fold.ts` | 上游有 | — | **不复制**：`publish.sh` 直通 npm 发布、其余是上游的 dev 便利脚本（`docs/00` N8 / `AGENTS.md` §1 的"发布必须单独授权"） | 目录里只有 `check-docs.mjs` + `namespace-contract.mjs` |

**两处刻意偏离上游的配置**（都要能说出为什么）：

1. **不建 `node_modules/@deepseek-ai` 符号链接**（上游那套 `link-dsh-runtime.mjs` 流程）→ 见 `docs/01` F42：
   链 profile 层在本机已解析不到内部包，而"链 + `pnpm install`"正是那个**真实发生过**的写穿故障。
   registry 直装让这个风险结构性消失，并加了面 10 的断言防止有人"照文档"把它加回来。
2. **单一 `tsconfig.json`（含 `tests/**`）**取代上游的 `tsconfig.json` + `tsconfig.tests.json` 两分法 →
   见 `docs/11` 实施共识 §4（护栏测试必须被 `tsc --noEmit` 覆盖）。

> **为什么删掉继承来的 CI**：CI 是要长期信任的门禁。留一个"从上游抄来、当前必然失败或会触发发布"的 workflow，
> 比没有 CI 更坏——它会让"红"变成常态，也会让发布变成一次误点。

### 3.5 复用范围：**趋势块直接沿用上游组件，不重写**（用户 2026-10-02 定）

| 层 | 上游文件 | 体量（`wc -l`，v0.59.2） | 我们的做法 |
|---|---|---|---|
| ① 趋势组件本体 | `src/client/components/trendChart.tsx`、`stackedBar.tsx`、`requestDetail.tsx`、`src/client/styles/trendChart.css` | 717 + 248 + 309 + 128 = **1402** | **原样保留**（只做命名空间相关的改动），视觉与交互不重写 |
| ② 直接依赖 | `categories.ts`、`format.ts`、`viewkit.ts`、`brief.ts`、`callSummary.ts`、`overscroll.ts`、`shared/types.ts` | ≈ 700+ | 原样保留 |
| ③ 宿主半边（柱子的数字来源） | `src/host/*.ts`（`fold.ts` 1533、`timeline.ts` 425、`backfill.ts` 340、`balance.ts` 276、`attribution.ts` 263、`activity.ts` 263…） | **4673** | 原样保留（同时按本文 §3.1 改名） |

**结论**：这三层一起才算"复用趋势块"；只搬 ① 会缺 `RequestRecord`（turn/step/每类 token/时间/事件标记），组件渲染不出来。
参考体量：上游客户端共 **69 个文件 / 13927 行**。

**这意味着什么**（写清楚，免得后面有人以为要重写）：
- `demo/` 是**交互门禁用的静态原型**（纯 HTML/JS），**不是**最终客户端；它只负责把"契约与视觉"和上游对齐（已对齐 3 处：刻度带对齐公式、选中态状态行、点轮号条行为，见 `docs/03` R1.1.1 / R1.1.2）。
- 最终客户端在 M1 从基线 `v0.59.2` 起来，**趋势块不重写**；我们要写的是**编辑能力**（M2/M3）。

## 5. 校验方式

```bash
# 上游原文随时可取（本机 clone）
git -C <upstream-clone> show v0.59.2:src/client/components/browser.tsx

# 我们的改动面（M1 之后）
diff -rq <(git -C <upstream-clone> archive v0.59.2 | tar -xO 2>/dev/null) src/   # 逐文件人工核对
```
