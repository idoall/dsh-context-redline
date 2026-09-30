# demo 布局实测记录（原始结果）

> **谁做的**：助手，用官方 Playwright MCP（`@deepseek-ai/dsh-browser-use` +
> `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp@0.2.0-rc.1`，headless Chromium）实测。
> **对哪个版本**：demo 资源 `?v=5`（2026-09-30 修完自测面板 `undefined` 之后）。
> **怎么复现**：`bash demo/serve.sh` → 打开 `http://127.0.0.1:5180/redline-panel.html`
> → `window.resizeTo` 等价于设置视口尺寸 → 用页面内自测面板 + `getBoundingClientRect()` 读数。
>
> ⚠️ **这不是真机**：headless Chromium 没有触屏（`matchMedia('(pointer: coarse)') === false`），
> 也不是用户的 Chrome、更不是用户的手机。**最终手感仍以用户本人在手机/桌面上看为准**（`docs/03` §7）。

---

## 1. 视口 1440 × 900（dpr 1，默认深色）

截图：[`measure-1440-viewport.png`](measure-1440-viewport.png)（视口）、[`measure-1440-full.png`](measure-1440-full.png)（整页）

| 项 | 实测值 |
|---|---|
| 整页横向溢出 | **无**（`scrollWidth 1440 = clientWidth 1440`，`body{overflow-x:hidden}`） |
| 整页高 | 1390px |
| 顶栏 | 1440 × 51 |
| 两列 | 左列 `x=14 w=700`、右列 `x=726 w=700`（列间距 12px）→ **两列并排** |
| 卡片 | 上下文统计 `y63 h140` · 上下文趋势 `y215 h314` · 第 N 轮卡 `y541 h106` · 上下文事件 `y659 h148` · 上下文浏览器 `y63 h560` · 快照与子会话 `y635 h633` |
| 趋势容器 | 内容宽 628 = 可视宽 628 → **不横向滚动**（28 根柱在 700px 卡里放得下）；柱数 **28** |
| 刻度上限 | `7.3k`（`#trendScroll[data-max] = 7270`） |
| 行宽 `.row-main` | 654px |
| 动作按钮 | 42 × 26 |
| 讲解热区 `[data-explain]` | **84** 个（随渲染动态生成，不是固定 40） |
| console | **0 条**（error 0 / warning 0） |

## 2. 断点：两列 → 单列

| 视口宽 | 结果 | 截图 |
|---|---|---|
| 880 | **仍两列**，各 420px（`x=14` / `x=446`），无横向溢出 | [`measure-880-breakpoint.png`](measure-880-breakpoint.png) |
| 879 | **折成单列**，各 851px（`x=14`），无横向溢出 | [`measure-879-collapse.png`](measure-879-collapse.png) |

⟹ 断点正好是 **880px**（= `2 × min(420px, 100%)` + 列间距 12 + 左右内边距 14×2），与 [`docs/03`](../../docs/03-ui-spec.md) R6.4 V9「流式列」一致，**没有一处 `@media`**。

## 3. 视口 390 × 844（手机竖屏）

截图：[`measure-390-mobile.png`](measure-390-mobile.png)（视口顶部）、[`measure-390-browser.png`](measure-390-browser.png)（上下文浏览器那一段）、[`measure-390-mobile-full.png`](measure-390-mobile-full.png)（整页）

| 项 | 实测值 |
|---|---|
| 整页横向溢出 | **无**（`scrollWidth 390 = clientWidth 390`，溢出 **0px**） |
| 整页高 | 2835px |
| 顶栏 | **390 × 199**（品牌 1 行 + 状态开关 3 行 + 动作按钮 1 行） |
| 两列 | 两张列容器都是 `x=14 w=362` → **单列堆叠** |
| 卡片 | 上下文统计 `w362 h213` · 上下文趋势 `w362 h410` · 第 N 轮卡 `h106` · 上下文事件 `h192` · 上下文浏览器 `h646` · 快照与子会话 `h875` |
| 趋势容器 | 内容宽 **557** > 可视宽 **336** → **内部横向滚动**（固定柱宽 14px 生效）；初始滚到最右（`scrollLeft 221` = 最大滚动量） |
| 行宽 `.row-main` | 316px（`.actions` 不溢出：`scrollWidth == clientWidth`） |
| 动作按钮 | 42 × 26（编辑/批注）、66 × 26（版本历史） |
| 触控 ≥44px | **本次装置测不了**：`matchMedia('(pointer: coarse)')` = `false`（headless 无触屏）→ `demo.css:390` 的规则**不命中**。把该段内容原样搬到无 media 包装的 `<style>` 里临时测：按钮 **26 → 44**、`.row-main` **44**、`.actions` 仍不溢出；移除后回到 26 → **规则本身有效，只是要真触屏才命中**。真机上是否 ≥44，需要用户在手机上实测 |
| console | **0 条** |

## 4. 页面内自测面板的自报值（修完 `undefined` 之后）

| 视口 | 面板自报 |
|---|---|
| 1440 | `柱数 28 · 内容宽 628px · 可视宽 628px · 需横向滚动 否` · `当前刻度上限 7270` · `行宽 654px · 动作按钮高 26px` · `整页横向溢出：无` |
| 390 | `柱数 28 · 内容宽 557px · 可视宽 336px · 需横向滚动 是（正常，固定柱宽）` · `当前刻度上限 5974` · `行宽 316px · 动作按钮高 26px` · `整页横向溢出：无` |

> 面板读数与 `#trendScroll[data-max]` **逐字一致**（自测护栏里锁死这一点）。

## 5. 本轮由"实测"抓出来的两个问题

1. **自测面板把刻度上限显示成 `undefined`** —— `renderTrend()` 把刻度计算排进 `requestAnimationFrame`，
   而 `render()` 紧接着就渲染自测面板，面板读到的是**刚被重建、还没算过**的 `#trendScroll`。
   实测时序（真实浏览器）：面板显示 `undefined`，而节点上的 `data-max` 其实是 7270。
   → 已修（`renderTrend()` 末尾**同步**先算一次；刻度变化时刷新面板），并加了 4 条护栏。
2. **`.playwright-mcp/` 里的页面快照被误提交进仓库**（上一条提交 `6416fb3` 带了
   `.playwright-mcp/page-2026-09-30T14-28-23-543Z.yml`，320 行工具产物）。
   → 已加进 `.gitignore` 并从索引里移除（文件仍在磁盘上）。
