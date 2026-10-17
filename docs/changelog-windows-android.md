# Windows 主机支持 + Android 客户端(CHANGELOG 存档)

**来源**:`windows-android` 分支(HEAD `2eb709a`,2026-10-17)的 `CHANGELOG.md`,逐字保留。
该分支对应 [PR #1](https://github.com/ShirazuNagisa/DSH-Mizar/pull/1),**未合并**即关闭;
内容已按拆分后的仓库结构分别落地,分支已于 2026-10-17 删除,此文件是它留在本仓库的记录。

落地位置:

| 内容 | 现在的家 |
|---|---|
| Windows 测试可移植性、真实提问载荷、`push.register` 的 `platform` | 本仓库 `main`(`e91ac62` / `5f1aa01` / `3e2da30`) |
| FCM(与 APNs 并存、按 `platform` 路由) | `DSH-Mizar-Relay` 的 `6e2cad5`;文档在该仓库 `docs/deployment.md` 第 10.3 节 |
| Android 客户端(`mizarkit` + Compose app) | `DSH-Mizar-Android` 仓库 |
| `docs/android.md`、`docs/relay-deployment.md`、`docs/testflight.md`、`docs/screenshots/` | 未带到本仓库;Android 文档在 Android 仓库,中继文档在 Relay 仓库 |

分支基于 v0.7.2 之前的提交,与 `main` 双向分叉;下文最后一节的合并注意事项已随分支关闭而不再适用,保留仅为记录。

---

## CHANGELOG(原文)

# Changelog

Entries are grouped by the release they ship in. This branch started from the commit before
**v0.7.2** and adds Windows host support plus the Android client, so merging it into `main`
means reconciling it with v0.7.2's summary pipeline (see the end of this file).

## Unreleased — Windows 主机支持 + Android 客户端

### 主机插件

- **Windows 可用**：插件在 `E:\\…` 路径下正常挂载、监听、转发。三处把平台或区域当输入的断言
  （`test/i18n.test.ts`、`test/panel-render.test.tsx`、`test/store.test.ts`）改成与平台无关；
  `scripts/dev.mjs smoke` 111/0、`vitest` 全绿、`:mizarkit:test` 201/0 均在本机（Windows 11）实测。
- **真实提问载荷修复**：真实宿主的 `user-questions/request` 是扁平的 `{ questions, agent, signal }`，
  **没有 `callId`，也没有 `wait`**。`readQuestionRequest` 现在接受该形状，并在宿主未给 id 时
  mint 一个 `mizar-<uuid>`（宿主若给了 `wait.callId` 则优先用宿主的，迟到作答依赖它）。
  修复前这类请求返回 `null` 并被静默委托，桥接永不登记 —— 手机永远看不到真实提问。
  原有测试全部通过却漏掉它，因为 fixture 里带着宿主并不发送的 `callId`；本次新增了真实载荷的黄金用例。
- 审批路径不变，真机验证通过（手机点「允许一次」→ 工具真的执行，`approval-test.txt` 生成）。

### 中继

- 新增 **FCM**（`relay/src/fcm.ts`）：RS256 JWT 断言 → OAuth2 令牌（缓存约 55 分钟）→ `messages:send`，
  含错误映射；与既有 APNs 并存，按设备 `platform` 路由。
- `push.register` 的 `platform` 缺省为 `ios`（旧客户端行为不变），`environment` 仅 iOS 必填，
  未知平台返回 `MALFORMED_FRAME`。

### Android 客户端（新目录 `Android/`）

- `Android/mizarkit`：纯 JVM 协议核心（帧、配对 URI、连接状态机、退避、会话投影、Markdown、诊断），
  197→201 项测试；`Android/app`：Compose 客户端（会话/对话/审批与提问卡、模型与权限选择器、
  扫码、通知、加密存储、中英文资源）。
- 断线自动重连（`Backoff.standard`），租约失效时改为「重新配对」而不是无限重试；
  交互卡片在会话列表页也显示；兜底轮询 45 s → 10 s。
- 与 iOS 分支是两个不同项目：目录并列、互不复用源码，说明见 `Android/README.md`。

### 文档

- 新增 `docs/android.md`（构建环境、真机对跑、Windows 主机、与 iOS 的差异）。
- 更新 `docs/windows-status.md`（Windows 实测结论、把插件装进 live profile 的步骤）、
  `docs/decision-0002-approval-arbitration.md`（真实载荷形状与客户端数为 0 的结算规则）、
  `docs/protocol-v1.md`（`platform` 字段）、`docs/relay-deployment.md`（FCM）。

## 与 v0.7.2 合并时的注意事项

v0.7.2 重写了会话摘要（「ship summaries instead of transcripts」）并引入工作区接口。本分支的
`readQuestionRequest` 修复与 FCM 各自独立于该重写；`src/bridge/index.ts`、`test/bridge.test.ts`、
`relay/*` 需按 v0.7.2 的结构重新落一次冲突解决。
