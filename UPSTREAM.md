# 上游来源与我们的修改（UPSTREAM）

> 这份文件是许可合规的**唯一权威记录**：上游是谁、取的哪个版本、我们改了哪些文件。
> 评审时如果发现代码里有"看起来像上游"的东西，请以此文件核对。

## 1. 上游

| 项 | 值 |
|---|---|
| 仓库 | `https://github.com/bowenliang123/dsh-context` |
| 许可 | **Apache-2.0**（`LICENSE-Apache-2.0` 原样保留） |
| 我们复制的版本 | **tag `v0.59.2`**，commit `fc44fff9548d404da3c4935525d01b5e4fb62517` |
| 选择它的理由 | 该版本**正在本机 DSH `0.2.0-rc.1` 上实际运行**（用户侧的参考插件就是它），是本机唯一"在这个运行时上被真实证明可用"的版本。对比：早期的 v2 分支基于 `v0.59.0`（`addccdd4aa95b4e01b054d1d7f7e6ff9b468d2d4`），而它的验证运行时是 `0.1.7-rc.2` |
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

复制上游源码会和**已安装的 `dsh-context@0.59.2` 直接冲突**，两处冲突都是"抛错"级的：

| # | 冲突面 | 上游值 | 我们改成 | 依据 |
|---|---|---|---|---|
| 1 | HTTP 路由 | `/api/dsh-context/detail`、`/api/dsh-context/balance`、`/api/dsh-context/backfill` | `/api/dsh-context-redline/detail` 等（全部挂在我们自己的前缀下） | `connection.fetch.register` 对**同路径重复注册直接抛错**：`exact Fetch route "…" is already registered`（`dsh-client-connection/lib/index.js:633`） |
| 2 | 投影 key | `contextTimeline`、`contextHeaders`、`contextActivity` | `redlineTimeline`、`redlineHeaders`、`redlineActivity` | `ctx.sessionProjections.register` 对同 key：stateVersion 相同则**静默共用先注册者的定义**（我们的 fold 会被顶掉），不同则**抛错**（`dsh-session-projection/lib/index.js:85-93`） |
| 3 | 客户端 slot id | `conversation.view` 的 `context` | `redline` | 同 slot id 并存会互相覆盖（v2 已实测踩过） |
| 4 | locale 命名空间 | `dsh-context` | `dsh-context-redline` | 同一命名空间下文案互相覆盖 |
| 5 | 消息来源 kind | 上游自己的 kind | `dsh-context-redline` | `MessageSourceMap` 是 merge-extensible、无 catch-all，各生产者声明自己的 kind |
| 6 | 插件 `name` / bundle 注册 id | `dsh-context` | `dsh-context-redline`（= 包名，客户端 bundle 的注册 id 必须等于包名） | DSH 的 `dsh-client-modules` 按包名校验，不一致会抛 `loaded without registering "<id>"` |
| 7 | 数据目录 | 无（上游只读） | `$DSH_HOME/dsh-context-redline` | 我们自己的草稿/固定块/快照存放处 |

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

计划（M1 起逐步落地）：`src/edit/**`（编辑面）、`src/orchestrate/**`（编排面）、`src/shared/redline-route.ts`（两半共用的路由与请求形状）、`src/host/redline-channel.ts`、`tests/redline/**`。

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
