# DSH Link v1

`dsh-mizar` 0.9.0 与 AGI Mizar 桌面端之间的线协议。

**一句话**：一条回环 WebSocket，**插件是客户端**。插件不开端口、不配对、不保存设备。
桌面端没运行时，插件等价于没装。

- 传输：`ws://127.0.0.1:<port>/dsh`
- 地址来源：`~/.agi-mizar/endpoint.json`（桌面端每次启动重写，令牌每次重新生成）
- 版本：`v: 1`，独立于 DSH 与 Mizar v1 的版本

---

## 为什么是这个方向

0.8.x 的插件是服务端：它监听 19390、发配对码、存设备令牌、连中继。这些能力现在全部归桌面端，
理由见 [`agi-mizar-plan-2026-10-27.md`](../../docs/agi-mizar-plan-2026-10-27.md)。

拨出去换来三件事：

1. **没有入站面**。插件不监听，防火墙、端口冲突、局域网暴露都不存在。
2. **"桌面端不在"是一个状态，不是一个配置错误**。socket 关着就是关着。
3. **桌面端可以随便重启**。换端口、换令牌都只是让插件重拨一次。

---

## 握手

```jsonc
// 插件 → 桌面
{ "v":1, "type":"hello",
  "token":"<endpoint.json 里的 token>",
  "plugin":{ "name":"dsh-mizar", "version":"0.9.0", "linkVersion":1 },
  "dsh":{ "platform":"darwin", "home":"/Users/…", "node":"v22.22.2" },
  "endpoints":["session/list","session/follow","…"],
  "services":["workspaceRegistry","sessions","sessionProjections"] }

// 桌面 → 插件
{ "v":1, "type":"welcome", "linkVersion":1, "desktop":"AGI Mizar 0.1.0" }
```

- 桌面端在 **5 秒**内没有回 `welcome`，插件断开重拨（会重新读 endpoint 文件，所以换端口能被发现）。
- `linkVersion` 不等于 1 时插件主动断开并记一行日志。
- `endpoints` 是**已注册的 descriptor**，桌面据此知道这台 DSH 有什么。插件不认识这些方法的名字含义。
- `services` 是本次运行允许代理的进程内服务名。

---

## 事件（插件 → 桌面）

```jsonc
{ "v":1, "type":"event", "seq":1042, "at":"2026-10-27T…",
  "sessionId":"session-…", "name":"session/event",
  "payload":{ "header":{…}, "event":{…} } }

{ "v":1, "type":"event", "seq":1043, "at":"2026-10-27T…",
  "sessionId":"session-…", "name":"projection/changed",
  "payload":{ "key":"title", "value":"…", "seq":87 } }
```

- **`seq` 跨会话单调递增**。桌面发现缺口就重新读一次（`invoke session/follow` 或 `session/page`）。
- `payload` 里的东西**原样来自 DSH**：不投影、不改写、不丢字段。
  `toWire()` 只做 JSON 能做的转换（去掉 `AbortSignal`、bigint 转字符串、Error 取 name/message/stack）。
- 两个来源：
  - `session/event` —— 提交后的追加日志，无作用域，子代理与分支也在内；
  - `projection/changed` —— 某个投影单元变化（列表上的运行中标记、标题）。
- 还没提交的流式增量不在这两条里。桌面要画正在跑的一轮时，自己开 `invoke session/follow`（流模式）。

---

## 调用（桌面 → 插件）

```jsonc
// 任意已注册端点
{ "v":1, "type":"invoke", "id":"c1",
  "endpoint":"session/list", "args":{ "_request":{} }, "mode":"unary" }

// 流式端点
{ "v":1, "type":"invoke", "id":"c2",
  "endpoint":"session/follow", "args":{ … }, "mode":"stream" }

// 进程内服务（没有 Typert endpoint 的那些）
{ "v":1, "type":"service", "id":"s1",
  "service":"workspaceRegistry", "method":"list", "args":[] }
```

结果：

```jsonc
{ "v":1, "type":"result", "id":"c1", "ok":true,  "value":{ /* 原样 */ } }
{ "v":1, "type":"result", "id":"c2", "ok":false,
  "code":"gateway/input-invalid", "message":"…", "details":{ /* 原样 */ } }

{ "v":1, "type":"stream.item", "id":"c2", "value":{ /* 原样 */ } }
{ "v":1, "type":"stream.end",  "id":"c2", "reason":"done" }   // done | cancelled | failed
```

- **错误码不映射**。DSH 的 `code`、`message`、`details` 原样过线；插件只给没有 code 的失败补一个
  `REMOTE_ERROR`。桌面端读 DSH 的代码，不需要第三套词汇表。
- `args` 按 descriptor 的命名传（`session/list` 用 `_request`，`session/prompt` 用 `request`）。
  插件不解析、不改名——这正是"DSH 加端点不用改插件"的机制。
- 取消：`{ "v":1, "type":"cancel", "id":"c2" }`。

### 服务白名单

默认：`workspaceRegistry`、`sessions`、`sessionProjections`、`userApproval`、`userQuestions`。
不在名单里、没被组合、名字以 `_` 开头、或不是函数 → `LINK_REFUSED`。
名单可在插件配置 `services` 里加，**不需要换版本**。

---

## 交互（双向）

```jsonc
{ "v":1, "type":"approval", "id":"ap-…", "request":{ /* DSH 原样 */ } }
{ "v":1, "type":"question", "id":"qs-…", "request":{ /* DSH 原样 */ } }

// 桌面 → 插件
{ "v":1, "type":"answer", "id":"ap-…", "outcome":"allowed-once" }  // 或 rejected
{ "v":1, "type":"answer", "id":"qs-…", "answers":[ { "id":"q1", "selected":["a"] } ] }
```

`request` 里的 `signal` 是 `AbortSignal`，不能过线，由 `toWire` 丢弃；插件本地留着它做取消。

### 三条必须保持的语义

| 规则 | 为什么 |
|---|---|
| 桌面没连 → 纯透传（`next()`） | 不改变 DSH 任何既有行为 |
| `prepend: true` | 否则永远排在 GUI 后面，等于永远轮不到 |
| 掉线 → 挂起审批结算 `unavailable`、提问结算空 | 拒绝一次工具调用可恢复，吊死 agent 不可恢复 |

审批只有 `allowed-once` / `rejected` 是客户端可选；`cancelled` / `unavailable` 是宿主侧结果。
提问答复必须把这一批里每个问题各点一次名，否则 `LINK_REFUSED`（避免 DSH 整批丢弃）。

重连时插件会重发所有仍挂起的请求（同 id），所以桌面不需要"列出挂起项"的方法。

---

## 过滤

```jsonc
{ "v":1, "type":"filter", "drop":["assistant/attempt"] }
```

**默认不过滤**。全量是默认，省流是桌面端的决定；插件只按事件名丢弃，不看内容。

---

## 版本演进

- 新增可选字段：不升版本，旧桌面忽略。
- 新增帧类型：旧插件 `parseDesktopFrame` 返回 `null` 并忽略该帧，不断连接。
- 改动已有字段含义、或让新字段变成必填：升 `linkVersion`，插件主动断开并记日志。

插件把 `linkVersion` 与 `plugin.version` 都在握手里报出去，桌面端可以据此给"插件版本旧"的准确提示。
