<h1 align="center">上下文批改 · Context Redline</h1>

<p align="center">查看、批改并迁移 DeepSeek Harness 会话上下文，再把任务结果原样送回来源会话。</p>

<p align="center">
  <a href="https://www.npmjs.com/package/dsh-context-redline"><img src="https://img.shields.io/npm/v/dsh-context-redline?label=npm&color=CB3837" alt="npm 版本"></a>
  <a href="https://github.com/idoall/dsh-context-redline/actions/workflows/ci.yml"><img src="https://github.com/idoall/dsh-context-redline/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/idoall/dsh-context-redline/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT%20AND%20Apache--2.0-0F172A" alt="许可证"></a>
</p>

<p align="center"><a href="https://github.com/idoall/dsh-context-redline/blob/main/README.md">English</a> | 中文</p>

<p align="center">
  <a href="#能做什么">能做什么</a> ·
  <a href="#安装">安装</a> ·
  <a href="#使用">使用</a> ·
  <a href="#边界">边界</a> ·
  <a href="https://github.com/idoall/dsh-context-redline/blob/main/CHANGELOG.md">更新记录</a>
</p>

> DeepSeek Harness 社区插件。它不修改 DSH 源码，也不改写来源会话日志。
>
> **支持 DSH `>=0.2.1-alpha.2 <0.3.0`。** 首版针对 `0.2.1-alpha.2` 验证。

本地编辑只写插件目录；确认后，插件在当前工作区创建一个零历史普通会话，逐字发送你确认的最终全文。任务完成后，绑定结果自动回到来源会话。

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/overview.png" width="100%" alt="上下文批改桌面总览：统计、趋势、事件、七类上下文浏览器与承载会话">
</p>

<p align="center"><sub>当前交互 demo 的桌面总览：左侧看规模与事件，右侧查看、编辑或删除迁移材料。</sub></p>

## 能做什么

- **全文查看。** 编辑器读取 durable 全文，不使用列表里的短预览。
- **本地批改。** 编辑用户消息、注入 / 技能材料、助手迁移副本和已配对工具结果。
- **可逆删除。** 删除表示“不迁移这条”，来源日志保持 append-only。
- **最终全文。** 确认框中的文本就是新会话收到的完整第一条用户消息，可直接删段、改字、重排。
- **会话级模型。** 一行浮动选择器配置新会话模型和推理等级，不修改来源会话或全局默认。
- **普通新会话。** 在当前工作区创建零历史 root session，不继承 fork 历史。
- **自动回程。** 只取与固定 prompt request ID 绑定的结果，原样送回来源会话。
- **可恢复。** 固定 ID、持久台账、精确正文匹配、flush、冷读和三态恢复共同防止重复或猜测。

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/carrier-confirm.png" width="100%" alt="开启普通新会话确认框：任务、模型和推理等级、最终发送全文">
</p>

<p align="center"><sub>桌面确认框：任务、模型 / 推理等级和最终发送全文在一次明确授权中冻结。</sub></p>

<p align="center">
  <img src="https://raw.githubusercontent.com/idoall/dsh-context-redline/main/assets/mobile-confirm.png" width="430" alt="移动端普通新会话确认框">
</p>

<p align="center"><sub>移动端确认框：选择器保持一行，长内容只在最终全文框内滚动。</sub></p>

> 截图来自仓库当前版本的交互 demo，用于说明布局与关键流程，不冒充生产会话数据。

## 安装

需要 DeepSeek Harness `0.2.1-alpha.2` 或更新的 `0.2.x`，以及 Node.js `22.19+` 或 `24+`。

npm 发布后：

```sh
dsh plugin --profile web add dsh-context-redline@latest
```

本地开发：

```sh
pnpm install
pnpm run build
dsh plugin --profile web add "link:$(pwd)"
```

安装或宿主代码更新后，由用户本人重启 `dsh web`。仅客户端改动构建后通常只需硬刷新。

卸载：

```sh
dsh plugin --profile web remove dsh-context-redline
```

卸载插件不会自动删除 `$DSH_HOME/dsh-context-redline/` 中的本地草稿和操作台账。

## 使用

1. 打开已有消息的会话，进入「上下文批改」。
2. 可选：逐条编辑或删除；保存只写本地。
3. 点击「开启普通新会话」。
4. 填写任务，并在「最终发送全文」中完成最后修改。
5. 选择模型；推理等级可保持「使用模型默认值」。
6. 确认创建；在左侧打开新会话。
7. 新会话结束后，结果会自动回到来源会话。

详见[用户指南](https://github.com/idoall/dsh-context-redline/blob/main/docs/12-user-guide.md)。

## 图片和附件

- 混合文字 / 图片消息迁移全部文字，并显示「图片 N 个未迁移」。
- 纯图片消息不生成空白段，但计入遗漏数。
- 图片引用仍参与来源指纹，图片变化会使旧确认失效。
- 图片二进制、文件、file-ref 和通用附件当前不迁移；未知媒体明确拒绝，不会静默消失。

## 边界

- 不改写或删除来源会话历史。
- 系统提示词和工具定义由目标预设生成；迁移文字不冒充系统层。
- 工具结果必须匹配原工具调用。
- 不提供历史版本、回滚、压缩、团队任务板或会话删除 UI。
- 插件保证自身锁内幂等与可恢复，不宣称平台天然 exactly-once。

## 开发

```sh
pnpm install
pnpm run typecheck
pnpm run lint
pnpm run test
./node_modules/.bin/vitest run
node scripts/release-check.mjs
pnpm pack --dry-run
```

推送 `v*` tag 后，GitHub Actions 会校验版本和双语发布说明、测试、打包，并通过 npm Trusted Publishing（OIDC，无 `NPM_TOKEN`）发布，再创建 GitHub Release。

## 文档

- [用户指南](https://github.com/idoall/dsh-context-redline/blob/main/docs/12-user-guide.md)
- [上下文迁移合同](https://github.com/idoall/dsh-context-redline/blob/main/docs/13-context-migration.md)
- [系统提示词与注入边界](https://github.com/idoall/dsh-context-redline/blob/main/docs/14-system-prompt-and-injection.md)
- [承载会话生命周期](https://github.com/idoall/dsh-context-redline/blob/main/docs/15-carrier-lifecycle.md)
- [上游来源与修改记录](https://github.com/idoall/dsh-context-redline/blob/main/UPSTREAM.md)

## 许可

原创部分采用 MIT；复制自 `dsh-context` 的部分保留 Apache-2.0。详见 [LICENSE](https://github.com/idoall/dsh-context-redline/blob/main/LICENSE)、[LICENSE-Apache-2.0](https://github.com/idoall/dsh-context-redline/blob/main/LICENSE-Apache-2.0)、[NOTICE](https://github.com/idoall/dsh-context-redline/blob/main/NOTICE) 和 [UPSTREAM.md](https://github.com/idoall/dsh-context-redline/blob/main/UPSTREAM.md)。本插件是独立 fork，不代表上游作者背书。
