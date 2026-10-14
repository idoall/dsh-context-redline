# 承载会话生命周期

## 状态机

```text
previewed -> authorized -> creating -> created -> prompted -> running
                                                         -> waiting-user
                                                         -> completed / failed / cancelled
return: not-prepared -> pending-send -> sending -> accepted / uncertain
```

标题状态独立为 `pending | succeeded | failed`，不会伪造成任务状态。

## 持久操作

每个操作使用一个严格 JSON 文件，包含：

- 固定 `opId`、`carrierId`、`promptRequestId`、`returnRequestId`；
- 来源 session ID、surface 版本和 manifest 指纹；
- 计划标题；
- 用户授权时间、来源和回程目标；
- 不可变 `executionInput`；
- 任务、标题和回程状态；
- 绑定的 prompt message、turn 和 assistant message 身份；
- 冻结回程正文及指纹。

写入使用唯一临时文件、文件 fsync、rename 和目录 fsync。空文件、坏 JSON、未知版本、身份错位或指纹不一致会拒绝恢复。

## 授权边界

预览本身没有执行权限。用户点击确认时，授权和执行输入一起落盘，然后才允许创建会话。

`executionInput` 冻结：

- 最终发送全文及指纹；
- 工作区 ID 与 cwd；
- 新会话 preset / provider / model / reasoning effort；
- 来源会话冷恢复配置及独立指纹；
- 附件引用（当前必须为空）。

授权之后，恢复只能重放这份输入。来源继续聊天或草稿继续变化都不能修改已确认操作。

## 创建普通会话

1. 用固定 `carrierId` 查询：
   - 明确不存在：create；
   - 已持久存在：resume；
   - 查询未知：停止，不猜。
2. 创建 root Agent，不设置 parent / seed / origin / fork 元数据。
3. 挂载冻结 preset，并传入冻结的 per-Agent model options。
4. 核对 Agent 实际配置与冻结配置一致。
5. 附着到冻结工作区；失败时保留固定会话 ID，不换 ID 重建。
6. 尝试命名；命名失败不冒充成功。
7. 用固定 request ID 创建完整 user message，并 `followup`。
8. flush 后冷读；只有 request ID、用户消息形状和正文逐字一致才算已持久接纳。

同一 request ID 但正文不同是冲突：停止，不接受、不重发。

## 结果归属

任务结果通过以下持久证据绑定：

```text
promptRequestId
-> inbox splice / claim
-> entered user/message
-> bound turn
-> turn/end
-> visible assistant/message
```

`assistant/attempt` 不是最终结果。多个直接用户输入共享执行、消息未进入步骤或证据冲突时，不取“最后一条回答”兜底。

终态分类：

- completed + 唯一可见 assistant/message：成功；
- blocked / interrupted / error / cancelled：失败类固定通知；
- waiting-user：非终态；
- forked、max-tokens 或归属不明：保持待核实，不冒充成功。

终态、结果身份、回程正文和回程指纹在一次持久转换中冻结。

## 自动回程

回程正文：

```text
【承载会话结果 · <标题> · <完整 carrier id>】
<冻结结果>
```

如果来源 Agent 不在进程中，使用单独冻结的来源配置恢复。新会话改选的模型或推理等级不能泄漏到来源恢复。

回程同样使用固定 request ID、精确正文匹配、flush 和冷读验证。

## 三态恢复

每个 create / prompt / return 检查都只能得出：

- **exists**：转到已接纳状态；
- **absent**：用同一固定 ID 受控重试；
- **unknown**：保持当前状态，不重发。

启动恢复扫描所有操作文件：

- `previewed`：不执行，等待重新确认；
- `authorized` 及之后：使用冻结输入恢复；
- `accepted`：不再发送；
- 损坏台账或指纹：停止并报告。

## 并发与所有权

- 操作文件的 mutation 在进程内按 op ID 串行；
- 会话创建 / 投递由共享 AgentRegistry 控制器持有同一把锁；
- 路由与启动恢复共享锁和 AgentHandle；
- 插件保证自身锁内幂等与可恢复，不宣称平台天然 exactly-once。

## 关键验证

- 重复确认只创建一次、投递一次；
- stale task / draft / surface token 在授权前拒绝；
- 已授权恢复不重读当前草稿；
- selected carrier config 与 source return config 隔离；
- 同 ID 不同正文冲突；
- flush 失败或冷日志缺失保持 unknown；
- 回程正文篡改或指纹篡改拒绝解析；
- 结果只能来自绑定 turn；
- unknown 永不自动重发。
