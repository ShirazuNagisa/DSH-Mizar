# Android 客户端（与本仓库的 iOS 线是两个不同项目）

这里是一加 12 上验证过的 **Android 客户端**：`mizarkit/`（纯 JVM 协议核心，可脱离 Android 测试）
与 `app/`（Compose 界面、扫码、通知、加密存储）。它消费的是本仓库的**主机插件**，但对端是
Android 而不是 iOS，界面、存储、推送（FCM 而非 APNs）与 iOS 版互不复用。

- 构建与真机对跑步骤：[../docs/android.md](../docs/android.md)
- 与 iOS 的已知差异（含配对 URI 的 `+`/`%20` 等）同样记在那份文档里
- 目录名保持 `Android/`（大写），与仓库根的 `iOS/` 并列；**不要把两边的源码混在一起**
