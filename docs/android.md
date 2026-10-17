# Android 客户端

同一套 Mizar 协议的第二个客户端：手机看 DSH agent 干活、发消息、回答审批。协议本身在
[docs/protocol-v1.md](protocol-v1.md)，中继在 [docs/relay-deployment.md](relay-deployment.md)。

## 目录

```text
Android/
  mizarkit/   纯 Kotlin/JVM：帧、配对、连接状态机、会话投影、缓存接口、诊断
  app/        Compose 界面、Firebase Messaging、通知、加密存储
```

`mizarkit` 不带任何 Android 依赖，理由和 iOS 侧把 MizarKit 做成 Swift Package 一样：
协议测试要能在 JVM 上秒级跑完，而不是每次都过一遍模拟器。

## 构建环境

| 项 | 位置 / 版本 |
|---|---|
| Android SDK | `E:\Projects\Environment\android-sdk`（cmdline-tools + platform-tools + platforms;android-35 + build-tools;35.0.0） |
| Gradle | 8.11.1（wrapper 已提交；本机发行版在 `E:\Projects\Environment\gradle`） |
| JDK | 17（`C:\Program Files\Microsoft\jdk-17.0.12.7-hotspot`）。AGP 8.7 不接受本机默认的 JDK 23 |
| `GRADLE_USER_HOME` | `<checkout>/.gradle-home`（已 gitignore），其中 `gradle.properties` 固定 JDK 17 |

`Android/local.properties` 里的 `sdk.dir` 是本机路径，不提交。

```sh
# 测试（纯 JVM，秒级）
./gradlew :mizarkit:test

# 打 debug 包
./gradlew :app:assembleDebug      # → app/build/outputs/apk/debug/app-debug.apk
```

### 本机特有的三件事

1. **依赖镜像**：`.gradle-home/init.d/mirrors.init.gradle` 把阿里云的 Maven Central /
   Google / Gradle Plugin 三个镜像**前置**到仓库列表里（实测 Maven Central 约
   140 KB/s，阿里云约 6.7 MB/s，而 Kotlin 编译器一个 jar 就 57 MB）。缺件仍会回落到官方源；
   因为它在 `GRADLE_USER_HOME` 里，仓库自身的构建文件保持原样。
2. **wrapper 发行版**：`services.gradle.org` → `github.com` 这条链路在本机只有 ~28 KB/s 且
   JVM 端证书校验会失败（Windows 根证书里有、JDK cacerts 里没有），所以 wrapper 的发行版是
   预先放进 `$GRADLE_USER_HOME/wrapper/dists/gradle-8.11.1-bin/<hash>/` 的。清掉缓存后
   `gradlew` 会去下载，需要镜像或代理。
3. **buildToolsVersion 固定为 35.0.0**：AGP 默认会去抓 34.0.0，而那次下载在本机卡在 0 字节。

## 与真实宿主对跑

```sh
# 1. 起一个 dev 宿主（见 README 的 `scripts/dev.mjs`），日志里会打印配对码和监听地址
# 2. 用日志里的地址和配对码跑客户端
./gradlew :mizarkit:hostCheck "-Pbase=http://192.168.100.1:19390" "-Pcode=ABCD-EFGH"
```

它做的事和 `scripts/smoke-listener.mjs` 同层：hello → pair → 握手 → `session.list` →
`workspace.list` → `session.messages` → `session.create` → `session.prompt`（带幂等键）→
`interactions.pending` → `model.catalog` → `permissions.catalog` → `session.cancel`。

**地址要选对**：插件默认 `bind.mode: lan`，只绑非内部 IPv4 地址，**不含 `127.0.0.1`**。
本机自测要用它日志里 `listening on …` 列出的地址之一。

## FCM 推送

`Android/app/google-services.json` 是可选的，且已 gitignore：

- **有它**：google-services 插件被应用，App 拿到 FCM token，连上宿主后发
  `push.register {token, platform:"android", locale}`，并在 `onNewToken` 时更新存储。
- **没有它**：插件不应用，App 照常构建运行，只是 `PushTokens.current()` 返回 null，
  推送不激活。这是刻意的：一个必须先在 Firebase 建项目才能编译的 App 是谁都试不了的 App。

中继侧要配 `fcm` 服务账号才真正发得出去，见
[docs/relay-deployment.md 第 10 节](relay-deployment.md)。iOS 与 Android 在同一间房里各走各的
通道：`push.register` 的 `platform` 字段决定这一点，缺省是 `ios`，所以现有 iOS 客户端与已部署
的中继不需要任何改动。

## 平台决定

- **明文 `ws://`**：宿主地址是配对时才知道的，Android 无法预先声明例外，所以
  `usesCleartextTraffic="true"`——和 iOS 的 `NSAllowsArbitraryLoads` 是同一个决定、同一个理由。
  真正的解法是监听器上 TLS，那还是宿主侧的待办。
- **targetSdk 35**：Android 16 的局域网访问保护（`ACCESS_LOCAL_NETWORK`）在目标 36 时才需要
  显式申请，这里先避开并记一笔。
- **没有前台服务**：iOS 客户端也没有后台模式，Android 侧不做「保活」这种不对等的功能。
  息屏久了长连接会被系统收走，重新打开 App 即可；推送是后台唯一的通道。
- **Doze 与厂商省电**：FCM 的到达时间与长连接的存活都受它们影响。App 在每次回到前台时重连并
  重新拉取会话，所以「回来就有」而不是「回来等一会」。
- **状态目录**：凭据用 Keystore 支撑的加密存储（一份 blob、先更新后新增），
  会话列表索引是一台宿主一个 JSON 文件。**不做内存降级**——静默退回内存会让配对看起来成功、
  下次启动消失。

## 与 iOS 客户端的差异（刻意的）

| 位置 | iOS | Android |
|---|---|---|
| 连接失败的说法 | `ConnectionDiagnosis` 直接给出英文句子 | 给出**结构化的判定**，由 App 映射到本地化文案；未本地化时才回落到英文 |
| `RESPONSE_TOO_LARGE` | 未建模 | 在错误码表里 |
| 令牌失效 | `requiresRepairing` 从未被使用 | 清除本地凭据并回到配对 |
| 工作区标题 | 由路径推导 | 仍由路径推导（`workspace.list` 的 title 留作后续改进） |
| Markdown | `AttributedString(markdown:)` 两段回退 | 自研小解析器 + 未闭合围栏规则，`plain` 作为最后回退 |

**两处已知的协议解析差异**（`PairingUri` 逐字节对齐的是**面板**那一侧，即 TypeScript）：

1. 查询串用 `application/x-www-form-urlencoded` 编码，空格是 `+`；Swift 的 `URLComponents`
   给的是 `%20`。两端解析自己那侧写出的 URI 都没问题，互相解析会差一个字符。
2. `v=`（存在但为空）在 TypeScript/Kotlin 侧解析为 `0`，Swift 侧是 `nil`。面板永远写合法整数，
   所以这条不可达，但它是**被测试钉住的决定**而不是意外。

## 已验证 / 未验证

在 Windows 上已验证：`:mizarkit:test` 全绿（黄金帧 + 从 Swift 逐条移植的契约测试）、
`:app:assembleDebug` 产出 APK、`:mizarkit:hostCheck` 对真实 dev 宿主 23 项全过（配对 → 握手 →
会话 → 投影 → 建会话 → 发消息 → 目录 → 取消）。

未验证：真机安装与真机上的交互（需要一台 Android 手机）、FCM 真机推送（需要 Firebase 项目与
配置了 FCM 的中继）、扫码（需要相机）。

## 断线与可见性（真机实测补记）

- **自动重连**：客户端订阅连接的 `State.Failed`，按 `Backoff.standard`（0.5→10 秒，6 次）自动重拨；
  期间 `phase` 保持 READY，只在屏幕顶部显示「重新连接中…」+ 断开原因，成功后重新上报 presence。
- **兜底轮询 10 秒**（原 45 秒）：这是兜底不是机制，事件（`interactions.changed` 等）才是主路径。
- **待办卡片在列表页也显示**：此前只画在会话页，操作员停在列表时完全看不到 agent 正被阻塞。
- **Windows 主机**：会话/工作区标题按 `/` 和 `\` 双分隔符取末段（此前 Windows 路径会整条显示）；
  相对时间用系统 `DateUtils`（中文环境显示「1 分钟前」而不是 "1m ago"）。
