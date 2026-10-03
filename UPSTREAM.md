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
> **⚠️ slot 归属已拍板（用户 2026-10-02）：我们接管 `conversation.view`（选项 A）**。落地方式：
> ① 我们的客户端**注册进同一个宿主 slot** `conversation.view`，但用**我们自己的 slot id**（`redline`，见上表 #3），不占用上游的 `context`；
> ② 同时在**我们的 bundle patch** 里把上游那一行 `disabled: true`（并 `insert` 我们依赖的宿主行 —— 见 `cordis-composition-reference`），
>    否则两个插件都注册同一 slot，**晚注册者会静默顶掉先注册者**（不报错，属于最难查的一类）；
> ③ 代价写在明处：**上游面板的功能更新从此靠我们 cherry-pick**（我们本来就不跟随上游 `main`，见 §1）。

| 4 | locale 命名空间 | `dsh-context` | `dsh-context-redline` | 同一命名空间下文案互相覆盖 |
| 5 | 消息来源 kind | **无**——上游不注册任何 `MessageSourceMap` kind（`git grep MessageSourceMap v0.59.2 -- src/` 零命中） | `dsh-context-redline`（我们自 declare） | `MessageSourceMap` 是 merge-extensible、无 catch-all，各生产者声明自己的 kind |
| 6 | 插件 `name` / bundle 注册 id | `dsh-context` | `dsh-context-redline`（= 包名，客户端 bundle 的注册 id 必须等于包名） | DSH 的 `dsh-client-modules` 按包名校验，不一致会抛 `loaded without registering "<id>"` |
| 7 | 数据目录 | 无（上游只读） | `$DSH_HOME/dsh-context-redline` | 我们自己的草稿/固定块/快照存放处 |
| 8 | 其余命名面（**静默撞车**，最容易漏） | `SETTINGS_NAMESPACE` / `SIDEBAR_CONTEXT_ID` / `SIDEBAR_CONTEXT_KIND` 都是 `dsh-context`；localStorage key `dsh-context:platform-balance` | 一律换成 `dsh-context-redline` 系 | 逐项取值与出处见 [`docs/01` F4](docs/01-platform-facts.md)；机器断言必须用带排除的正则 `dsh-context(?!-redline)` |

### 3.2 上游文件的改动点（预计很小，v2 的经验值可作量级参考）

v2 相对上游 `v0.59.0` 的**全部**改动只有 12 个路径、其中对上游既有文件的改动合计约 240 行：

| 上游文件 | v2 的改动量 | 我们的预计改动 |
|---|---|---|
| `src/client/components/browser.tsx` | +52 / −3 | 挂动作条与内联编辑器；**轮次选择 prop**；遮蔽行的原因提示 |
| `src/client/components/contextView.tsx` | +116 / −0 | 编辑层 hook 接线；轮次 → 浏览器的联动；快照/子会话面板 |
| `src/client/i18n.ts` | +66 / −2 | 新文案（编辑/批注/不变量/快照/子会话）；**补齐上游缺的 key** |
| `src/client/index.ts` | +8 / −2 | 样式 import、slot id、locale ns |
| `src/host/index.ts` | +9 / −1 | 挂我们的通道与编排服务 |
| 其余上游文件 | 未改 | **尽量不改**——改动越少，将来挑上游 UI 改进越省事 |

### 3.3 我们新增的文件（不是上游的）

计划（M1 起逐步落地，目录按 **D3 定版**）：`src/redline/**`（纯逻辑：编辑面与编排面的纯函数部分）、`src/host/redline-channel.ts`（**唯一**上游接线文件）、`src/shared/redline-route.ts`（两半共用的路由与请求形状）；测试 `tests/edit/**`、`tests/channel/**`（`*.spec.ts`）。

> ⚠️ **归档线旧名**（`src/edit/**`、`src/edit/pure/**`、`src/orchestrate/**`、`tests/redline/**`、`test/**` 单数）**不再使用**；它们只允许出现在带「归档 / 历史 / 旧」字样的说明里（`node scripts/check-docs.mjs` 会判红）。

### 3.4 明确**不**复用上游/归档代码的部分

- 早期那次尝试 里**不应带走**的东西：`simulator.editMessage`（无 importer 的重复编辑器）、`message-types.ts`、forge 前缀路由（这些都属于**早期那次尝试**，本仓库**不复用**；教训见 `docs/01`）。
- 上游的告警/遥测类入口：如"检查新版本""社交预览"等与本地编辑无关的部分，M1 复制时按需裁掉。

## 4. 骨架配置文件来源（**M1 必须补全此表**）

M0 阶段工作区里已有的骨架文件，以及它们该怎么处理：

| 文件 | 现状 | M1 要做 |
|---|---|---|
| `.gitignore` | 我们自己维护（含 `.dsh-code-index/`、`coverage/` 等） | 保留 |
| `.npmrc` | 沿用归档线的 `auto-install-peers=false` | 保留并写进 M1 的配置来源表 |
| `.oxlintrc.json` | **来自早期那次尝试**（12KB，其规则按当时的目录结构写） | 按新目录裁剪；确认与本仓库实际文件集合匹配后再启用 |
| `.github/workflows/**` | ⚠️ **已删除**（原本是上游/归档线带来的 `ci.yml` + `publish.yml`，前者会跑当前不存在的 `pnpm run verify`，后者直通 npm 发布流程） | **自建**：按 `docs/04` M1 的 DoD 第 3 条写，**不继承**上游的 workflow |
| `package.json` / `tsconfig.json` / `tsdown.config.ts` / `vitest.config.ts` | M0 尚无（M1 才建） | 按 M1 的"配置来源表"逐项记录：来自哪个 tag 的哪个路径、保留什么、改成什么 redline 值、怎么验证 |

> **为什么删掉继承来的 CI**：CI 是要长期信任的门禁。留一个"从上游抄来、当前必然失败或会触发发布"的 workflow，
> 比没有 CI 更坏——它会让"红"变成常态，也会让发布变成一次误点。

## 5. 校验方式

```bash
# 上游原文随时可取（本机 clone）
git -C <upstream-clone> show v0.59.2:src/client/components/browser.tsx

# 我们的改动面（M1 之后）
diff -rq <(git -C <upstream-clone> archive v0.59.2 | tar -xO 2>/dev/null) src/   # 逐文件人工核对
```

### 3.2 复用范围：**趋势块直接沿用上游组件，不重写**（用户 2026-10-02 定）

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
