# 07 · 归档 v2 的审计（做了什么、哪些能用、哪些不能用）

> 用户决定：**保留空目录、另起一个全新插件**。本文件保证"另起"不等于"丢掉信息"——
> 归档线的全部成果都可取回，且它的**真实缺陷**必须带进新项目，不能重犯。

---

## 1. 归档在哪（可随时取回）

| 项 | 值 |
|---|---|
| 目录 | 同一个目录 `/Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline` |
| 分支 | `v2-upstream-base` —— **它是归档 tip，不是上游基线**（保持不动、只读参考） |
| 标签 | **`v2-archive-20260928`** → `ec57ea8c5249c129210649ace4a9fe29201e701c`（2026-09-28 21:12，与 `v2-upstream-base` 的 tip 同一个 commit） |
| 提交数 | 121（`git rev-list --count v2-archive-20260928`） |
| 基线（上游） | 上游 `dsh-context` **v0.59.0** = `addccdd4aa95b4e01b054d1d7f7e6ff9b468d2d4`。⚠️ **这个对象不在本仓库**——本仓库的 remote 指向另一条上游（`anweat/dsh-context-console`），v0.59.x 的 tag 只存在于参考 clone 里。所以本仓库的审计**必须写明来源**，见 §1.1 |
| 验证运行时 | DSH **0.1.7-rc.2**（**不是**现在的 0.2.0-rc.1） |
| 同目录的另一条线 | 分支 `main` = 更早的 v1（`dsh-context-console` fork，MIT/anweat），**其 UI 已整体作废** |

取文件（归档线在本仓库内，可直接解析）：
```bash
git -C /Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline \
    show v2-archive-20260928:src/redline/write.ts
```

### 1.1 复核命令与来源（审计链）

上游基线**不在本仓库**，因此每条"相对上游改了什么"的核对都必须指定来源：

```bash
# 归档线（本仓库内，可解析）
git -C /Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline rev-parse v2-archive-20260928   # -> ec57ea8…
git -C /Volumes/SSD/Home/lionm4/my_project/_dsh/idoall/dsh-context-redline rev-list --count v2-archive-20260928  # -> 121

# 上游基线（只在参考 clone 里，可解析）
REF=/Volumes/SSD/Home/lionm4/my_project/_dsh/dsh-context
git -C "$REF" rev-parse v0.59.0    # -> addccdd4aa95b4e01b054d1d7f7e6ff9b468d2d4   （归档 v2 的基线）
git -C "$REF" rev-parse v0.59.2    # -> fc44fff9548d404da3c4935525d01b5e4fb62517   （新线的基线，见 UPSTREAM.md）
git -C "$REF" rev-parse HEAD       # -> 67787685fefc70d978d736e95680c7055ea9ff9b   （上游未发布 main，我们不跟随）

# 若本机没有该 clone：任取一份带有该 tag 的 dsh-context clone，或按 NOTICE 里的仓库地址重新克隆后再核对
```

> 新线同样遵守这条规则：`UPSTREAM.md` 写的 `v0.59.2 = fc44fff…` 也**不在本仓库**，只在参考 clone 里可解析。
> 将来若要把上游源码复制进本仓库（M1），**必须**在 `UPSTREAM.md` 里补上"复制自哪个 clone 的哪个 ref、复制日期、逐文件哈希或 commit"。

## 2. 归档 v2 相对上游改了哪些（我们的"增量面"）

对上游既有文件的改动只有 5 个文件、合计约 **240 行**：

| 文件 | 改动 |
|---|---|
| `src/client/components/browser.tsx` | +52 / −3（动作条 + 内联编辑器的挂载点） |
| `src/client/components/contextView.tsx` | +116 / −0（编辑 hook 接线） |
| `src/client/i18n.ts` | +66 / −2（红笔文案） |
| `src/client/index.ts` | +8 / −2（样式、slot id、locale ns） |
| `src/host/index.ts` | +9 / −1（挂编辑通道） |

新增（我们自己的）：`src/redline/`（15 文件）、`src/host/redline-channel.ts`、`src/shared/redline-route.ts`、`src/client/redline-client.ts`、`src/client/components/redlineRowActions.tsx`、`src/client/components/redlineEditor.tsx`、`src/client/styles/redline.css`。

测试：`tests/redline/` 7 个 spec（`channel` / `eligibility` / `invariants-scope` / `metrics-input` / `orchestration` / `route-pairing` / `rows`）。

---

## 3. **缺陷账本**（每一条都必须在 M1–M3 里被封死）

| # | 缺陷 | 严重度 | 证据 | 新项目怎么防 |
|---|---|---|---|---|
| **D1** | **编辑器用 80 字预览当正文**：行上的 `text` 是宿主 `firstText()` = `replace(/\s+/g,' ').trim().slice(0,80)`；编辑器prefill 它、提交也发它 → **点一次「编辑+应用」就把整条消息截成 80 字并压掉换行** | 🔴 **数据破坏** | 归档 `src/host/pricing.ts` 的 `firstText`；`src/host/fold.ts` 写 `node.text = firstText(...)`；`contextView.tsx` 的 `onEdit: row => ({ text: row.text })` | 预填/提交一律走 `node.read`（宿主全文）；**A4 断言"≠80 字预览"** |
| **D2** | **路由未命名空间化**：`/api/dsh-context/detail`、`/balance`、`/backfill` 与已安装的参考插件**同路径** → 后注册者**抛错** | 🔴 功能整块消失且难发现 | `docs/01` F1（`dsh-client-connection/lib/index.js:633`） | M1 全量换前缀 + **冲突自检** |
| **D3** | **投影 key 未命名空间化**：`contextTimeline` 等与其参考插件同 key → 相同 stateVersion **静默共用别人的定义**、不同则**抛错** | 🔴 数据来源错而不报警 | `docs/01` F2（`dsh-session-projection/lib/index.js:85-93`） | key 全改 `redline*` |
| **D4** | 客户端 slot id / locale ns 与参考插件相撞 | 🟠 | 归档 `v2-upstream-base:src/client/index.ts` 的注释（"两者并存会撞同一个 slot id"） | M1 身份对齐清单 |
| **D5** | i18n key 漏定义：`t('card.turnOpen')` 在字典里**不存在** → 界面直接显示原始 key 字符串 | 🟠 | 归档 `redlineEditor.tsx` 引用它，但 `i18n.ts` 中无此键 | 加一条"引用的 key 必须在字典里"的测试 |
| **D6** | **M3 界面从未渲染验收过**（代码完成、无人看过） | 🟠 | 归档 `AGENTS.md` §6 自述"界面渲染未验收" | M3 一律**人工门禁**（`docs/03` §7） |
| **D7** | 建立在**已废弃**的同步读 API 上（`eventAt` / `snapshotEvents` / `ownEvents`） | 🟠 | `docs/01` F5 | 新代码读走 `ctx.sessionQuery` |
| **D8** | 在 **0.1.7-rc.2** 上验证，而运行时已升到 **0.2.0-rc.1** | 🟠 | 归档 `AGENTS.md` §6 与当前 `$DSH_PKG` 版本不符 | 基线换 v0.59.2；M1 重新 `tsc`；待验证项 V1–V6 |
| **D9** | 存在**两份编辑实现**：`write.ts` 的 `applyEdit`（已接线）+ `simulator.ts` 里的 `editMessage`（**该函数无任何 importer**，但**同一个文件**被 `write.ts` 用来做批注：`import { injectSimulatedMessage }`），两者规则还不一致（前者有"草稿没给的字段沿用原文"的回退、后者没有） | 🟡 | 归档 `src/redline/simulator.ts:200-293`（`editMessage` 定义）；`grep -rn "editMessage" src/` 只命中定义处；`write.ts:23` 只 import 了 `injectSimulatedMessage` | **只保留一份**；移植时只带走 `injectSimulatedMessage` 的"追加一条普通 user 消息"最小路径，不带走 `editMessage` |
| **D10** | 改写**必然合并多段文本**为一个文本块 | 🟡 语义缩水 | `write.ts` 用 `joinText()` 把 text 块拼成一个 | 界面**提前告知**（`docs/03` R3.4），不做事后解释 |
| **D11** | 遮蔽**一次性**、替换体不可再改；界面上没有讲清楚 | 🟡 产品预期管理 | `docs/01` F7 | 界面写清 + 给替代路径（批注 / 快照+子会话） |
| **D12** | 度量曾依赖"已解析快照"，而 v2 快照只有 `seq` 没有 `turn` → 缺口 | 🟡 | 归档 `src/redline/metrics.ts` 改为扫日志（`turn/start`/`turn/end`） | 新项目直接用 `sessionQuery.readSession` 扫日志（`docs/02` §3.2） |
| **D13** | `applyEdit` 有一个完整的 `assistant/message` 改写分支，但**平台两条规则互斥使这条路径必然失败**（"要 `sourceEventSeqs` 覆盖被遮蔽节点" vs "assistant 禁止携带 `sourceEventSeqs`"）；它从未被真机跑过（M3 界面未验收），所以没人发现 | 🔴 点下去必错 | 本机实测见 `docs/01` F7.2（探针 `/tmp/redline-probe`） | UI 上**助手消息不给「编辑」**；只给批注 / 快照+子会话（多节点区间替换平台可行，但 v1 **不给 UI 入口**）；`write.ts` 移植时删掉 assistant 分支 |
| **D14** | 把"**被遮蔽的原始节点**不可再作目标"误读成"**编辑只能做一次**"，于是丢掉了用户明确要求的"**能回滚**"（图 2 ④） | 🔴 丢掉一项需求 | `docs/01` F7/F7.1：替换体是当前 surface 节点，**可以再替换** → 连改与回滚都可行（实测 PASS）；v2 的 `isAppendSurfaceEvent(original)` 拒绝是它**自己加的策略**，不是平台限制 | 新项目把回滚做成 v1 能力（`docs/00` G9/S8），目标 = 当前可见的替换体 |

---

## 4. **可复用**（明确清单，避免重复劳动）

| 项 | 为什么值得复用 | 复用方式 |
|---|---|---|
| `eligibility` / `rows` 的**判定与投影**思路 | 把"这一行能不能改、给哪些按钮"抽成**纯函数**，因此能进单测 lane（客户端半无法 TDD，这是唯一能把 UI 逻辑测住的办法） | 移植思路与测试写法；代码重写为适配新路由/新字段 |
| `orchestration` 的**判定次序** | 「未闭合 > 有草稿 > 没固定块 > 建议 fork」这条顺序与理由文案都是踩过坑的产物 | 移植次序与文案，改名 `plan.next` |
| `turn-state` 的**扫日志判闭合** | 简单、无依赖；注意用 `sessionQuery` 版本重写 | 重写 |
| `write.ts` 的**分支结构**（assistant/user/tool-result 三类 + "草稿没给的字段沿用原文"） | 这是最容易写错的地方，归档里有注释记录了"拿合并后的草稿比对会永远相等"的坑 | 移植结构 + 注释 |
| **真实路由级测试模式**（捕获宿主注册的精确路由 → 按真实信封调用 → 读回 DB 断言） | 能测出"两边各自自洽但前缀不成对"这类单测测不出的错 | 直接沿用（`docs/05` §2） |
| `tests/redline/route-pairing.spec.ts`（客户端 bundle purity） | 守住"客户端不许 import 宿主实现" | 沿用并扩展 |
| `storage.ts` 的**版本化 + 退休（不删）**模型 | "版本留痕"是固定块的核心机制 | 沿用表结构 + 加 `schema_version` |
| **数据目录复用** `$DSH_HOME/dsh-context-redline` | 用户已有的固定块不该丢 | 幂等迁移（A15 测试） |

## 5. **明确不复用**（死代码与作废方向）

| 项 | 为什么 |
|---|---|
| `src/redline/simulator.ts` 里的 `editMessage`（第二份编辑器） | **函数**无 importer（死代码），且规则与 `write.ts` 的 `applyEdit` 不一致（D9）。⚠️ 注意**文件本身不是死代码**——`write.ts` 用它导出的 `injectSimulatedMessage` 来做批注，那条最小路径要保留 |
| `src/redline/message-types.ts`、`AMF_RPC_CHANNEL` / forge 前缀路由 | v1 遗留，无路由无调用方 |
| `simulator.ts` 里非 `user` 分支的 `injectSimulatedMessage` | 未被接线；新项目只保留注释里需要的"追加一条普通 user 消息"这一条最小路径 |
| 分支 `main` 的整套 v1 UI（`ContextPanel.tsx` / `ContextView.tsx` / `InventoryPage.tsx` / CSS modules） | 已被"基于上游 UI"的方向取代 |
| 归档 v2 的 `test-v1/`（`node:test` 写法、import 的是 v1 实现） | 只作对照，不作为门禁 |
| 上游的版本检查/社交预览等告警入口 | 引入不必要的网络行为（`docs/02` §8.4） |

---

## 6. 结论：为什么"另起"是对的

归档 v2 已经把**难题都趟过一遍**（哪些 API 能用、遮蔽的一次性、turn 边界、固定块的漂移判定、
子会话继承不到固定块这个缺口……），但它的**地基有三处是错的**：
路由/投影未命名空间化（D2/D3）、读路径建在废弃 API 上（D7）、编辑器会破坏正文（D1）。

与其在 0.59.0 + 0.1.7-rc.2 的地基上打补丁，不如：
**以已经在 0.2.0-rc.1 上跑着的 v0.59.2 为基线重新复制（M1），把上面 D1–D14 一次性封死，
并复用归档里那些"思路正确、测试到位"的纯逻辑（§4）。**
