# 给 V0 的一包东西（视觉重设计）

> 用途：**你自己在 V0 里新建一个 chat，把下面"① 提示词"整段粘进去，再把"② 附件"传上去**。
> （我的浏览器是另一台无头 Chromium，看不到你 Chrome 里的 v0 页面，也不会代你在你的账号上触发生成。）

---

## ① 提示词（整段复制粘贴）

```
我要重新设计一个 Web 应用的视觉风格。它是「DSH Web 客户端」的一个插件面板原型，名叫「上下文批改台」，
用途是让人查看并编辑一次 AI 会话的上下文（每一轮发了什么、哪些内容被注入了、哪些被压缩掉了），
以及据此开子会话、压缩、指挥子会话。

请做「视觉重设计」，不要改变功能与结构。具体要求：

1) 风格目标：**与宿主 DSH Web 客户端原生视觉一致**（深色优先，也要有浅色版）。
   参考基线：圆角 8px 的卡片、1px 低对比边框、层级底色（card < block < 内嵌编辑器）、
   12/13px 的紧凑正文、caption 级别的灰字说明、等宽字体用于所有数字。
2) 全部颜色必须走 CSS 变量（我会把它映射回宿主的主题令牌）：
   用 --surface-0/1/2/3、--border、--text、--text-secondary、--text-caption、--brand，
   以及语义色 --c-indigo / --c-amber / --c-green / --c-purple / --c-orange / --c-blue / --c-teal。
   **不要写死十六进制颜色**（除了 --surface-0 这类变量的取值本身）。
3) 必须同时适配**浅色与深色**：深色通过 `body[data-ds-dark-theme]` 这个属性切换（不是 media query）。
   请在 `<style>` 里给出两套变量取值。
4) **不要改 HTML 结构、不要改 class/id/data-* 的名字**（它们是脚本钩子，改了功能就坏）。
   只允许改 `<style>` 段里的样式；如果你认为必须动结构，请在回答里单独列出你动了哪些元素。
5) 禁止：
   - emoji（状态一律用圆点/徽章/文字）；
   - 用 `filter: brightness()` 表达 hover/选中（会引起颜色不一致）；
   - 给元素自身加 outline/background 做"高亮标号"（这类高亮必须画在 ::after 伪元素上）。
6) 可用性硬要求：可点目标 ≥44×44px；390px 宽下不允许出现横向滚动；按钮禁用时不要消失，
   而是留一个灰字标记 + 一句原因；数字用等宽字体对齐。
7) 页面上有一层"讲解模式"：每个可交互元素左上角会飘一个小编号（.exnum），
   点它弹出右侧说明抽屉（.drawer-*）。请保留这个"左上角飘标号"的做法，并让它在你的配色下也醒目。
   同理，"点开之后才出现的按钮"左上角飘一个「?」（.qfloat）。
8) 布局：页面是 header.topbar + main.cols（左列若干卡、右列若干卡），窄屏自动变单列。
   卡片内部允许重新排布，但**卡片的分组与顺序含义不要变**（见附件的结构地图）。
   其中「快照与子会话」这张卡内部有 4 个块（data-block="freeze|children|pending|team"），
   宽屏请并排、窄屏请竖排，且每块要有明显区分（标题 + 边框 + 比卡片底深一档的底色）。

交付：**只给一份改好的 CSS**（改 `<style>` 段即可），并附一句"改了哪些选择器"。
```

---

## ② 要一起给 V0 的附件

**首选**：把整个文件传上去（V0 支持上传附件）：

```
demo/redline-panel.standalone.html      ← 自包含单文件（CSS/JS 全内联，167 KB）
```

**如果 V0 不接受这么大的文件**，就只给它这两样：
1. `<style> … </style>` 整段（从那个单文件里复制）——**这才是要重设计的对象**；
2. 下面这份「结构地图」（让它知道每块是干什么的、哪些钩子不能动）。

---

## ③ 结构地图（V0 不能吃整文件时给它）

**页面骨架**

```
header.topbar        品牌 / 状态开关（模拟平台边界态）/ 顶部动作（讲解模式、重置原型）
div.noticebar        顶部说明条（例如"会话不在本进程，只能查看"）
main.cols
  section.col.col-left
    #cardStats       上下文统计：分类占比（左侧分类树 + 数字条）
    #cardTrend       上下文趋势：横向滚动的柱体图（每轮/每步；总计/增量；✂ 标记压缩事件）
    #cardStep        「第 N 轮 · 第 M 步」：本步信息 + 两个快捷入口（改这轮的用户消息 / 改这轮的注入内容）
    #cardEvents      上下文事件：压缩/剪枝事件行（已发生=实心，尚未发生=虚线灰）+ 一行说明
  section.col.col-right
    #cardBrowser     上下文浏览器：按分类折叠的行（每行有动作条：编辑/批注/存为不变量/应用到会话/版本历史）
                     行下可展开内联编辑器与版本历史
    #cardBlocks      固定块（不变量）：全局的"钉住的话"列表 + 漂移状态 + 重注入/退休
    #cardOrch        快照与子会话：4 块 = 冻结 / 子会话·成员索引 / 待处理的结果 / 官方团队（只读）
div.drawer-*         右侧说明抽屉（讲解模式点编号时打开）
div.modal-wrap/.modal 确认框（每个写入动作都要过它）
div.selfcheck        自测面板（?dev=1 才显示）
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

**要保留的视觉语言（现在这几处的观感是"对的"，别推翻）**

- 分类色徽章 + 左侧色块（`.catsq`）与趋势柱体的**同一套色**；
- 行 = 两行语法（上行身份、下行动作，动作缩进与行正文对齐）；
- caption 级灰字放在标题右侧（`.hint`），作为"读数/解释"；
- 数字（token 数、seq、时间）等宽。

---

## ④ 收回来之后我做什么

1. 把你/V0 给的 CSS 映射回宿主令牌（`--dsw-alias-*` / `--ds-color-*`）——这一步必须做，
   否则插件接进真实宿主后会跟原生素描不一致；
2. 替换 `demo/demo.css` → 跑 `check-static.mjs` + `check-runtime.mjs`（186 项）确认结构钩子没被破坏；
3. `node demo/build-standalone.mjs` 重打包，给你带新指纹的单文件版确认。

---

## ⑤ 两个可选：想让我先"垫一版"吗

如果你希望 V0 有一个更好的起点（而不是让它自由发挥），我可以先做这两件事（说一声即可）：

1. **提取宿主原生视觉令牌**：从装好的 DSH Web 客户端里摘出真实的 `--dsw-alias-*` / `--ds-color-*`
   取值表（浅色 + 深色两套），作为"必须命中的基线"写进提示词；
2. **做一版"骨架对齐"重排**：只动布局（卡片分组/列宽/块划分/间距节奏），不动配色，
   让页面先"不挤"，再由 V0 做视觉层。
