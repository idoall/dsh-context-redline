# 更新日志 / Changelog

## [0.1.3] — 2026-11-21

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.5 <0.3.0-0`; verified with `0.2.2-rc.5`. Node.js `>=24.9.0`.

### 变更 / Changed

- 验证基线提升到 DSH `0.2.2-rc.5`（现为 npm `latest`）；开发依赖与对等依赖下限同步，Zod 4.6.6 与 `dsh-error` 对等依赖保持不变。
- Move the verified baseline to DSH `0.2.2-rc.5` (now npm `latest`); synchronize development/peer dependency floors while keeping Zod 4.6.6 and the `dsh-error` peer.
- rc.5 仅调整 DeepSeek 模型的服务端搜索策略，未修改本插件使用的 Session Query、Agent、预设、工作区、会话投影与 Client 插槽接口。
- rc.5 only adjusts DeepSeek models' server-side search strategy; the Session Query, Agent, preset, workspace, projection and Client slot interfaces used here are unchanged.
- 保留此前的模型 / 预设读取、异步投影句柄和工具结果历史修复；支持下限随验证基线上移，旧 DSH 用户可继续使用 0.1.2。
- Retain the model/preset reads, asynchronous projection handle and tool-result history fixes. The supported floor moves with the verified baseline; older DSH users can stay on 0.1.2.

本次仍为兼容性补丁，不包含未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This remains a compatibility patch and excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.2] — 2026-11-18

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.4 <0.3.0-0`; verified with `0.2.2-rc.4`. Node.js `>=24.9.0`.

### 变更 / Changed

- 验证基线提升到 DSH `0.2.2-rc.4`，包含其 Zod 4.6.6 与新增的 `dsh-error` 对等依赖；类型检查、全量测试与构建均以该版本依赖完成。
- Move the verified baseline to DSH `0.2.2-rc.4`, including its Zod 4.6.6 and the new `dsh-error` peer; typecheck, the full test suite and the build run against that dependency set.
- 0.2.2-rc.2 至 rc.4 未移除本插件使用的公开接口；会话批量追加与更明确的工具错误类型不影响现有只读、台账和回程路径。
- DSH 0.2.2-rc.2 through rc.4 removed no public interface this plugin uses; batched event append and clearer tool error types do not affect the read-only capture, ledger or return paths.
- 保留 0.1.1 的模型 / 预设读取、异步投影句柄与工具结果历史修复；支持范围下限随验证基线上移，旧 DSH 用户可继续使用 0.1.1。
- Retain the 0.1.1 model/preset reads, asynchronous projection handle and tool-result history fixes. The supported floor moves with the verified baseline; older DSH users can stay on 0.1.1.

本次仍为兼容性补丁，不包含未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This remains a compatibility patch and excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.1] — 2026-11-04

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.2-rc.1 <0.3.0-0`; verified with `0.2.2-rc.1`. Node.js `>=24.9.0`.

### 修复 / Fixed

- 读取会话当前的模型选择，不再把启动配置误当成用户切换后的模型；未指定推理等级不继承旧值。承载会话恢复时按实际当前模型验证，配置不一致或未知则停止投递。
- Read the Session's current model selection instead of stale startup options. Omitted reasoning effort stays at the model default. Carrier recovery validates the effective route and refuses mismatched or unknown selections.
- 读取会话当前已记录的预设，不再优先使用创建时固定头信息；未知预设不猜测。
- Read the recorded preset selection instead of the immutable creation header; never guess an unknown preset.
- 等待异步会话投影注册完成后再启用详情读取，使用保留的投影句柄而非弃用的按 key 读取。
- Await asynchronous projection registration before exposing detail reads, and retain the projection handle instead of using deprecated registry key reads.
- 修复新版工具结果历史详情丢失正文与错误状态的问题，同时保留旧日志格式读取。
- Preserve current tool-result history content, call identity and failure status while continuing to read legacy log shapes.
- 开发依赖、Node.js 要求、中英文文档和 npm 包支持范围同步；GitHub Release 必须等待 npm 发布成功。
- Synchronize development dependencies, Node.js requirements, bilingual documentation and npm support metadata; create the GitHub Release only after successful npm publication.

本次仅发布兼容性补丁，不包含尚未验收的上下文体检、carrier-seed 实验或其他未发布功能。自动化回归不代表生产人工验收。
This compatibility-only patch excludes unaccepted context diagnostics, carrier-seed experiments and other unpublished features. Automated regression checks do not constitute production manual acceptance.

## [0.1.0] — 2026-10-15

**兼容性 / Compatibility:** DeepSeek Harness `>=0.2.1-alpha.2 <0.3.0`.

### 新增 / Added

- 可编辑、可删除的上下文迁移副本；本地保存不改来源会话。
- 在当前工作区创建零历史普通根会话，不继承 fork 历史。
- 可直接编辑最终发送全文，并选择新会话模型与推理等级。
- 固定 ID 持久台账、精确字节校验、崩溃恢复和自动原样回程。
- 混合文字 / 图片消息迁移文字并明确报告遗漏图片。

### 安全与恢复 / Safety and recovery

- 删除项不进入新会话，来源日志保持 append-only。
- 工具结果必须匹配原调用；未知媒体和文件附件不会静默丢失。
- 同一 request ID 必须匹配精确正文，并在 flush 后由冷日志证明持久化。
- unknown 状态不重发；损坏台账、配置或回程指纹会停止执行。
- 新会话配置与来源会话回程恢复配置分开冻结。

### 界面 / UI

- 上下文统计、趋势、事件、七类浏览器与普通承载会话索引。
- 行下全文编辑、可逆删除、最终全文编辑器。
- 与 DSH 输入框一致的一行模型 / 推理等级浮动选择器。
- 深浅主题、窄屏布局和 CSS 命名空间隔离。

### 许可 / License

- 原创代码采用 MIT。
- 复制自 `dsh-context` 的部分保留 Apache-2.0。
- 详见 `NOTICE`、`LICENSE-Apache-2.0` 和 `UPSTREAM.md`。
