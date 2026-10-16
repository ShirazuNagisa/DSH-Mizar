# Mizar 协议 v1

手机与 Mac 之间说的话。

**为什么要有自己的协议**：iPhone 只说 Mizar，不说 DSH 内部的 Typert 协议。DSH 那 140
个 endpoint、`SessionHistoryRecord` 与 40+ 种会话事件变体的投影工作，全部由插件在服务端
一次性做完。这样 DSH 升版本时只需改插件的 Bridge，**App 不受影响**——这也是黄金帧契约
测试存在的原因。

> 本文是从代码里读出来的，不是设计稿。写它时对照的是
> `src/protocol/frames.ts`、`src/bridge/index.ts`、`src/server/listener.ts`。

---

## 传输

| 路径 | 方法 | 用途 |
|---|---|---|
| `/mizar/v1/hello` | GET | 主机身份，**免鉴权**，配对前用来确认地址可拨 |
| `/mizar/v1/pair` | POST | 用配对码换设备令牌，**免鉴权，唯一一次** |
| `/mizar/v1/ws` | WebSocket | 其余全部流量 |

`HTTP_PREFIX = '/mizar/v1'`，定义在 `frames.ts`。监听端口默认 **19390**，与 DSH 自己的
Web 端口（19388）分开——**插件不碰 DSH 原有的安全边界**。

---

## 配对

一次性。之后只认设备令牌。

```text
Mac 面板显示                   手机
────────────                   ────
mizar://pair?h=100.64.0.1:19390&c=K7QP-3M2X&n=Mac-mini&v=1
                                │ 扫码或深链接解析
                                ▼
                          GET  /mizar/v1/hello      ← 确认地址可拨
                          POST /mizar/v1/pair       ← {code, deviceName, deviceModel,
                                                       appVersion, protocolVersion}
                                │
                                ▼  200 {deviceToken, deviceId, hostId, hostName,
                                        protocolVersion}
                          WS   /mizar/v1/ws
                                │
                          send {v:1, type:'hello', id, token, protocolVersion, appVersion}
                                │
                          recv {v:1, type:'welcome', hostId, hostName, home, deviceId,
                                protocolVersion}
```

**配对 URI 格式**：`mizar://pair?h=<host:port>&c=<CODE>&n=<主机名>&v=1`

- `h` 是 `host:port`，**需要 URL 编码**（`:` → `%3A`）
- `c` 是 Crockford base32 的配对码，形如 `K7QP-3M2X`，**5 分钟过期、单次使用**
- TS 与 Swift 两端的解析器**逐字节一致**，并有共享测试

**令牌只以 SHA-256 存储**。主机侧状态文件里没有明文令牌，泄漏状态文件不等于泄漏访问权。

---

## 帧信封

五种帧。全部带 `v`（协议版本，当前 `1`）。

### 客户端 → 服务端

```jsonc
// 握手，必须是第一帧
{ "v": 1, "type": "hello", "id": "h1", "token": "mz_…",
  "appVersion": "0.1.0", "protocolVersion": 1, "deviceModel": "iPhone17,1" }

// 任何方法调用
{ "v": 1, "type": "session.list", "id": "m1", "payload": { … } }
```

`id` 由客户端生成，**服务端的回应必须带回同一个 `id`**，客户端靠它关联请求。

### 服务端 → 客户端

```jsonc
{ "v": 1, "type": "welcome", "id": "h1", "hostId": "…", "hostName": "…",
  "protocolVersion": 1, "home": "/Users/…", "deviceId": "…" }

{ "v": 1, "type": "ok", "id": "m1", "result": { … } }

{ "v": 1, "type": "error", "id": "m1", "code": "WRITER_HELD",
  "message": "…", "retryable": false }
```

`event` 帧由服务端**主动推送**，见下方"事件"。

---

## 错误码

客户端**必须按 code 分支，不能匹配 message 文本**。

| code | 含义 | 客户端该做什么 |
|---|---|---|
| `PROTOCOL_VERSION_MISMATCH` | 版本不符 | 提示升级，不要重试 |
| `MALFORMED_FRAME` | 帧结构非法 | 这是 bug，报告 |
| `UNAUTHENTICATED` | 还没握手 | 先发 hello |
| `PAIRING_REQUIRED` | 设备未配对 | 回到配对界面 |
| `PAIRING_CODE_INVALID` | 配对码格式不对 | 让用户检查输入 |
| `PAIRING_CODE_EXPIRED` | 配对码超时 | 让 Mac 重新生成 |
| `PAIRING_CODE_UNKNOWN` | 没有这个码 | 同上 |
| `RATE_LIMITED` | 尝试过频 | 退避后重试 |
| `DEVICE_REVOKED` | 设备已被吊销 | **清掉本地令牌，回到配对** |
| `WRITER_HELD` | 会话被别的客户端占用 | 让用户先释放 |
| `MODEL_UNAVAILABLE` | 模型不可用 | 刷新目录 |
| `REMOTE_ERROR` | 宿主服务报错 | 透传 message |
| `NOT_IMPLEMENTED` | 未知方法 | 版本不匹配的信号 |
| `INTERNAL` | 插件内部错误 | 报告 |

> **`PAIRING_CODE_INVALID` / `EXPIRED` / `UNKNOWN` 对客户端回答是不同的，但审计日志里
> 区分得更细**（含"已兑换"）。已经兑换过的码重放会被当成 `UNKNOWN`——**故意不告诉客户端
> "这个码用过"**，否则它就变成了一个预言机。

---

## 方法表

19 个方法。`payload` 里的键：

### 主机与会话

| 方法 | payload | 返回 |
|---|---|---|
| `host.info` | — | 主机身份与绑定情况 |
| `session.list` | `{}` | `{items: [SessionRow]}` |
| `workspace.list` | `{}` | `{items: [WorkspaceRow], complete}` —— DSH **当前**拥有的工作区，按 DSH 自己的显示顺序（插件直接读 `ctx.workspaceRegistry.list()`，和 Mac 侧边栏同源），每个工作区带 `sessionIds`：DSH 认可的归属关系，只有主机知道，手机不该自己拿目录去猜。会话比工作区长命：删掉工作区只移除注册表条目，会话日志还在磁盘上，所以 `session.list` 仍会返回那些目录的会话，手机再按目录分组就会一直留着它们。<br>`sessionIds` **缺省**和 `[]` 是两回事：`[]` 是「DSH 说这里没有会话」，缺省是「主机没说」，只有后者才允许退回按目录匹配。<br>`complete` 说这份清单**是不是完整读到了**：只有 `true` 才允许丢弃已经不在清单里的工作区，因为「主机答不上来」和「主机一个都没有」都是空数组。任何一条读不出来的记录都按「没答」处理（返回 `{items: [], complete: false}`）——主机还可以用 `workspace/follow` 的 baseline 兜底；两条路都不行时手机退回按目录分组。 |
| `session.messages` | `sessionId`, `maxMessages?` | `{sessionId, asOfSeq, records[], hasMore}` |
| `session.stats` | `sessionId` | `{sessionId, asOfSeq, stats}` —— `stats` 里的每个字段来自主机各自的 projection，**谁有就答谁**：agent 还没跑过的会话没有 `context`（上下文占用）也没有 `title`（标题要等模型读完对话才有），只有 `tokenUsage` 一类。所以「这次的帧比上一帧少几个字段」是**正常回答**，不是失败——实测一台真主机上 12 个会话里有 4 个是这样（缺 `context, title`）。手机必须把新帧**合并**进旧帧（有新值用新值，没有的保留），直接替换会把屏幕上已经画出来的标题、模型、上下文用量抹掉。 |
| `session.create` | `cwd?` \| `workspaceId?` \| `sessionId?`, `agentPreset?` | `{sessionId, agentPreset}` —— 传 `cwd` 时插件会先把它解析成**工作区**（没有就建一个），再把工作区 id 交给 DSH。原因见下。 |
| `session.rename` | `sessionId`, `title` | `{renamed: true}` |
| `session.prompt` | `sessionId`, `text`, `requestId?`, `clientTimeZone?`, `mode?` | `{accepted, requestId}` |
| `session.cancel` | `sessionId` | `{accepted}` |

### 模型与权限

| 方法 | payload | 返回 |
|---|---|---|
| `model.catalog` | — | `{default, providers[], failures[]}` |
| `session.model.set` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `{sessionId, selected}` |
| `permissions.catalog` | — | `{options[], defaults[], defaultPreset}` |
| `session.permission.set` | `sessionId`, `preset` | `{commandResult}` |

**`session.create` 只传 `cwd` 的话，Mac 上看不到这个会话。** DSH 里会话归属于工作区，而归属只在 `session/create` 收到 `workspaceId` 时建立一次：

```js
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
…
if (workspace !== undefined) await workspace.attachSession(sessionId)
```

只给 `cwd`，会话就建出来了但**不属于任何工作区**。手机按工作目录分组，照样显示它；Mac 的侧边栏是按工作区组织的，什么都不显示 —— 报障原话是"手机上新建会话、发了消息，电脑端 DSH 看不到"。所以插件在收到 `cwd` 时会先找这个目录的工作区，没有就建一个（Mac 上手动打开文件夹就是这个行为），然后把 `workspaceId` 传下去。

`workspaceId` 和 `cwd` **不能同时传**，DSH 会直接拒绝。`sessionId`（恢复已有会话）时不做任何解析：会话已经有归属了，而拿一个和它不一致的目录去 attach 会让整个调用失败。

### 交互

| 方法 | payload | 返回 |
|---|---|---|
| `interactions.pending` | — | `{approvals[], questions[]}` |
| `approval.answer` | `requestId`, `outcome` | `{accepted}` |
| `question.answer` | `callId`, `answers[]` | `{accepted}` |

### 通知

| 方法 | payload | 返回 |
|---|---|---|
| `push.register` | `token`（APNs 十六进制设备令牌）, `environment`（`sandbox` \| `production`）, `locale?` | `{registered}` |
| `push.presence` | `foreground`（bool） | `{accepted}` |
| `push.unregister` | — | `{unregistered}` |

设备 id **永远取自连接本身**，不取自 payload —— 否则任何一个已配对设备都能替别人的手机登记推送令牌。

`environment` 必填，不给默认值：sandbox 签发的令牌发给 production 端点会被 Apple 以 `BadDeviceToken` 拒掉，而这条错误完全不会提到真正的原因。客户端自己知道答案，就别让服务端猜。

`push.presence` 和 `push.register` 分开，是因为两者的频率差三个数量级：前者每次切换 App 都会调，后者一次启动一次。合起来意味着每次切前台都要往中继发一次 HTTP。

前台状态是**按设备**生效的：正在看着的那台不发通知，别的设备照发。一开始是一个全局开关，结果一台 iPad 开着就让口袋里的 iPhone 什么都收不到 —— 而那条偏偏是最要紧的。

三条都**在没有中继的组合里也照常应答**（`registered: false`），这样手机不需要知道自己连的是哪个版本的插件。

`outcome` 只有 **`allowed-once`** 和 **`rejected`** 两个值。传别的值得到
`MALFORMED_FRAME`，不是静默忽略。

### `requestId` 的语义

`requestId` 是**幂等键**，宿主靠它避免同一条消息被插入两次：

- **同一个 prompt 重试** → 复用同一个 `requestId`，宿主不会重复插入
- **一条新的 prompt** → 必须用新的 `requestId`，否则宿主会把它当成重试而丢弃

App 当前的实现是**每次发送都生成新的 UUID**，它不自动重试——所以用户手动再发一次同样的
文字会被当作**一条新消息**，这是对的。但如果将来加入自动重试，**必须把 key 一起带上**，
否则重试会产生重复消息。

> **没有 `always-allow`，这是刻意的。** 一个活得比它被授予的请求更久的许可，本质上是
> **权限变更**——而权限变更应该走 `session.permission.set`，那里它可见且可撤销。把
> "总是允许"放进审批卡片，是把一个持久决定伪装成瞬时决定。

---

## 两条必须遵守的规则

### 1. 缺失的键 ≠ 零

宿主对**没有组合进来的包所拥有的投影**返回 `null`，App **绝不能渲染成 0**。

```
cacheHit: null          → 显示 "—"        （不是 0%）
tokenUsage: {0,0,0,0}   → 显示 0           （主机确实报告了 0）
```

区别是有意义的：**"还没有缓存命中"和"这台主机无法报告缓存命中"是两件事**。
`docs/screenshots/03-usage.png` 里同时能看到这两种情况。

同样，缓存命中率**永远不能把一个不完整的命中率四舍五入成 100%**——所以它是字符串而不是
数字，精度由宿主决定，App 不得重新取整。

### 2. 记录保持原样，不归一化

`session.messages` 返回的 `records[]` 是**宿主原样给的**。事件名在设计上就是"可合并扩展的"
（`SessionEventEntry` 的注释原文：*durable readers own recognition of merge-extensible
event names*），所以形状集合是**开放的**。

在 Bridge 里重塑它们，意味着 **DSH 每加一种事件就要重新部署插件**。所以由 App 决定它
认识什么，**不认识的照样显示**——`Conversation.swift` 会把未知事件渲染成一行活动标记，
而不是丢掉。

```jsonc
// 真实会话日志里的一条记录
{"type":"event","event":{"type":"user/message","seq":8,"time":1791984791224,
  "data":{"content":[{"type":"text","text":"…"}],"role":"user","id":"…"}}}
```

已验证会出现的 `event.type`：

```
permission/preset · sandbox/mode · approval/policy · agent/inbox/spliced
turn/start · turn/end · step/start · step/end · system/message · user/message
request/header · request/context · session/title · session/title-llm-request
assistant/attempt
```

**assistant 的文本在 `assistant/attempt` 的 `data.stream[]` 分块里**；以
`chunk.type == "finish"` 且 `reason.kind == "error"` 结束的轮次**没有产出回答**，必须显式
呈现而不是当作空回复。

---

## 事件

服务端主动推 `event` 帧。客户端**必须**处理它们，否则审批要等到下一次轮询才可见——
而一个被阻塞的 agent 每多等一秒都是真实的停滞。

```jsonc
{ "v": 1, "type": "event", "event": "interactions.changed",
  "data": { "approvals": 1, "questions": 0 } }
```

| event | 何时发 | data |
|---|---|---|
| `interactions.changed` | 待处理集合有任何变化 | `{approvals, questions}` |
| `approval.request` | 一个新的审批 | 审批内容 |
| `approval.resolved` | 审批被回答或撤回 | `{requestId, outcome}` |
| `question.request` | 一个提问批次 | 提问内容 |
| `question.resolved` | 提问被回答 | `{callId}` |

**`interactions.changed` 只带计数，不带内容。** 客户端收到后要重新调
`interactions.pending` 取明细。这样通知本身**不会过期**——一个携带内容的通知在重连后会
变成一份陈旧副本，而计数不会。

前四个是为了兼容：它们在 `interactions.changed` 之前就存在，只发那四个的宿主仍然应该能
被正确处理。客户端处理任意一个即可，因为每个都导向同一次刷新。

**通知是尽力而为的。** 宿主侧所有帧发送都经过一个吞掉异常的包装：传输失败**不能**让状态
变更失败。审批本身还在，因为 socket 打了个嗝就把它丢掉，等于丢掉了操作者唯一一次回答的
机会。

## 已知限制

**`interactions.pending` 是"现在有什么"，不是一个可重放的流。** 两次事件之间出现又消失的
请求会被错过. 目前不会发生（审批会一直等到有人回答），但如果将来引入超时就必须改成
带游标的事件流。

**客户端仍保留一个 45 秒的兜底轮询。** 它不是机制，是保险：一次因重连而丢失的通知不该
让一张已经不存在的卡片永远留在屏幕上。

---

## 契约怎么保证不漂移

`protocol/fixtures/` 里的帧是**从真实运行的宿主捕获的**，并且
**TypeScript 与 Swift 两套测试读同一批文件**。

手写的帧和真实的帧只在有人记得同步时才一致，而它们不同步时**不会有任何东西失败**。
两个独立的解码器读同一个产物，才能真正把契约钉住。

```bash
MIZAR_WRITE_FIXTURES=1 scripts/dev.sh smoke   # 重新捕获
```

当前 8 个黄金帧：`welcome` · `host-info` · `session-list` · `session-stats` ·
`model-catalog` · `permissions-catalog` · `interactions-pending` · `error-frame`。
它们同时被断言为**不含任何密钥**。
