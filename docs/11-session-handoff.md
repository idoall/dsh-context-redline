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
  冒烟测试 58/58。**当前卡在等用户按 R 编号提交互意见 → 改到"交互定稿"**
- M1 及之后：未开工；**插件实现代码仍是零行**（用户没点头前不写）

【硬约束（必须遵守）】
- 只动本仓库；不 push、不开 PR（各自需单独授权）
- 不改 DSH 安装目录、不改 ~/.dsh（**读**它核实平台事实是允许的）
- **dsh web 重启一律由用户本人执行**（这台机的 web 实例承载用户会话）
- 不产生任何 AI 生成内容（进入会话的每个字都必须人写）
- 界面/交互改动：先在 demo/ 里改，用户确认后再搬进插件

【环境现状（2026-09-30 起）】
- 浏览器工具已恢复，**新会话可用，且已实测跑通**：官方 @deepseek-ai/dsh-browser-use +
  @deepseek-ai/dsh-experimental-browser-use-playwright-mcp（0.2.0-rc.1，headless Chromium；
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
  node demo/check-runtime.mjs  # 最小 DOM 桩真跑渲染与切换（58 项）
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
| 最新提交 | `git log -1`：`demo(M0.5)+docs: 浏览器实测（1440/880/879/390）+ 修自测面板 undefined`（哈希不写死，避免"改完文件哈希就变"的自指） |
| 进度 | `docs/10`：**DONE 72 / 共 205** |
| 当前卡点 | **M05-15 交互定稿（等用户按 R 编号提意见）**；其后 `M1-01 授权包①（等用户重启）` |
| demo 地址 | 给用户：`http://10.0.0.30:5180/redline-panel.html`（多文件版，资源 `?v=5`）· `http://10.0.0.30:5180/redline-panel.standalone.html`（单文件版，页头带打包指纹）；`bash demo/serve.sh` 起（`demo/serve.py`，发 no-store） |
| 实测记录 | [`demo/screenshots/measure-log.md`](../demo/screenshots/measure-log.md)（1440 / 880 / 879 / 390 原始数据 + 6 张截图） |
| 浏览器工具 | 已恢复且**本会话已实测跑通**（`navigate/resize/screenshot/evaluate/console_messages`）；限制：headless、无触屏（`pointer:coarse` 不命中） |
| 回退（浏览器控制） | 还原 `$DSH_HOME/profiles/web/cordis.patch.yml.before-browser-use-restore-20260930-184704` + `dsh plugin --profile web remove` 两个包 + 用户重启 |

## 为什么不能"自动接着上一段对话"

客户端没有「分叉 / 在新会话继续」这类入口（已查本地化文案，无 `fork`/`分叉`/`在新会话继续`）。
所以跨会话只能靠**这段可复制的交接文本**；它的可靠性来自两点：
① 真相写在仓库文件里（`AGENTS.md` + `docs/10`），不依赖某一轮对话的记忆；
② 交接文本只写"现状 + 第一件事 + 两条路"，细节让新会话自己读文件。
