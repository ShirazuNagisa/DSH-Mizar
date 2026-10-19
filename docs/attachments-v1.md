# 认证附件扩展 v1

本扩展让实现相应协议的手机客户端把图片/文件交给电脑 DSH。它是 Mizar v1 的增量，不改原文字请求，不改 DSH 核心、不新增 HTTP 上传路由、不要求改变 Relay 源码。Android 配套实现：[DSH-Mizar-Android PR #1](https://github.com/ShirazuNagisa/DSH-Mizar-Android/pull/1)。其他客户端必须自行实现此扩展，安装主机插件不会自动增加手机按钮。

此独立电脑插件改动不包含 Android 镜像的 `turn.settled`、断线通知补发或手机界面代码。保留仓库现有版本号与 GPL-3.0-only 声明；发版由维护者决定。

## 调用约定

所有 RPC 经过原有已认证 WebSocket，信封保持 `{v:1,type,id,payload}`，结果仍由 `ok`/`error` 帧返回。设备身份来自连接，不能由 payload 指定。

| 方法 | payload | result |
|---|---|---|
| `attachment.capabilities` | `{}` | 下文能力对象 |
| `attachment.begin` | `{sessionId,name,bytes,sha256,kind,mediaType?}` | `{uploadId,chunkBytes,offset:0}` |
| `attachment.chunk` | `{uploadId,offset,data}` | `{offset}`，表示下一个应发送的字节位置 |
| `attachment.finish` | `{uploadId}` | `{attachmentId,name,bytes,kind,mediaType?}` |
| `attachment.abort` | `{uploadId}` | `{aborted:true}` |

能力对象：

```json
{
  "version": 1,
  "maxFileBytes": 20971520,
  "maxImageBytes": 20971520,
  "maxAttachments": 5,
  "chunkBytes": 65536,
  "expiresSeconds": 1800,
  "imageMediaTypes": ["image/png", "image/jpeg", "image/webp", "image/gif"]
}
```

图片上限会随已组合的 DSH 附件服务降低。客户端必须遵守返回值，不能假定固定20MiB。旧宿主或未组合文件上传服务时，能力查询返回 `NOT_IMPLEMENTED`，应提示用户更新/启用相应宿主，不能假装上传成功。

### 开始与分块

- `kind` 仅 `image` 或 `file`；`bytes` 是正整数，`sha256` 是原始完整字节的小写64位十六进制摘要。空文件不接受。
- 图片须给合法 `mediaType`；普通文件不接受该字段。
- `name` 仅展示用叶名称，最多240 UTF-8字节，拒绝路径分隔符、控制/双向字符、Windows保留名和非法文件名字符。它不决定实际落盘路径。
- `data` 是规范带padding的Base64，每块解码后最多 `chunkBytes`。按已确认offset顺序发送。
- 最近一块的完全一致重试幂等；乱序、冲突或更早块重放被拒绝。响应丢失时重发同一块，不自行前移offset。
- `finish` 检查长度与SHA256（含重新读盘校验），图片还检查签名；最终完整图片解码/像素与模型能力检查由 DSH admission 完成。
- 重复 `finish` 返回相同metadata；`uploadId` 与 `attachmentId` 是不同的不透明标识。
- 同设备断线重连可继续使用未过期上传；插件进程重启后失效。

### 随消息提交

```json
{
  "sessionId": "target-session",
  "text": "",
  "requestId": "client-generated-stable-uuid",
  "attachments": ["opaque-ready-attachment-id"]
}
```

最多5个不同的附件ID，全部必须已完成并归属当前设备和目标会话。不能提交手机提供的主机路径、DSH receipt、图片Base64内容块等绕过上传校验。主机按客户端的附件顺序生成 DSH prompt parts。

- 文件走实际 `fileUploads.uploadStream()`，只使用它返回的receipt。
- 图片按 `{type:'image',mediaType,data,name}` 交给 DSH 的图片接纳与规范化流程。模型不支持图片会返回错误。
- `requestId` 在发送前固定；相同请求重试共用结果，改变文字、附件顺序、mode、时区或设备再复用该ID会拒绝。
- 失败/结果不确定时保留暂存与已生成的receipt供原请求重试。不要用新ID盲目重发，以免产生重复消息。
- DSH确认接纳后，缓存成功结果并清理该请求的本地暂存、释放配额；重试由缓存返回，不需要已清理的附件。另一个新请求要重用同一文件需重新上传。
- 普通文字请求仍走原路径，不受附件请求缓存的100条/设备限额影响。

## 错误

新增 `UPLOAD_NOT_FOUND`、`UPLOAD_EXPIRED`、`UPLOAD_TOO_LARGE`、`UPLOAD_LIMIT_REACHED`、`UPLOAD_OFFSET_MISMATCH`、`UPLOAD_INTEGRITY`、`ATTACHMENT_INVALID`，沿用 `MALFORMED_FRAME`/`NOT_IMPLEMENTED`/`REMOTE_ERROR`。

外设备ID与不存在的ID不泄露额外身份信息。未知upload的abort幂等，外设备实际upload不能删除。DSH的 `session/attachment-invalid` 映射为 `ATTACHMENT_INVALID`。

## 安全与资源边界

- 随机私有临时目录及随机独占文件，手机文件名从不参与路径拼接；不自动执行或打开文档。
- POSIX目录0700/文件0600。Windows仅对新建目录设置当前用户SID的受保护继承规则；不改TEMP父目录，不使用管理员提权。保护失败则在写入附件前拒绝启动。
- 单件最大20MiB、5件/prompt、全局200MiB预留、全局100个活跃上传、每设备10个；失败清理会保留占额直至真正删除。
- 上传从begin起绝对30分钟过期，不被重试延长；每分钟清理。每个上传操作串行，多个附件按稳定顺序加锁。
- WebSocket输入最大512KiB，每连接最多8个同时执行的方法；64KiB分块的Base64帧小于该值。
- 附件消息最多全局2个、单设备1个并发admission，控制DSH图片Base64所需内存。
- 请求成功/失败缓存有TTL与数量上限；持久化后的文件/receipt生命周期交给DSH，不手动删除DSH存储。
- 可选服务使用Cordis实际支持的 `ctx.get` 查询，不错误地声明 `{required,optional}` 注入形状；原静态依赖保持不变。

**限制**：强制结束进程或断电不能执行清理，可能留下受保护的临时目录；正常退出/TTL清理有测试覆盖，不会在启动时广泛删除别的进程目录。暂存与幂等内存缓存不跨进程重启；DSH的持久消息幂等仍是最终防重保障。

## Relay 与验证范围

已在原版Relay源码本地测量到900KiB单帧上限；本扩展64KiB块能在该限制下传输20MiB文件。公共服务器此前只返回HTTP429，**未测出公共部署的大小/带宽上限**，不能用本地结果替代线上保证。

TLS中继不是端到端加密。附件同样经过中继运营者可读取的连接；敏感用途应使用可信VPN或自建中继。

运行：

```sh
npm ci
npm run build
npm run typecheck
npm test -- --maxWorkers=2
```

新增测试覆盖字节/摘要/签名/路径与身份、配额/过期/并发/失败清理、重复请求、DSH桥接、真实WebSocket与Cordis装配。模拟DSH边界的单元测试不等于真实模型理解文件；真实宿主验证使用隔离profile和离线测试模型，不向付费模型发送数据。测试结果见 [附件验证记录](attachments-validation.md)。
