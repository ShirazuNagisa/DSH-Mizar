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
| `UPLOAD_INTEGRITY` | 落盘字节与 `begin` 声明的 SHA-256 不符（声明了才会校验），upload 已作废 | 重新上传该文件 |
| `UPLOAD_LIMIT_REACHED` | 暂存配额用尽：全局/单设备在传数量，或全局声明字节预留 | 等在传上传结束或 30 分钟 TTL 过期后重试 |
| `ATTACHMENT_UNKNOWN` | 附件不存在、已过期,或不属于这台设备/这个会话 | 重新选择附件 |
| `ATTACHMENT_TOO_LARGE` | 一次 prompt 的附件数量或总大小超限 | 减少附件 |
| `ATTACHMENT_UNSUPPORTED` | 媒体类型不能变成 prompt 内容 | 换格式 |
| `ATTACHMENT_FAILED` | 宿主保存文件或交给 DSH 时失败 | 重试;持续失败看宿主日志 |
| `ATTACHMENT_INVALID` | 同一 `requestId` 被用于内容不同或设备不同的附件 prompt | 换一个新的 `requestId`;先确认上一条是否已送达 |
| `FILE_UNKNOWN` | 会话工作区内没有这个常规文件 | 文件可能已被删除,让电脑重新交付 |
| `FILE_FORBIDDEN` | 路径在工作区外、经符号链接解析到工作区外、不是常规文件,或是凭据形状的文件名 | 这个文件不能预览,不要重试 |
| `FILE_TOO_LARGE` | 文件超过 32 MiB 的预览上限 | 不预览,或让模型切分/压缩后再交付 |

> **`PAIRING_CODE_INVALID` / `EXPIRED` / `UNKNOWN` 对客户端回答是不同的，但审计日志里
> 区分得更细**（含"已兑换"）。已经兑换过的码重放会被当成 `UNKNOWN`——**故意不告诉客户端
> "这个码用过"**，否则它就变成了一个预言机。

---

## 方法表

31 个方法（自建中继时没有 `relay.set`，为 30 个）。`payload` 里的键：

### 主机与会话

| 方法 | payload | 返回 |
|---|---|---|
| `host.info` | — | 主机身份与绑定情况，含可选的 `addresses`、`relay` 与 `desktop`（见下） |
| `relay.set` | `url` | `{url, room, baseURL}` —— 把电脑的隧道移到免费或付费中继。`url` 只接受两个公共中继（见下），否则 `MALFORMED_FRAME`；**token 不变，room 不变**，已配对关系不受影响。老宿主回 `NOT_IMPLEMENTED`。 |
| `session.list` | `{}` | `{items: [SessionRow]}` —— DSH 会列出的会话，**不含已归档的**：归档集在工作区注册表里，DSH 自己的 `session/list` 不知道它，所以插件在出口处过滤。 |
| `workspace.list` | `{}` | `{items: [WorkspaceRow], complete}` —— DSH **当前**拥有的工作区，按 DSH 自己的显示顺序（插件直接读 `ctx.workspaceRegistry.list()`，和电脑侧边栏同源），每个工作区带 `sessionIds`：DSH 认可的归属关系，只有主机知道，手机不该自己拿目录去猜；**已归档的会话不在其中**（DSH 的归档保留归属槽位，以便取消归档回到原位，所以过滤在插件出口做）。会话比工作区长命：删掉工作区只移除注册表条目，会话日志还在磁盘上，所以 `session.list` 仍会返回那些目录的会话，手机再按目录分组就会一直留着它们。<br>`sessionIds` **缺省**和 `[]` 是两回事：`[]` 是「DSH 说这里没有会话」，缺省是「主机没说」，只有后者才允许退回按目录匹配。<br>`complete` 说这份清单**是不是完整读到了**：只有 `true` 才允许丢弃已经不在清单里的工作区，因为「主机答不上来」和「主机一个都没有」都是空数组。任何一条读不出来的记录都按「没答」处理（返回 `{items: [], complete: false}`）——主机还可以用 `workspace/follow` 的 baseline 兜底；两条路都不行时手机退回按目录分组。 |
| `session.messages` | `sessionId`, `parentSessionId?`, `maxMessages?`, `beforeSeq?`, `afterSeq?`（见下） | `{sessionId, asOfSeq, records[], hasMore, context}` —— **只发总结，不发过程**。一页里只保留：`turn/start`、`turn/end`、每个 `step/start`（只用来数步骤，约 100 字节）、人写的 `user/message`，以及**每一轮里模型最后那条有正文的 `assistant/message`**。逐步叙述、工具调用/结果、流式 attempt，以及**还没结束的那一轮的中间回复**，全部不发 —— 后两项正是最大的一块。原因：手机端只按「总结 + 状态」渲染，全量历史经中继太吃服务器带宽。`asOfSeq`（分页切点）取自 `session/follow` 首帧的 `cursor`，这是 DSH 自己对 `throughSeq` 的定义（"Inclusive log cut obtained from the corresponding follow opening frame"），原来用 `session/projections` 的 `asOfSeq` 会滞后于日志头，导致刚发出的那一轮不在页里、手机上就没有「AI 正在工作」那一行。<br>`parentSessionId` 只在读**子代理的页**时传（见下「子代理的页」）。<br>**`context` 是每次刷新都必须带的字段**：上下文窗口占用及其明细（`{window, pressureTokens, projectedTokens, percent, breakdown}`，与 `session.stats` 的 `context` 使用同一套推导），**全量页和增量页都带**，这样屏幕上方那一圈占用和展开页的明细随任何一次刷新一起更新，不再依赖一次增量刷新不会发的 `session.stats`。没有 `contextPressure` projection 的部署回 `null`（未知，不是 0）；老宿主不答这个键、老客户端忽略它。 |
| `session.activity` | `sessionId`, `maxEntries?`（默认 200，最多 300）, `beforeSeq?`, `turn?`（见下） | `{sessionId, asOfSeq, turn, entries[], hasMore, oldestSeq}` —— **只返回正在跑的那一轮的紧凑过程**，付费账户的「全量细节」来源：`entries` 里每行是 `{id, seq, at, kind, title, text}`，`kind` 为 `thinking` / `command` / `output` / `tool`，`text` 一行、最多 240 字符；没有正在跑的轮次时 `turn: null, entries: [], hasMore: false`。详细语义见下。 |
| `session.stats` | `sessionId` | `{sessionId, asOfSeq, stats}` —— `stats` 里的每个字段来自主机各自的 projection，**谁有就答谁**：agent 还没跑过的会话没有 `context`（上下文占用）也没有 `title`（标题要等模型读完对话才有），只有 `tokenUsage` 一类。所以「这次的帧比上一帧少几个字段」是**正常回答**，不是失败——实测一台真主机上 12 个会话里有 4 个是这样（缺 `context, title`）。手机必须把新帧**合并**进旧帧（有新值用新值，没有的保留），直接替换会把屏幕上已经画出来的标题、模型、上下文用量抹掉。 |
| `session.create` | `cwd?` \| `workspaceId?` \| `sessionId?`, `agentPreset?` | `{sessionId, agentPreset}` —— 传 `cwd` 时插件会先把它解析成**工作区**（没有就建一个），再把工作区 id 交给 DSH。原因见下。 |
| `session.rename` | `sessionId`, `title` | `{renamed: true}` |
| `session.prompt` | `sessionId`, `text?`, `attachmentIds?`, `requestId?`, `clientTimeZone?`, `mode?` | `{accepted, requestId}` —— `text` **在有附件时可省**;两者不能同时缺。`attachmentIds` 是 `upload.finish` 返回的 id,顺序就是 content 的顺序(文本在最前);附件怎么来见「附件上传」。 |
| `session.cancel` | `sessionId` | `{accepted}` |
| `session.archive` | `sessionId`, `stopActivity?` | `{archived: true}` |

**`host.info` 的 `addresses` 是可选字段，老宿主不答。** 它是插件监听器**实际绑定**的每个 `host:port`（如 `192.168.1.10:19390`、`127.0.0.1:19390`），回答的是「这台电脑现在能从哪些地址拨到」。手机在中继连接上拿不到局域网地址，正是靠它才知道该往哪直连。**缺省不等于空数组**：缺省是「这台电脑的插件太旧，答不上来」，手机必须退回配对时已知的那个地址；`[]` 才是「现在没有任何可拨地址」。这是新增的可选字段，老客户端解码时忽略不认识的键，**不需要升 `PROTOCOL_VERSION`**。

**`host.info` 的 `desktop` 回答「这台电脑是什么」。** 形状是 `{os, client}`，例如 `{"os": "macOS", "client": "DSH"}`：`os` 是操作系统显示名（`macOS` / `Windows` / `Linux`），`client` 是桌面端产品名（本插件为 `DSH`；Codex、Claude Code 插件分别是 `Codex`、`Claude Code`）。这两个值不能从手机侧的配对信息推导，尤其是电脑离线时；所以由宿主在能回答时一并给出，手机存进配对记录，下次离线也能画。它们是**显示名而不是协议枚举**，客户端不认识的短字符串直接显示即可。缺省（老宿主或无法判断）时手机退回原有的名称/时间副标题，**不得**猜一个系统或产品名。可选字段，老客户端忽略，**不需要升 `PROTOCOL_VERSION`**。

**`host.info` 的 `relay` 与 `relay.set`：按账户把隧道移到付费中继。**
付费账户的隧道应当走主力1（`https://dshmizar-1.shirazu-nagisa.com`），免费账户走主力0（`https://dshmizar.shirazu-nagisa.com`）。host 自己不知道账户是否付费，App 知道，所以由 App 调 `relay.set`：
- `url` 必须是两个公共中继之一（去尾斜杠、只允许 origin）。host 把它持久化在状态目录的 `relay-override.json`，重启后继续使用；配置里写的是自建中继时这两个方法都不提供（老宿主行为）。
- host 先回 `ok`（带着新的 `baseURL`），250 ms 后再断开旧隧道、连新中继；同时在切换前向所有已连接设备广播事件 `relay.changed`，`data` 与返回体同形。手机收到后更新 `PairedHost.baseURL` 并重连。
- `host.info` 的 `relay` 字段是 `{url, room, baseURL}`，`baseURL` 在隧道拿到 room 前为 `null`；老客户端忽略它。
- 切到付费中继后，同一台电脑上**免费账户的手机**会被付费中继的 gate 拒绝，这是预期行为；App 应在账户过期/登出时切回免费中继。
- 纯加法：老宿主没有 `relay.set`/`relay` 字段，老 App 不调用；**不需要升 `PROTOCOL_VERSION`**。

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

**`context` 与增量页一起走（每次刷新都更新上下文占用）。** 增量刷新只回新记录，以前也不顺带 `session.stats`，所以手机上的上下文窗口占用和明细只在全量刷新时更新，跑动中的一轮越跑越旧。现在每一页（全量、增量、向上翻页都算）都带 `context`：插件在读完页之后读一次 `session/projections`，用与 `session.stats` 相同的 `buildContextPressure` 生成 `{window, pressureTokens, projectedTokens, percent, breakdown}`。`null` 表示这台主机没有 `contextPressure` projection（未知），不是 0。手机每次刷新都应把这一帧合并进缓存的 usage 帧并重画占用圈/明细；老插件没这个键时保持旧行为。

**子代理的页（`parentSessionId`）。** DSH 的历史读取按**地址**寻址，而子代理不是一个会话地址：`session/follow` 和 `session/page` 拿到 `{kind:"session", sessionId}` 却读到 `origin: "subagent"` 的日志头时，会在读日志**之前**直接拒绝：

```
session/agent-busy: subagent Sessions require their durable parent address
```

它要的是 `{kind:"subagent", parentSessionId, childSessionId, mode}`。所以手机读子代理的页时必须把 `session.list` 里那一行的 `parentSessionId` 一起带上，插件据此重建地址（`mode` 填 `"unknown"`：列表只有血统、没有委派模式，而 DSH 把 `unknown` 当通配，猜一个反而会换来 `subagent/unauthorized`）。

- **只对 `origin: "subagent"` 传。** 分叉（"branch in a new conversation"）也有 `parentSessionId`，但它是操作者自己的会话，按普通会话寻址，带了父 id 反而是在断言一份不属于子会话的日志。
- **老插件会忽略这个键**，读子代理的页仍然回 `REMOTE_ERROR`（message 里带 `session/agent-busy`）；老手机不发这个键，行为不变。所以这是**纯加法**，不需要升 `PROTOCOL_VERSION`。

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
| `upload.begin` | `sessionId`, `kind`（`image` \| `file`）, `name`, `mediaType`, `byteSize`, `sha256?` | `{uploadId, chunkBytes: 131072}` |
| `upload.chunk` | `uploadId`, `index`（从 0 开始）, `data`（规范 base64） | `{received: index + 1}` |
| `upload.finish` | `uploadId` | `{attachmentId, kind, name, mediaType, byteSize}` |
| `upload.abort` | `uploadId` | `{aborted: true}` |
| `upload.capabilities` | `{}` | `{chunkBytes, imageBytes, fileBytes, promptBytes, attachments, images, expiresSeconds, imageMediaTypes, sha256}` |

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
- **30 分钟 TTL,从起点绝对计时。** 未完成的 upload 从 `begin` 起、已完成的 attachment
  从 `finish` 起,30 分钟后连同 `<stateDir>/uploads/<uploadId>/` 一起删除;重传 chunk
  **不会**续期。插件重启同样会丢弃半成品。过期后的 id 一律按未知处理,客户端重新选
  文件即可。`<stateDir>` 是宿主的 Mizar 状态目录
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
- **暂存资源配额。** 全局最多 **100 个**在传 upload、单设备最多 **10 个**、全局声明字节
  预留最多 **200 MiB**(上传完成即释放,过期由 TTL 清理);超了是 `UPLOAD_LIMIT_REACHED`。
  一部失控的手机占不死桌面,也挤不掉别的设备。
- **声明即校验。** `upload.begin` 可以带 `sha256`(小写十六进制,可选——现网 iOS 不发,
  发了就校验):`finish` 时对落盘字节**整体重读**算摘要,不符是 `UPLOAD_INTEGRITY` 且该
  upload 作废重传。图片在 `finish` 时核对魔数与 `mediaType` 一致(照片在手机端已统一
  转码为 JPEG,不会误伤),不符是 `ATTACHMENT_UNSUPPORTED`。名字拒绝双向格式控制字符
  (`U+202A–E`、`U+2066–9`、`U+061C`);落盘回退副本的文件名会拆掉 Windows 保留设备名
  (如 `com1.txt` → `_com1.txt`)。
- **暂存目录仅当前用户可见。** 两个暂存根在写入第一个字节前完成 ACL 收紧并验证
  (Windows 用系统自带 PowerShell 重置为仅当前 SID 一条规则,POSIX `chmod 0700`);
  失败即拒绝上传,fail-closed。父目录(`<stateDir>` 本身)不动,不提权。
- **`upload.capabilities`。** 宿主把上面这些上限作为能力对象下发;客户端可以继续用
  文档里的固定值,也可以先查询再决定。老宿主对未知方法回 `NOT_IMPLEMENTED`,与其它
  `upload.*` 一致,不影响旧客户端。

`upload.*` 四个方法、`session.prompt` 的 `text` 可选化与 `attachmentIds` 都是**新增**:
老客户端不会调用它们;老宿主对未知方法回 `NOT_IMPLEMENTED`(这正是客户端判断「这台
电脑的插件不支持附件」的信号),新客户端对老宿主仍可走原来的纯文本路径。所以
**没有 `PROTOCOL_VERSION` 升级** —— 只有把已有字段变成必填、改名或改变含义才需要。

### 交付文件与预览

电脑上那张「附带文件」卡片来自模型的 `present` 工具,不是消息结构的一部分。手机要能
预览交付的文件,需要两件东西:一份「这一轮交付了什么」的清单,和一个**下载方向**的读接口
(`upload.*` 是反方向)。

#### 清单:`turn/end` 上的 `mizarDeliverables`

`session.messages` 的摘要会丢弃所有 `tool/call`,所以插件在**整轮完整**的前提下
(与 `mizarTokenUsage` 同一个窗口)把 `present` 的调用提取出来,挂在那一轮的 `turn/end`
的 `data` 上:

```json
{ "type": "turn/end", "seq": 812, "data": {
    "turn": 1,
    "mizarDeliverables": [
      { "path": "docs/report.md", "description": "已更新的根因报告" }
    ]
} }
```

- `path` 是模型写的原文:**相对路径相对会话工作目录**,绝对路径照原样。插件不解析它 ——
  那会把宿主的目录结构带上线,读取时(`file.stat`)才解析并做围栏。
- `description` 可缺,是模型写给操作者的一行说明;桌面端拿它当卡片副标题。
- 同一路径在一轮里被 `present` 两次时,**后一次的描述胜出**;最多 8 条,取最近的 8 条。
- **一轮没有交付任何文件时不写这个键**(不是空数组):它会在每一轮里永远占字节。
- 页面切在一轮中间时没有完整窗口,这一轮就没有清单 —— 与 `mizarTokenUsage`、
  `mizarBranchUnavailable` 完全一致,结束后的下一次刷新会补上。

#### 读取:`file.stat` / `file.read`

| 方法 | payload | 返回 |
|---|---|---|
| `file.stat` | `sessionId`, `path` | `{path, name, byteSize, modifiedAt, mediaType, previewable}` |
| `file.read` | `sessionId`, `path`, `offset`, `length` | `{offset, length, byteSize, data, eof}` |

- **围栏是会话工作目录。** 相对路径相对 `cwd` 解析,绝对路径照用;`realpath` 规范化后
  必须仍在工作目录内。`..` 与指向外部的符号链接因此都被挡住。
- **「外面」只有一个答案。** 不在工作区内的路径一律 `FILE_FORBIDDEN`,无论它是否存在 ——
  「没有这个文件」和「有这个文件但你不能读」对探测者必须是同一句话。
- **凭据形状的名字即使在工作区内也拒**:`.env*`、`*.pem`、`*.key`、`*.p12`、`*.pfx`、
  `*.mobileprovision`、`id_rsa*`/`id_ed25519*`、`.netrc`、`.npmrc`、`.pypirc`、
  `.git-credentials`。模型的输出是不可信输入,一句总结不该成为搬运 `.env` 的通道。
- **`length` 上限 262144(256 KiB)**,base64 后约 341 KiB,在 512 KiB 帧预算内;
  **单文件上限 32 MiB**,与 `upload` 方向一致。`offset + length` 超过文件时按剩余返回,
  `eof` 标出结尾。
- **无状态、幂等**:没有句柄、没有临时文件。断线重连后手机从上次 `offset` 续传。
- `previewable` 是宿主按扩展名(`md`/`markdown`/`pdf`/`docx`)给的提示,手机自己会再判一次。
- 老宿主对这两个方法回 `NOT_IMPLEMENTED`,新客户端据此说「电脑端插件版本过旧」,
  而不是「文件不存在」。纯加法,**不需要升 `PROTOCOL_VERSION`**。

### `requestId` 的语义

`requestId` 是**幂等键**，宿主靠它避免同一条消息被插入两次：

- **同一个 prompt 重试** → 复用同一个 `requestId`，宿主不会重复插入
- **一条新的 prompt** → 必须用新的 `requestId`，否则宿主会把它当成重试而丢弃
- **带附件的 prompt 多一条护栏**：同一个 `requestId` 必须绑定同样的内容（文本、附件
  及其顺序、mode、时区）和同一台设备；换其中任何一个复用旧 id 会得到
  `ATTACHMENT_INVALID`，而不是另一条消息的回执。账本在内存里保留 30 分钟、全局
  1000 条 / 单设备 100 条。

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

## DeepSeek 官方账户余额（可选增量能力）

`host.info` 可附带 `plugin: {id: "dsh-mizar", capabilities: [...]}`。当前列表包括
`deepseek.balance.v1`、`file.read.v1`、`file.deliverables.v1`、`session.activity.v1`、
`session.archive.v1`、`session.fork.v1`、`live-activity.start.v1`、`relay.tier.v1`。
缺少标记、其他插件或旧插件不代表余额为零，客户端不得发起 `account.balance`。
标记只证明插件实现了对应能力，不证明宿主已登录、当前账户有余额或每个会话都可分叉。

`account.balance` 请求：

```json
{"client":{"version":"0.9.5","locale":"zh-Hans","timezoneOffsetSeconds":28800}}
```

宿主先探测原生严格端点 `account/getState` 与 `account/getBalance`，再以 owner peer 调用。
只接受官方 `https://platform.deepseek.com/top_up`（无凭据、端口、query、fragment），
不查询 API-key REST、不依据会话当前 provider/model 推断登录。响应为以下互斥形状：

```json
{"status":"unsupported"}
{"status":"signed-out"}
{"status":"unavailable"}
{"status":"ready","wallets":[{"currency":"CNY","balance":"12.3400"}],"bonusWallets":[{"currency":"CNY","balance":"1e-8"}],"topUpURL":"https://platform.deepseek.com/top_up"}
```

`wallets` 是充值钱包，`bonusWallets` 是赠金钱包；按 CNY/USD 分开展示，不相加、不换汇。
金额是原样十进制字符串（含科学计数法），合法真实 `"0"` 可显示，但非法、缺失或失败绝不默认零。
ready 需要非空充值钱包、合法币种/金额、官方链接，不能仅凭 `credential-stored`。

原生 `getBalance` 自身捕获 credential lifetime，grant 切换时返回 null；Mizar 不读取 grant，
也不自行比较或传输账户身份。ready 返回后仅同步白名单校验并立即返回，**不再 await getState**，
避免在原生 lifetime 检查后扩大 A→B 切换窗口；余额是原生查询时的快照，不承诺后台实时更新。
只有 null/failed 时重新 `getState`：若明确 signed-out 则回 signed-out，否则 unavailable。
无效钱包直接 unavailable，不把切换中临时不可用误报为未登录。
同为 credential-stored 的账号切换隔离只在原生 getBalance lifetime 检查范围内成立，
不是前后状态字符串比较；账户可在快照返回后改变，需要显式刷新获取新快照。
原生状态、attempt、profile、token、凭据及账户身份不进入响应或日志。

客户端断线/换连接立即清空余额；同 host 重连亦为不同连接。每次刷新递增请求代次并清旧值，
旧连接或旧刷新迟到响应不得覆盖新状态。请求异常、解码失败、超时显示失败而非旧余额。
充值入口仅 ready 时显示，打开固定官方网页，不执行充值请求或传递凭据。

### 已结束轮次总结工具栏与分支

`session.messages` 的 `turn/end.data` 可向后兼容携带：

- `mizarTokenUsage`：官方 `deriveTurnTokenUsage` 的精确完整轮次结果（含 `totalTokens`）；只对原始连续 `turn/start` 至 `turn/end` 窗口折叠，缺生命周期、用量或页边界不完整时省略。不是会话累计 meter 的差值，也不估算零。
- `mizarBranchUnavailable`：完整窗口中最后文本总结后有工具活动、非文本回答、重试或错误则为 true；窗口不完整时省略，表示 unknown，不能伪称 blocked 或 safe。同一精确 endSeq 的缓存已证元数据不会被部分页的 unknown 抹掉。旧插件没有此字段时客户端保守禁用并说明需刷新/升级，不假装支持。

`session.fork` 请求必须携带 `{sessionId, atSeq}`，`atSeq` 是所选轮次的真实 inclusive `turn/end.seq`，不是总结 seq、轮次数字或当前最新轮。服务端验证该边界存在、窗口完整及总结之后没有不合法尾部，再调用 DSH `session/fork`；失败绝不省略 atSeq 或改用最新边界。响应 `{sessionId}` 是继承真实上下文的新会话，由现有会话列表/历史/选择流程打开。源会话正在运行不妨碍对合法历史轮次分支。

客户端复制完整原始总结；无总结、运行中或仅推断结束不显示工具栏。token 只读，缺值显示不可用。时间取总结消息时间，本地时区固定24h：今天 `HH:mm`，同年 `M月d日 HH:mm`，跨年 `yyyy年M月d日 HH:mm`；缺时间不可替换为当前时间。分支请求中禁用连点；切换源会话、主机或连接后迟到响应不得强制导航。

