# 给 AI 设计工具的一包东西（V0 / Gemini / Claude / …）

> 用途：**你自己在工具里新建对话 → 粘 ① 提示词 → 传/贴 ② 附件**。
> ⚠️ 助手**不代按发送**：这些页面在你自己的浏览器/账号里，助手看不到、也不在你账号上触发生成。

---

## 0. 三个工具怎么给（差别就这三行）

| 工具 | 怎么给 | 产出形式 | 我们要额外叮嘱的 |
|---|---|---|---|
| **V0**（v0.app） | 提示词 + **上传整份单文件** | 会生成一个 React/Next **应用预览**（不是纯 CSS 回来） | 让它**额外在回答里贴出"`<style>`/`:root` 变量表 + 关键选择器覆盖"**，否则我们只能自己从预览里扒 |
| **Gemini**（gemini.google.com / Canvas / AI Studio） | 上下文很长，**整份 167 KB 可直接贴**（或传附件） | 通常**直接把改写后的代码给你** | 明确说「**只返回 `<style>…</style>` 整段**，不要重排 HTML」；走 Canvas 时让它导出后再从 `<style>` 取 |
| **能改文件的 CLI / Code Assist** | 直接给仓库路径 | 直接改文件 | 只让它改 **`demo/demo.css`**；**禁止改 `demo/demo.js`** —— 大量行/按钮/编辑器的 HTML 是 JS 拼的，钩子在 JS 里 |
| **Claude / ChatGPT** | 同 Gemini | 同 Gemini | 同 Gemini |

**不要同时让两个工具改同一份**（没法合并）。建议分工：**一个出视觉方向/版式稿，一个做落地 CSS**；或者干脆按顺序：先 V0 出方向 → 再用 Gemini 把方向落成"只含 CSS 的补丁"。

---

## 1. 提示词（整段复制；V0 / Gemini / Claude 通用）

```
我要重新设计一个 Web 应用的视觉风格。它是「DSH Web 客户端」的一个插件面板原型，名叫「上下文批改台」，
用途是让人查看并编辑一次 AI 会话的上下文（每一轮发了什么、哪些内容被注入了、哪些被压缩掉了），
以及据此开子会话、压缩、指挥子会话。

请做「视觉重设计」，不要改变功能与结构。

1) 风格目标：**与宿主 DSH Web 客户端原生视觉一致**（深色优先，也要有浅色版）。
   参考基线：圆角 8px 卡片、1px 低对比边框、层级底色（card < block < 内嵌编辑器）、
   12/13px 紧凑正文、caption 级灰字说明、所有数字用等宽字体。
2) 颜色必须用 CSS 变量（我会映射回宿主主题令牌）：
   --surface-0/1/2/3、--border、--text、--text-secondary、--text-caption、--brand，
   以及语义色 --c-indigo / --c-amber / --c-green / --c-purple / --c-orange / --c-blue / --c-teal。
   **不要写死十六进制颜色**（变量的取值本身除外）。
3) 必须同时适配浅色与深色：深色由 `body[data-ds-dark-theme]` 属性切换（不是 media query）。
   请在 <style> 里给出两套变量取值。
4) **不要改 HTML 结构、不要改 class/id/data-* 的名字**（它们是脚本钩子，改了功能就坏）。
   只允许改 <style> 段里的样式。如果你认为必须动结构，请单独列出你动了哪些元素。
5) 禁止：emoji；用 `filter: brightness()` 表达 hover/选中；给元素自身加 outline/background 做"高亮标号"
   （这类高亮必须画在 ::after 伪元素上）。
6) 可用性硬要求：可点目标 ≥44×44px；390px 宽下不出现横向滚动；按钮禁用时不要消失，而是留灰字标记 + 一句原因；
   数字（token 数 / seq / 时间）用等宽字体对齐。
7) 保留"左上角飘标号"这套做法：可交互元素左上角飘一个小圆标（.exnum），点它弹出右侧说明抽屉（.drawer-*）；
   "点开后才出现的按钮"左上角飘一个「?」（.qfloat）。请让它们在你的配色下也醒目。
8) 布局：页面是 header.topbar + main.cols（左列若干卡、右列若干卡），窄屏自动单列。
   卡片内部可重新排布，但**卡片的分组与顺序含义不要变**（见结构地图）。
   「快照与子会话」卡内有 4 个块（data-block="freeze|children|pending|team"）：
   宽屏并排、窄屏竖排，且每块要有明显区分（标题 + 边框 + 比卡片底深一档的底色）。

交付（最重要）：
- 对 Gemini / Claude / ChatGPT：**只返回 `<style>…</style>` 整段**，并附一句"改了哪些选择器"。
- 对 V0：除预览外，**请额外贴出 `:root` 变量表 + 你覆盖的关键选择器**，我们要按它改 CSS。
```

> 想要更贴宿主？先让我把**宿主真实主题令牌表**提取出来塞进提示词第 2 条（见文末 §5）。

---

## 2. 附件（给哪个文件）

首选：**整份单文件**

```
demo/redline-panel.standalone.html      ← 自包含（CSS/JS 全内联，163 KB，双击可开，无需服务器）
```

- **V0**：用上传附件；若它不接受这么大 → 只给它 `<style>` 整段 + §3 结构地图。
- **Gemini**：上下文窗口大，**整份直接贴通常没问题**；稳妥起见也可只贴 `<style>` + §3。
- **能改文件的 CLI**：直接给仓库路径，让它改 `demo/demo.css`（**不要**碰 `demo.js`）。

---

## 3. 结构地图（工具吃不下整文件时给它）

**页面骨架**

```
header.topbar        品牌 / 状态开关（模拟平台边界态）/ 顶部动作（讲解模式、重置原型）
div.noticebar        顶部说明条（例如"会话不在本进程，只能查看"）
main.cols
  section.col.col-left
    #cardStats       上下文统计：分类占比（左侧分类树 + 数字条）
    #cardTrend       上下文趋势：横向滚动柱体图（每轮/每步；总计/增量；✂ 标压缩事件）
    #cardStep        「第 N 轮 · 第 M 步」：本步信息 + 两个快捷入口（改这轮的用户消息 / 改这轮的注入内容）
    #cardEvents      上下文事件：压缩/剪枝事件行（已发生=实心，尚未发生=虚线灰）+ 一行说明
  section.col.col-right
    #cardBrowser     上下文浏览器：按分类折叠的行（动作条：编辑/批注/存为不变量/应用到会话/版本历史），
                     行下可展开内联编辑器与版本历史
    #cardBlocks      固定块（不变量）：全局"钉住的话"列表 + 漂移状态 + 重注入/退休
    #cardOrch        快照与子会话：4 块 = 冻结 / 子会话·成员索引 / 待处理的结果 / 官方团队（只读）
div.drawer-*         右侧说明抽屉（讲解模式点编号时打开）
div.modal-wrap/.modal 确认框（每个写入动作都过它）
div.selfcheck        自测面板（`?dev=1` 才显示）
div.toast-wrap       回执气泡
```

**关键钩子（名字不许改，只能改样式）**

| 钩子 | 是什么 |
|---|---|
| `#cardStats #cardTrend #cardStep #cardEvents #cardInfo #cardBrowser #cardBlocks #cardOrch` | 卡片容器 |
| `.tbar .tbar-fill .tbar-stack .cseg .arm-up .arm-down .zeroline` | 趋势柱体：命中区 / 填充 / 叠加段 / 分类色段 / 增量上下臂 / 零线 |
| `.catrow .catbody .row .row-main .preview .actions .seq .chip-draft .chip-shadow` | 分类树与行 |
| `.editor .etitle .enote .field .efoot .emsg-err .emsg-ok .esteps` | 行下内联编辑器 |
| `[data-explain]` `.exnum` | 讲解编号（左上角飘的小圆标）与高亮 |
| `.qwrap .qfloat` | 动态按钮左上角飘的「?」 |
| `.pickwrap` | 包住 `select`/`input` 的壳（编号装不进表单控件） |
| `.targetbox .evrow .evhint .orchblock .blocktitle .pickone .adv` | 目标框 / 事件行 / 说明 / 分块 / 块标题 / 选项 / 高级折叠 |
| `data-act="…"` `data-block="…"` `data-cat="…"` | 行为与分组标记 |

**要保留的视觉语言（现在这几处观感是"对的"，别推翻）**

- 分类色徽章 + 左侧色块（`.catsq`）与趋势柱体**同一套色**；
- 行 = 两行语法（上行身份、下行动作，动作缩进与行正文对齐）；
- caption 级灰字放在标题右侧（`.hint`），作为"读数/解释"；
- 数字（token / seq / 时间）等宽。

---

## 4. 收回来之后我做什么

1. 把工具给的颜色**映射回宿主令牌**（`--dsw-alias-*` / `--ds-color-*`）——必须做，
   否则插件接进真实宿主后会跟原生素描不一致；
2. 替换 `demo/demo.css` → 跑 `check-static.mjs` + `check-runtime.mjs`（186 项）确认钩子没被破坏；
3. `node demo/build-standalone.mjs` 重打包，给你带新指纹的单文件版确认。

---

## 5. 两个可选的"我先垫一版"（说一声即可）

1. **提取宿主真实主题令牌表**（浅色 + 深色两套，直接从装好的 DSH Web 客户端里摘 `--dsw-alias-*` / `--ds-color-*` 取值），
   塞进提示词第 2 条 —— 这样任何工具出来的东西**天生就在同一个视觉体系里**（这是我们这次"我自创部分不好看"的根因）；
2. **只做布局重排、不动配色**：先把"挤"解决掉（卡片分组 / 列宽 / 间距节奏），再由工具做视觉层。
