# 全量消息传输（已归档）

这里放的是 **0.7.2 之前**那套「把会话日志整页发给手机」的实现。**不参与编译**
（`tsconfig.json` 只收 `src/**`，vitest 只收 `test/**`），也**没有删掉**，留着以后要用。

## 为什么拿掉

手机端只按「总结 + 状态」渲染，而全量历史 —— 逐步叙述、工具调用与结果、流式 attempt、
以及还没结束的那一轮的中间回复 —— 经中继传是服务器上最大的一块流量。0.7.2 起改为：

| | 现在传 | 现在不传 |
|---|---|---|
| 每一轮 | 你的提问、`turn/start`、`turn/end`、每个 `step/start`、**模型最后那条有正文的消息** | 逐步叙述、`tool/call`、`tool/result`、`assistant/attempt`、未结束那一轮的中间回复 |

同时手机上「已完成，用时 xx」和「深度求索中，用时 xx」这两行不再能展开 —— 展开本来
就是给过程文本用的，过程文本不传了，展开也就没有内容。

效果：一页从「每条记录都发」降到「每轮一条总结 + 几个标记」。

## 文件

| 文件 | 是什么 |
|---|---|
| `host/sessions.ts` | 归档时的 `src/bridge/sessions.ts` —— 整页转发，外加字节预算与注入上下文过滤 |
| `protocol-v1.md` | 归档时的协议文档，`session.messages` 一行的原文（含 `asOfSeq` 的旧取法） |

App 侧的对应实现归档在 **DSH-Mizar-iOS** 仓库的
`archive/full-message-transport/`（带 `DisclosureGroup` 的 turn 行、步骤渲染、
`assistant/attempt` 解析）。

## 要用回来的话

1. 把 `host/sessions.ts` 拷回 `src/bridge/sessions.ts`（或者只把其中的整页转发逻辑并回去）。
2. 别忘了**分页切点**：归档版取自 `session/projections` 的 `asOfSeq`，那个值会滞后于日志
   头 —— 刚发出的那一轮会不在页里，手机上就看不到「AI 正在工作」。现在用的是
   `session/follow` 首帧的 `cursor`，这是 DSH 自己对 `throughSeq` 的定义。要用回旧版
   请把这处一起改掉。
3. App 侧同样拷回归档的两个文件，并把 `TurnSection` 的展开、步骤渲染恢复。

`protocol-v1.md` 是**文档快照**，不是可以覆盖回去的文件：现在的协议文档在
`docs/protocol-v1.md`，两份都要看。
