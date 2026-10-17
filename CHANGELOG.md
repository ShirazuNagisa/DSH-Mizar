# Changelog

## Unreleased — Windows 主机支持 + Android 客户端

### 插件（主机侧）

- **Windows 主机可用**：插件在 `E:\…` 这类 Windows 路径下正常挂载、监听与转发；`smoke`（111 项）、
  `vitest`（405 项）、`:mizarkit:test`（201 项）在本机全绿。三处把平台/区域当输入的断言
  （`test/i18n.test.ts`、`test/panel-render.test.tsx`、`test/store.test.ts`）已改为与平台无关。
- **真实提问载荷**：`user-questions/request` 在真实宿主上是扁平的 `{ questions, agent, signal }`，
  **没有 `callId`**。`readQuestionRequest` 现在接受它，并在宿主未给 id 时 mint 一个 `mizar-<uuid>`
  （宿主给了 `wait.callId` 时优先用宿主的）。修复前该类请求被判 `null` 并静默委托，手机永远看不到提问。
- **审批路径**保持原样并通过真机验证（手机点「允许一次」→ 工具真的执行）。

### 中继

- 新增 **FCM** 客户端（`relay/src/fcm.ts`）：RS256 JWT 断言 → OAuth2 → `messages:send`，
  令牌缓存 ~55 分钟；与既有 APNs 并存，按设备 `platform` 路由。
- `push.register` 的 `platform` 字段：缺省 `ios`（旧客户端不受影响），iOS 才要求 `environment`，
  未知取值返回 `MALFORMED_FRAME`。

### Android 客户端

- 新增 `Android/`：`mizarkit` 协议核心（197→201 项测试）+ `app` Compose 客户端。
  含断线自动重连（`Backoff.standard`）、交互卡片（列表页也会显示）、10 秒兜底轮询、
  租约失效时改为「重新配对」而不是无限重试、中英文资源、Windows 主机措辞。
