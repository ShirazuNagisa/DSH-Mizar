# Mizar 协议 v1

手机与电脑之间说的话。

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

监听地址默认是这台电脑的**局域网地址**，中继开着时也一样（并且总会在 `127.0.0.1` 上留一个
socket 给中继转发）。手机优先直连，直连不通再走中继；`bind.mode` 或 `relay.preferLoopback`
可以把监听缩回 loopback，代价是**没有局域网直连**（手机永远走中继，局域网解锁不生效）。

---

## 配对

一次性。之后只认设备令牌。

```text
电脑面板显示                   手机
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
{ "v": 1, "type": "welcome", "hostId": "…", "hostName": "…",
  "protocolVersion": 1, "home": "/Users/…", "deviceId": "…" }

{ "v": 1, "type": "ok", "id": "m1", "result": { … } }

{ "v": 1, "type": "error", "id": "m1", "code": "WRITER_HELD",
  "message": "…", "retryable": false }
```

`v`、`type` 是每个帧都有的。**`welcome` 不带 `id`**，即使 `hello` 带了：主机只回答一次握手，
没有要关联的东西。手机不能靠 `id` 认 `welcome`，只能靠 `type`（黄金帧 `welcome.json` 就是从
真实主机上抓的，里面没有 `id`）。

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
| `PAIRING_CODE_EXPIRED` | 配对码超时 | 让电脑重新生成 |
| `PAIRING_CODE_UNKNOWN` | 没有这个码 | 同上 |
| `RATE_LIMITED` | 尝试过频 | 退避后重试 |
| `DEVICE_REVOKED` | 设备已被吊销 | **清掉本地令牌，回到配对** |
| `WRITER_HELD` | 会话被别的客户端占用 | 让用户先释放 |
| `MODEL_UNAVAILABLE` | 模型不可用 | 刷新目录 |
| `REMOTE_ERROR` | 宿主服务报错 | 透传 message |
| `NOT_IMPLEMENTED` | 未知方法 | 版本不匹配的信号 |
| `INTERNAL` | 插件内部错误 | 报告 |
| `RESPONSE_TOO_LARGE` | 回答超过传输能带的字节数 | 请求更少的数据,不要原样重试 |
| `UPLOAD_UNKNOWN` | upload 不存在、已过期,或不属于这台设备 | 重新开始上传 |
| `UPLOAD_BAD_CHUNK` | chunk 乱序、与已收内容冲突,或不是规范 base64 | 从该 index 重发,或重传 |
| `UPLOAD_TOO_LARGE` | 超过声明大小或大小上限 | 换更小的文件 |
| `UPLOAD_INCOMPLETE` | `finish` 时字节数不够 | 补发缺的 chunk |
| `ATTACHMENT_UNKNOWN` | 附件不存在、已过期,或不属于这台设备/这个会话 | 重新选择附件 |
| `ATTACHMENT_TOO_LARGE` | 一次 prompt 的附件数量或总大小超限 | 减少附件 |
| `ATTACHMENT_UNSUPPORTED` | 媒体类型不能变成 prompt 内容 | 换格式 |
| `ATTACHMENT_FAILED` | 宿主保存文件或交给 DSH 时失败 | 重试;持续失败看宿主日志 |

> **`PAIRING_CODE_INVALID` / `EXPIRED` / `UNKNOWN` 对客户端回答是不同的，但审计日志里
> 区分得更细**（含"已兑换"）。已经兑换过的码重放会被当成 `UNKNOWN`——**故意不告诉客户端
> "这个码用过"**，否则它就变成了一个预言机。

---

## 方法表

25 个方法。`payload` 里的键：

### 主机与会话

| 方法 | payload | 返回 |
|---|---|---|
| `host.info` | — | 主机身份与绑定情况，含可选的 `addresses`（见下） |
| `session.list` | `{}` | `{items: [SessionRow]}` —— DSH 会列出的会话，**不含已归档的**：归档集在工作区注册表里，DSH 自己的 `session/list` 不知道它，所以插件在出口处过滤。 |
| `workspace.list` | `{}` | `{items: [WorkspaceRow], complete}` —— DSH **当前**拥有的工作区，按 DSH 自己的显示顺序（插件直接读 `ctx.workspaceRegistry.list()`，和电脑侧边栏同源），每个工作区带 `sessionIds`：DSH 认可的归属关系，只有主机知道，手机不该自己拿目录去猜；**已归档的会话不在其中**（DSH 的归档保留归属槽位，以便取消归档回到原位，所以过滤在插件出口做）。会话比工作区长命：删掉工作区只移除注册表条目，会话日志还在磁盘上，所以 `session.list` 仍会返回那些目录的会话，手机再按目录分组就会一直留着它们。<br>`sessionIds` **缺省**和 `[]` 是两回事：`[]` 是「DSH 说这里没有会话」，缺省是「主机没说」，只有后者才允许退回按目录匹配。<br>`complete` 说这份清单**是不是完整读到了**：只有 `true` 才允许丢弃已经不在清单里的工作区，因为「主机答不上来」和「主机一个都没有」都是空数组。任何一条读不出来的记录都按「没答」处理（返回 `{items: [], complete: false}`）——主机还可以用 `workspace/follow` 的 baseline 兜底；两条路都不行时手机退回按目录分组。 |
| `session.messages` | `sessionId`, `maxMessages?`, `beforeSeq?`, `afterSeq?`（见下） | `{sessionId, asOfSeq, records[], hasMore}` —— **只发总结，不发过程**。一页里只保留：`turn/start`、`turn/end`、每个 `step/start`（只用来数步骤，约 100 字节）、人写的 `user/message`，以及**每一轮里模型最后那条有正文的 `assistant/message`**。逐步叙述、工具调用/结果、流式 attempt，以及**还没结束的那一轮的中间回复**，全部不发 —— 后两项正是最大的一块。原因：手机端只按「总结 + 状态」渲染，全量历史经中继太吃服务器带宽。`asOfSeq`（分页切点）取自 `session/follow` 首帧的 `cursor`，这是 DSH 自己对 `throughSeq` 的定义（"Inclusive log cut obtained from the corresponding follow opening frame"），原来用 `session/projections` 的 `asOfSeq` 会滞后于日志头，导致刚发出的那一轮不在页里、手机上就没有「AI 正在工作」那一行。 |
| `session.activity` | `sessionId`, `maxEntries?`（默认 200，最多 300）, `beforeSeq?`, `turn?`（见下） | `{sessionId, asOfSeq, turn, entries[], hasMore, oldestSeq}` —— **只返回正在跑的那一轮的紧凑过程**，付费账户的「全量细节」来源：`entries` 里每行是 `{id, seq, at, kind, title, text}`，`kind` 为 `thinking` / `command` / `output` / `tool`，`text` 一行、最多 240 字符；没有正在跑的轮次时 `turn: null, entries: [], hasMore: false`。详细语义见下。 |
| `session.stats` | `sessionId` | `{sessionId, asOfSeq, stats}` —— `stats` 里的每个字段来自主机各自的 projection，**谁有就答谁**：agent 还没跑过的会话没有 `context`（上下文占用）也没有 `title`（标题要等模型读完对话才有），只有 `tokenUsage` 一类。所以「这次的帧比上一帧少几个字段」是**正常回答**，不是失败——实测一台真主机上 12 个会话里有 4 个是这样（缺 `context, title`）。手机必须把新帧**合并**进旧帧（有新值用新值，没有的保留），直接替换会把屏幕上已经画出来的标题、模型、上下文用量抹掉。 |
| `session.create` | `cwd?` \| `workspaceId?` \| `sessionId?`, `agentPreset?` | `{sessionId, agentPreset}` —— 传 `cwd` 时插件会先把它解析成**工作区**（没有就建一个），再把工作区 id 交给 DSH。原因见下。 |
| `session.rename` | `sessionId`, `title` | `{renamed: true}` |
| `session.prompt` | `sessionId`, `text?`, `attachmentIds?`, `requestId?`, `clientTimeZone?`, `mode?` | `{accepted, requestId}` —— `text` **在有附件时可省**;两者不能同时缺。`attachmentIds` 是 `upload.finish` 返回的 id,顺序就是 content 的顺序(文本在最前);附件怎么来见「附件上传」。 |
| `session.cancel` | `sessionId` | `{accepted}` |
| `session.archive` | `sessionId`, `stopActivity?` | `{archived: true}` |

**`host.info` 的 `addresses` 是可选字段，老宿主不答。** 它是插件监听器**实际绑定**的每个 `host:port`（如 `192.168.1.10:19390`、`127.0.0.1:19390`），回答的是「这台电脑现在能从哪些地址拨到」。手机在中继连接上拿不到局域网地址，正是靠它才知道该往哪直连。**缺省不等于空数组**：缺省是「这台电脑的插件太旧，答不上来」，手机必须退回配对时已知的那个地址；`[]` 才是「现在没有任何可拨地址」。这是新增的可选字段，老客户端解码时忽略不认识的键，**不需要升 `PROTOCOL_VERSION`**。

**`session.archive` 归档的是电脑上的会话，不是手机本地的一行。** 插件把它写进 DSH 工作区注册表的全局归档集（`ctx.workspaceRegistry.archiveSession`）。归档是**非破坏性**的：会话日志在，工作区归属槽位也在（取消归档能回到原来的位置），只是从此不再出现在任何列表里 —— 所以 `session.list` 和 `workspace.list` 的 `sessionIds` 都会把它滤掉，手机下次刷新就看不到那一行了。电脑端的侧边栏同样看不到。

- **默认拒绝跑着的会话。** 不传 `stopActivity` 时，宿主会拒绝归档正在跑的会话，错误以 `REMOTE_ERROR` 回来（message 里写明是「会话仍在活动」还是「没有这个会话」），手机原样显示即可。插件**不会**为了让归档成功而偷偷停掉一轮正在跑的对话。
- **`stopActivity: true` 才是「连跑着的一起停」**：注册表先落归档，再请求各 provider 停掉这一轮的工作；某个 provider 失败不会回滚归档。
- **没有注册表就报错。** 没有工作区注册表的组合（老宿主）没有地方可归档，回 `REMOTE_ERROR`，**绝不假装成功**：`{archived: true}` 是关于那台电脑的断言，下一次刷新就会拆穿它。
- `stopActivity` 传了但不是布尔值得到 `MALFORMED_FRAME`，不是静默当成 `false`：这是改宿主状态的调用，客户端 bug 应当报出来。

`session.archive` 和 `host.info` 的 `addresses` 都是**新增**：老宿主对未知方法回 `NOT_IMPLEMENTED`（和 `session.activity` 一样，客户端据此判断电脑端插件太旧），老客户端不会调用它；`addresses` 是可选的，老客户端忽略不认识的键。所以**不需要升 `PROTOCOL_VERSION`**。

**`session.messages` 的增量语义（省流）。** 手机每次刷新都可以带上「我读到哪」，插件只回那之后的新记录。三种取值含义不同：

| `afterSeq` | 手机的意思 | 插件怎么做 |
|---|---|---|
| 数字 | 该位置及之前的记录我都有 | 只回 `seq` 更大的记录 |
| `null` | 我什么都没持有（重装、清了缓存） | 回完整尾页，**不参考**插件记账 |
| 缺省 | 没声明 | 用插件记账里**已成功发给这台设备**的位置 |

插件自己记账：一页 `session.messages` 的 `ok` 帧**真正写到开启的 socket 之后**，才把这一页里最大的 `seq` 记到这台设备（按 `deviceId` + `sessionId` 分开）。被 `RESPONSE_TOO_LARGE` 拒绝的、socket 已经关掉的，都不算送达——记的是「传到了」，不是「存在过」。这份记账只在插件进程内，重启后由手机自己的 `afterSeq` 接手。

过滤发生在**摘要之后、字节预算之前**：老记录不能占掉新记录要用的预算；没有 `seq` 的记录无法证明是旧的，照样发。`beforeSeq`（向上翻历史）与 `afterSeq` 同时出现时，`afterSeq` 不生效——往回翻的页不是「新记录」。

**只有附件的 prompt 会多一行占位文本。** 纯图片/纯文件的 `user/message` 没有 text part,
而会话界面画的是文本 —— 所以摘要会给这类记录**追加**一个
`{type:"text", text:"[Photo]"}` 或 `[File: name]` 的 content part,多个附件按顺序各一行。
这是 `session.messages` 唯一会改动记录内容的地方:其余字段、事件名和顺序仍然原样,
已经有可读文本的消息连对象都不变。

**`session.activity` 是付费账户的「跑动中全量细节」来源。** 它和 `session.messages`
读**同一页当前日志**（同样先 `session/follow` 首帧取切点，失败再用
`session/projections`），但只回答一个问题：这一轮现在在干什么。

- **找正在跑的轮次**：取本页里带活动、且没有 `turn/end` 的**最大轮次号**。页窗口可能正好
  从这一轮中间开始，所以缺 `turn/start` 不算「没在跑」——`turn/end` 才是唯一结束一轮的
  记录。
- **只映射过程**：`assistant/attempt` → `thinking`（从 stream 的 text/reasoning chunk 拼出
  一行，压平换行、截断 240 字符）；`tool/call` → `command`（bash/shell/exec 一类工具名）
  或 `tool`，`title` 是工具名，`text` 取参数的 `command`/`description`，否则截断 JSON；
  `tool/result` → `output`，`title` 按 `callId` 对上工具名，`text` 取输出/内容/错误的
  第一行。**用户/助手已提交的消息、`step/*` 标记、以及任何不认识的事件全部跳过**——不把
  原始 payload 倒给手机，DSH 以后加事件也不会把这一帧撑大。
- **有界**：默认 200 行、最多 300 行；整个 `entries` 的 JSON 预算 **256 KiB**（远低于
  listener 的 512 KiB 帧上限和 iOS 的 1 MiB）。超出时保留最新的行、裁掉最旧的，`hasMore`
  见下面的翻页一节。只有最新的行值得看，手机靠 `id`（`seq-<n>`，无 seq 时是
  `at-<time>-<kind>`）合并。
- **`turn: null` 不是错误**：两轮之间、会话不存在都返回空 `entries`，手机据此隐藏细节区。
- 这是**纯读**方法：不唤醒 agent、不改会话状态。是否调用由手机端决定（付费账户才调），
  宿主不判断账户状态。

**向后翻页（0.9.4 新增，纯加法）。** 不带游标时读的是最新一页；带上 `beforeSeq` + `turn`
才是**向后翻**：读 `beforeSeq` 之前的那一页日志（`session/page` 的 `beforeSeq` 参数），
只保留 `turn` 等于所请求轮次的条目，仍按从旧到新排。这样长轮次的旧过程行可以随滚动懒加载，
而不必每秒重读最新页。

- **`oldestSeq` 是读到的这一页里最小的日志序号**（不是最旧返回行）。**手机从最旧返回行的
  `seq` 继续翻**，而不是从页边界继续：条目上限/字节预算裁掉的是页里最旧的一端，从页边界
  翻会跳过它们；从最旧返回行翻则下一负正好覆盖被裁掉的部分。`oldestSeq: null` 表示这一页
  没有任何带序号的记录，或者什么都没读到（会话不存在）。
- **向后翻的 `hasMore`** = 「条目被裁剪（`entries.length !== mapped.length`）」**或**
  「这一页还有更旧的记录**且**这一页至少贡献了一条该轮次的条目」。第二项为假说明已经翻过
  这一轮的开头，继续问只会拿到空页，必须停；第一项为真时虽然页边界到了，但被裁掉的旧行
  仍夹在游标和页边界之间，必须继续。**向前读的 `hasMore`** 则放宽为「条目被裁剪」**或**
  「这一页还有更旧记录」：这一轮可能延伸到页窗口之前，手机问一次才知道。
- `turn` 必须和 `beforeSeq` 一起出现：一页日志横跨多个轮次，没有 `turn` 就不知道该留谁。
  **`beforeSeq` 不带 `turn` → `MALFORMED_FRAME`**；`turn` 不带 `beforeSeq` 则被忽略（向前读
  自己找正在跑的轮次）。`beforeSeq` / `turn` 传了但不是非负数字同样是 `MALFORMED_FRAME`。
- 老宿主（0.8.4 及更早，没有这两个字段的构建）忽略它们、照旧回最新一页；手机靠「这一页没有
  新增任何 entry id」判停，于是退化成今天的行为而不是死循环。新增可选字段，**不需要升
  `PROTOCOL_VERSION`**。
- 页大小、200/300 行上限和 256 KiB 预算不变，向后翻也套同样的裁剪。**注意 `oldestSeq` 是
  页边界而不是最旧返回行**：向后翻时不要把 `maxEntries` 传得比一整页的条目还少 —— 被裁掉的
  行位于新游标和已返回的行之间，下一页只读游标更小（更旧）的记录，就再也读不到它们了。
  省略 `maxEntries`、用默认 200 最稳。

这是**新增方法**：老宿主对未知方法回 `NOT_IMPLEMENTED`（客户端据此知道这台电脑的插件太旧），
老客户端不会调用它，所以**不需要升 `PROTOCOL_VERSION`**。

### 模型与权限

| 方法 | payload | 返回 |
|---|---|---|
| `model.catalog` | — | `{default, providers[], failures[]}` |
| `session.model.set` | `sessionId`, `provider`, `model`, `reasoningEffort?` | `{sessionId, selected}` |
| `permissions.catalog` | — | `{options[], defaults[], defaultPreset}` |
| `session.permission.set` | `sessionId`, `preset` | `{commandResult}` |

**`session.create` 只传 `cwd` 的话，电脑上看不到这个会话。** DSH 里会话归属于工作区，而归属只在 `session/create` 收到 `workspaceId` 时建立一次：

```js
const cwd = workspace?.path ?? request.cwd ?? this.defaultCwd
…
if (workspace !== undefined) await workspace.attachSession(sessionId)
```

只给 `cwd`，会话就建出来了但**不属于任何工作区**。手机按工作目录分组，照样显示它；电脑的侧边栏是按工作区组织的，什么都不显示 —— 报障原话是"手机上新建会话、发了消息，电脑端 DSH 看不到"。所以插件在收到 `cwd` 时会先找这个目录的工作区，没有就建一个（电脑上手动打开文件夹就是这个行为），然后把 `workspaceId` 传下去。

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
| `push.register` | `token`（iOS 的 APNs 十六进制设备令牌，或 Android 的 FCM 注册令牌）, `platform?`（`ios` \| `android`，缺省 `ios`）, `environment`（`sandbox` \| `production`，**仅 iOS 必填**）, `locale?`, `liveActivityToken?`（iOS Live Activity 的 APNs 推送令牌，1–200 位小写十六进制；**不传 = 清掉已存的**） | `{registered}` |
| `push.presence` | `foreground`（bool） | `{accepted}` |
| `push.unregister` | — | `{unregistered}` |

设备 id **永远取自连接本身**，不取自 payload —— 否则任何一个已配对设备都能替别人的手机登记推送令牌。

`environment` **只在 `platform` 为 `ios` 时必填**，且不给默认值：sandbox 签发的令牌发给 production 端点会被 Apple 以 `BadDeviceToken` 拒掉，而这条错误完全不会提到真正的原因。客户端自己知道答案，就别让服务端猜。Android 只有一个 FCM 服务，没有这个问题，所以 `platform: 'android'` 时不要求该字段（带了也会被忽略，不会报错）。

`platform` 缺省为 `ios`，这是兼容性的关键：现有 iOS 客户端只发 `{token, environment, locale}`，不认识的字段一律没用，但**少一个字段不能导致注册失败**。只接受 `ios` 和 `android` 两个字面值，其它值（包括 `Android` 这种大小写错误）得到 `MALFORMED_FRAME`，而不是被当成 iOS 静默注册 —— 否则一个客户端 bug 会变成「推送为什么不来」的无声故障。

`liveActivityToken` 是 iOS 锁屏/灵动岛上 **Live Activity** 的 APNs 推送令牌，**1–200 位小写十六进制**。它和 `token` 不是同一个令牌，也不能互换：Live Activity 按活动级令牌寻址，往 App 的设备令牌发结束推送只会到达 App，结束不了那个计时。

**这个字段的"不传"是有含义的**：不传表示"现在没有 Live Activity 在显示"，宿主会**清掉**已存的令牌，而不是保持原样。App 只在活动存在时带这个字段，活动结束后不再带，于是下一次注册就把旧令牌清掉了 —— 留着一个已经不在的活动令牌，等于留着一个结束不存在计时的凭据。令牌存在设备的 push 记录里，所以重启插件后重新注册（`republish`）仍然会把它带给中继。

传了但格式不对（非小写十六进制、空串、超过 200 位、不是字符串）得到 `MALFORMED_FRAME`，不会被静默清掉或忽略：客户端以为自己登记成功、却在 App 挂起后才发现计时停不下来，是最难查的那类故障。`platform: 'android'` 时该字段和 `environment` 一样被丢弃 —— Android 没有 Live Activity 可结束。

宿主把令牌转给中继。某个会话跑完、且**手机上还能看到行的会话一个都不在跑**时，中继那条通知里会多一个 `endLiveActivity: true`，由中继替 App 结束 Live Activity —— 这正是 App 被挂起、自己没机会收尾的那一刻。

`liveActivityToken`（App ↔ 宿主）和 `endLiveActivity`（宿主 ↔ 中继）都是**新增的可选字段，不改变 `PROTOCOL_VERSION`**：JSON 解码方会忽略不认识的键，所以先升 App、先升插件、先升中继都能工作。改已有字段的含义、改名，或把新字段变成必填，才需要升版本。

`push.presence` 和 `push.register` 分开，是因为两者的频率差三个数量级：前者每次切换 App 都会调，后者一次启动一次。合起来意味着每次切前台都要往中继发一次 HTTP。

前台状态是**按设备**生效的：正在看着的那台不发通知，别的设备照发。一开始是一个全局开关，结果一台 iPad 开着就让口袋里的 iPhone 什么都收不到 —— 而那条偏偏是最要紧的。

三条都**在没有中继的组合里也照常应答**（`registered: false`），这样手机不需要知道自己连的是哪个版本的插件。

`outcome` 只有 **`allowed-once`** 和 **`rejected`** 两个值。传别的值得到
`MALFORMED_FRAME`，不是静默忽略。

### 附件上传

照片和文件走四步:`upload.begin` → 若干 `upload.chunk` → `upload.finish`;放弃时
`upload.abort`。要分片不是因为协议喜欢分片,而是因为 iOS 的 `URLSessionWebSocketTask`
单帧上限是 1 MiB,而且**超了不是截断,是直接断开连接**:

```
input message size 2222614 exceeds maximum message size 1048576
Read completed with an error Message too long
```

一张 10 MiB 的照片 base64 之后还要再大三分之一,一帧发不出去 —— 连接会先死,附件和
这一轮对话一起丢。

| 方法 | payload | 返回 |
|---|---|---|
| `upload.begin` | `sessionId`, `kind`（`image` \| `file`）, `name`, `mediaType`, `byteSize` | `{uploadId, chunkBytes: 131072}` |
| `upload.chunk` | `uploadId`, `index`（从 0 开始）, `data`（规范 base64） | `{received: index + 1}` |
| `upload.finish` | `uploadId` | `{attachmentId, kind, name, mediaType, byteSize}` |
| `upload.abort` | `uploadId` | `{aborted: true}` |

规则:

- **绑定连接和目标会话。** 设备 id 永远取自已认证的 socket,不取自 payload;一台设备
  开始的 upload 不能被另一台设备 `chunk`/`finish`/`abort`,`finish` 得到的 attachment
  也只能被同一设备、同一 `sessionId` 的 prompt 使用。不属于你的 id 和不存在的 id 得到
  **同一个** `UPLOAD_UNKNOWN` / `ATTACHMENT_UNKNOWN` —— 告诉客户端「那个 upload 存在
  但不是你的」没有任何可操作性,只是泄露。
- **按序、可重试。** 每个 chunk 写在 `index × 131072` 的偏移上,所以同一 index 重发是
  幂等的:会与已写入的字节逐字节比较,相同则照常回答,不同则 `UPLOAD_BAD_CHUNK`,**绝不
  静默覆盖**。乱序(`index` 大于已收块数)直接 `UPLOAD_BAD_CHUNK`;除最后一块外每块必须
  正好 128 KiB,否则偏移约定就被破坏,同样拒绝。
- **只接受规范 base64。** Node 的 base64 解码器会静默跳过非法字符,所以每个 chunk 都先
  解码再编码比对;缺 padding、带换行、含字母表外字符一律拒绝。这是把客户端编码 bug 变成
  「文件少了几段但日志里什么都没有」的唯一入口。
- **大小先验。** `upload.begin` 就按 `kind` 检查:图片 ≤ **10 MiB**、文件 ≤ **32 MiB**,
  超过即 `UPLOAD_TOO_LARGE`,不必先传几十兆。单个 chunk 超过 128 KiB、或写入后超过声明
  的 `byteSize`,同样是 `UPLOAD_TOO_LARGE`;`finish` 时字节数不足则是
  `UPLOAD_INCOMPLETE`。
- **30 分钟 TTL。** 未完成的 upload 和已完成的 attachment 都在最后一次触碰 30 分钟后
  连同 `<stateDir>/uploads/<uploadId>/` 一起删除;插件重启同样会丢弃半成品。过期后的
  id 一律按未知处理,客户端重新选文件即可。`<stateDir>` 是宿主的 Mizar 状态目录
  (默认 `~/.dsh/.mizar`)。
- **一次 prompt 的配额。** 最多 **8 个附件**、其中最多 **4 张图片**、全部附件合计
  ≤ **64 MiB**;超了是 `ATTACHMENT_TOO_LARGE`。图片的 `mediaType` 只接受
  `image/png`、`image/jpeg`、`image/webp`、`image/gif`,其它是
  `ATTACHMENT_UNSUPPORTED`。
- **图片内联进 prompt,文件以 receipt 或路径句柄进入。** 图片最终是 DSH 的
  `{type: "image", data, mediaType, name?}` content part(DSH 自己把它转成持久引用);
  文件优先交给宿主 `fileUploads` 服务的 `uploadStream`,prompt part 是
  `{type: "file", receiptId}`。**老宿主没有这个服务时**,插件把文件存到
  `<stateDir>/attachments/`,并在 prompt 末尾追加一段可读文本
  `[File: name]` 加换行加绝对路径 —— 那是 agent 唯一能用的句柄,也是这个协议不要求
  每个宿主都实现上传存储的原因。

`upload.*` 四个方法、`session.prompt` 的 `text` 可选化与 `attachmentIds` 都是**新增**:
老客户端不会调用它们;老宿主对未知方法回 `NOT_IMPLEMENTED`(这正是客户端判断「这台
电脑的插件不支持附件」的信号),新客户端对老宿主仍可走原来的纯文本路径。所以
**没有 `PROTOCOL_VERSION` 升级** —— 只有把已有字段变成必填、改名或改变含义才需要。

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

唯一的例外是「只有附件、没有文本」的用户消息：桥会追加一行 `[Photo]` /
`[File: name]` 占位文本(见 `session.messages`)，否则那一轮在手机上是一个没有内容的
空泡泡。除这一行以外不改任何字段。

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

当前 9 个黄金帧：`welcome` · `host-info` · `session-list` · `session-messages` ·
`session-stats` · `model-catalog` · `permissions-catalog` · `interactions-pending` ·
`error-frame`。它们同时被断言为**不含任何密钥**。

`session-messages` 是最后补上的一个，也是最该补的：`records` 的顺序、`hasMore` 的含义、
以及"哪些记录能活下来"三件事，此前两边都只能去读桥的源码，而两种语言读同一段源码正是上次
漂移的方式。现在它是一份真实抓下来的页，两边的测试都断言它。

