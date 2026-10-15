# DSH-Mizar

**远程监控并指导 DSH Agent 工作。** 一个 DSH 插件 + 一个 Swift 原生 iOS/iPad App。

> **当前状态：Phase 0–5 完成，Phase 6 进行中。**
>
> | 部分 | 状态 |
> |---|---|
> | 宿主插件（TypeScript） | ✅ 监听、配对与吊销、鉴权 WebSocket、会话读写、模型与思考强度、权限预设、用量与上下文、审批与提问（**主动推送**）、自动绑定网卡、Tailscale 静默拉起 |
> | Web 面板 | ✅ 绑定地址、配对二维码、设备名册 |
> | MizarKit（协议层） | ✅ 帧、连接与重连、配对、Keychain、消息记录解析 |
> | iOS / iPad App（SwiftUI） | ✅ 工作区选择、会话列表、对话正文、用量与缓存命中率、模型/思考强度/权限切换、审批与提问（宿主主动推送）、输入与打断、中英双语跟随系统 |
> | 反向隧道中继（`relay/`） | ✅ 房间隔离、请求重放、WebSocket 桥接、端点探测；**已在本地测试，尚未部署到真实服务器** |
| 发布 | ✅ 已归档、签名、导出 TestFlight 包（v0.1.0） |
> | Windows | ⚠️ **代码检查通过，但从未运行过** —— 见 [Windows 状态](docs/windows-status.md) |
>
> **测试：370（插件）+ 62（中继）+ 96（Swift）+ 11（iOS UI）+ 111（真实链路冒烟断言）。**
> iOS UI 中有 1 个已知失败，见文末「已知问题」。
>
> 关键设计结论：[0001 进程内网关](docs/decision-0001-in-process-gateway.md)、
> [0002 审批仲裁](docs/decision-0002-approval-arbitration.md)。
> 发布步骤：[TestFlight](docs/testflight.md)、[中继服务器部署](docs/relay-deployment.md)。

---

## 安装

```bash
# 从仓库地址（推荐）
dsh plugin --profile <profile> add ShirazuNagisa/DSH-Mizar

# 或用完整 URL
dsh plugin --profile <profile> add https://github.com/ShirazuNagisa/DSH-Mizar

# 或从 Release 的 tarball
dsh plugin --profile <profile> add \
  https://github.com/ShirazuNagisa/DSH-Mizar/releases/download/v0.1.0/dsh-mizar-0.1.0.tgz
```

装完重启 DSH，侧边栏会出现 **DSH-Mizar** 面板，里面显示监听地址和配对二维码。

**手机端**要另装 —— 见 [TestFlight 发布步骤](docs/testflight.md)。两端都装好并且在同一
网络里，App 才能用。

---

## 它做什么

DSH 桌面版本只监听 `127.0.0.1`，并且**明确拒绝**绑定到 `0.0.0.0`（官方理由：那会把
"在 Mac 上执行任意代码"的能力暴露给整个网络）。所以手机默认根本连不上。

DSH-Mizar 的做法是反过来：**插件自己开一个独立监听端口**，不碰 DSH 原有的安全边界，
然后在手机与 DSH 宿主服务之间做一层适配。

```text
┌─ iPhone / iPad（Swift 6 / SwiftUI / iOS 18+，Xcode 27 SDK 构建）─┐
│  MizarKit：协议模型 · WSTransport · Keychain · 配对 · 断线续传     │
└──────────────────────────┬────────────────────────────────────────┘
                  Tailscale 私有网络（WireGuard 端到端加密）
                           │  ws://<magicdns>:19390/mizar/v1/ws
┌──────────────────────────▼────────────────────────────────────────┐
│ dsh-mizar 插件（宿主半，TypeScript，零原生依赖，跨 macOS/Windows）  │
│  ① 独立监听器 node:http + ws（自选网卡 · 可配端口 · 可选 TLS）      │
│  ② 配对码 → 设备令牌 → 可吊销的设备名册 + 审计日志                  │
│  ③ Bridge：DSH 宿主服务 → 移动端友好的扁平帧                       │
│  ④ waterfall 审批/提问应答器（与 Mac GUI 先答者胜）                 │
│  ⑤ 客户端半：Web 面板显示二维码 · 绑定地址 · 设备名册               │
└──────────────────────────┬────────────────────────────────────────┘
  进程内调用：ctx.typertGateway · ctx.sessionProjections · ctx.sessions
             · ctx.workspaceController · ctx.permissionPresets
             · ctx.userApproval · ctx.userQuestions · ctx.commands
```

**关键接缝决策**：iPhone 只说 Mizar 协议，不说 DSH 的 Typert 协议。DSH 内部 140 个
endpoint 的复杂度、`SessionHistoryRecord` 与 40+ 会话事件变体的投影工作，全部由插件
在服务端一次性完成。这样 DSH 升 RC 版本时只需改插件的 Bridge，App 不受影响。

---

## 仓库结构

**仓库根目录就是插件包。** 这不是风格选择：DSH 装仓库地址时，是把整个仓库当作一个包
交给 pnpm 克隆的——**它不会去找子目录，也不会替你构建**。根目录没有 `package.json`
就装不上，`lib/` 不在仓库里就没有可加载的代码。

```
DSH-Mizar/                     ← 插件包根目录（package.json 在这里）
├─ package.json                # 插件清单：main · dsh.bundle.patch · dsh.client
├─ cordis.patch.yml            # 宿主半的装配补丁
├─ src/                        宿主半：index · config · ready · net · auth · bridge · server · panel
├─ client/                     浏览器半：esbuild 封装器 + 面板
├─ lib/                        **已提交的构建产物** —— 装的时候不需要构建步骤
├─ test/                       vitest（323）
├─ tsconfig.json · vitest.config.ts
├─ docs/
│  ├─ decision-0001-in-process-gateway.md   # Phase 0.1 结论（必读）
│  ├─ decision-0002-approval-arbitration.md
│  ├─ protocol-v1.md                        # Mizar 协议规范
│  ├─ tailscale-setup.md                    # 网络方案与取舍
│  ├─ testflight.md                         # 如何发布到 TestFlight
│  ├─ windows-status.md                     # Windows：什么验证过、什么没有
│  └─ screenshots/                          # 各界面实机截图
├─ protocol/fixtures/           从真实宿主捕获的黄金帧（两端共读）
├─ iOS/
│  ├─ MizarKit/                  Swift 包：协议层 + 单元测试（76）
│  ├─ DSH-Mizar/                 SwiftUI App
│  ├─ DSH-MizarUITests/          XCUITest（11）
│  ├─ DSH-Mizar.xcodeproj/       手写 pbxproj
│  └─ ExportOptions.plist
└─ scripts/                      dev · ios · swift · release · mock-host · smoke-listener
```

> **为什么 `lib/` 进了版本库？** 从 git 地址安装时，pnpm 克隆仓库后**没有构建步骤**，
> 除非包里有 `prepare` 脚本——而那需要网络拉编译器。把编译结果提交进去，安装就是
> 纯粹的复制，不需要 TypeScript、不需要 esbuild、不需要联网装 devDependencies。
> 代价是 `lib/` 可能落后于 `src/`：**改完源码一定要 `npm run build` 再提交**。

---

## 开发

所有开发状态都在本仓库内：DSH 以**工作区内的 `DSH_HOME`**（`.devhome/`）运行，
你的真实 `~/.dsh`（profile、会话、凭据）不会被读写。

```sh
scripts/dev.sh bootstrap   # 从官方 web 模板创建 .devhome 与 mizar-dev profile
scripts/dev.sh install     # 构建 dsh-mizar 并装入该 profile
scripts/dev.sh boot        # 后台启动，打印启动行与插件日志
scripts/dev.sh log         # 跟踪日志
scripts/dev.sh stop        # 停止（会清理整个进程树）
scripts/dev.sh dump        # 打印合成后的配置树中与 Mizar 相关的行
```

**跨平台等价版本**：`node scripts/dev.mjs <同样的命令>`。它把四处不可移植的做法
（进程树、端口占用查询、环境清理、日志跟踪）改用 Node 实现，**在 macOS 上已验证
与 `dev.sh` 等价**（`smoke` 107/107），这样 Windows 上不再需要 Git Bash 才能启动宿主。
`dev.sh` 保留为已验证的参考实现。

插件自身的循环：

```sh
npm run build      # tsc（宿主半）+ esbuild 封装（浏览器半）
npm run typecheck  # 两份 tsconfig
npm test           # vitest
```

端到端冒烟（会先重启，再对真实监听端口跑 HTTP + WebSocket 断言）：

```sh
scripts/dev.sh smoke
```

它走真实链路，断言的是真正保护操作者的行为：错误配对码被拒、已兑换的码无法重放、未知
令牌在任何方法执行之前就被拒、畸形帧与版本不符会得到明确错误码而不是被半读；然后是
Bridge —— 会话列表与用量、模型目录、权限目录、会话创建/改名/切模型/切权限/发消息/打断、
以及幂等键重试不产生重复消息。**107 项断言。**

> 为什么必须先重启：配对码是**单次使用**的，第二次跑同一个实例就没有可兑换的码了。
> 重启同时也把整条启动路径重新走一遍，这正是我们想验证的。

> **为什么 `scripts/dev.sh` 的变量叫 `MIZAR_*` 而不是 `DSH_*`？**
> 在 DSH 会话内运行时，环境里已经有 `DSH_PROFILE=desktop` 等变量。早期版本用
> `${DSH_PROFILE:-mizar-dev}`，结果被环境变量覆盖，脚本悄悄把目标指向了
> **保留的 Desktop profile**。所以开发脚本一律用 `MIZAR_*`，并在调用子进程前
> 用 `env -u` 清掉继承来的 DSH 会话标记。

---

## iOS

### MizarKit（协议层）

`iOS/MizarKit/` 是一个 Swift 包，**先用 `swift test` 在 Mac 本机上跑**——一轮测试约 0.13 秒。

```
iOS/MizarKit/Sources/MizarKit/
├─ JSONValue.swift          任意 JSON 的 Codable 表示
├─ Frames.swift             协议 v1：帧、错误码、握手体
├─ DomainModels.swift       会话/用量/模型/权限/交互的类型
├─ PairingURI.swift         mizar:// 配对 URI（与 TS 侧逐字节一致）
├─ PairingClient.swift      唯一一次免鉴权交互（hello + pair）
├─ MizarConnection.swift    鉴权连接：请求关联、事件推送、断线清理
├─ WebSocketTransport.swift 协议 + URLSession 实现
├─ Backoff.swift            带抖动的重试节奏
├─ Conversation.swift       会话记录 → 可读的对话项
└─ CredentialStore.swift    Keychain 存储（测试注入内存实现）
```

```sh
scripts/swift.sh test      # 构建并运行 Swift 测试
scripts/swift.sh build
```

> 为什么包装一层脚本：SwiftPM 自己会用 `sandbox-exec` 编译 manifest，而它**无法嵌套在
> DSH 会话的文件沙箱里**（报 `sandbox_apply: Operation not permitted`），必须
> `--disable-sandbox`；另外 SwiftPM 默认缓存目录在 `~/Library` 下、工作区外，三个路径都要
> 重定向进仓库。

### 黄金帧契约

`protocol/fixtures/` 里的帧是**从真实运行的宿主捕获的**，不是手写的，并且
**TypeScript 与 Swift 两套测试读同一批文件**。手写的帧和真实的帧只有在有人记得同步时才
一致，而它们不同步时不会有任何东西失败；两个解码器读一个产物才能真正把契约钉住。

```sh
MIZAR_WRITE_FIXTURES=1 scripts/dev.sh smoke   # 重新捕获
```

### App 工程

`iOS/DSH-Mizar.xcodeproj/` 是**手写的 pbxproj**，用 `PBXFileSystemSynchronizedRootGroup`
组织源码——新增文件直接进目录即可，不必改工程文件。

```sh
scripts/ios.sh build       # 编译
scripts/ios.sh run         # 编译 + 装进模拟器 + 启动
scripts/ios.sh test        # 跑 UI 测试（需先启动 mock host）
scripts/ios.sh screenshot  # 截屏
```

> **为什么 MizarKit 在工程里是 framework target，而不是 Swift Package 引用？**
> 不是风格选择。Xcode 解析包时要通过 `swift-plugin-server` 加载 manifest，而它会往
> `~/Library/Caches/org.swift.swiftpm` 写一个诊断文件——**这个路径是硬编码的**，
> `-packageCachePath`、`HOME` 覆盖、所有 `SWIFTPM_*` 环境变量都改不动它。所以受限的
> 文件策略下包引用根本无法解析。framework target 编译**同一份源码**，零解析步骤，
> `import MizarKit` 照常工作，而 `swift test` 仍然跑包里的测试套件。

### UI 测试

`iOS/DSH-MizarUITests/` 有 11 个 XCUITest，跑在 `scripts/mock-host.mjs` 上：

```sh
node scripts/mock-host.mjs 19395 &
scripts/ios.sh test
```

> **为什么需要 mock host？** 待审批状态只在 agent 被工具调用阻塞时存在。这台机器的
> 宿主**每一轮都以 `MISSING_CREDENTIAL` 结束**——没有 provider 凭据，根本走不到工具调用。
> 所以真实宿主无法按需产出审批，mock 是唯一可行的验证手段。它用的是**从真实会话录下的
> 记录形状**。

> 元素一律用 accessibility identifier 查找，**不用文案**。用 `"Allow once"` 查找的测试
> 只在英文下通过——而"文案不是稳定标识"恰恰是本地化工作本身要证明的事。

### 发布

```sh
scripts/release.sh archive   # 归档
scripts/release.sh export    # 导出本地 .ipa
scripts/release.sh upload    # 归档 + 导出 + 上传
```

详细步骤见 [docs/testflight.md](docs/testflight.md)。

---

## Web 面板

DSH GUI 侧边栏里的 **DSH-Mizar** 面板（`main` 插槽的 `mizar` key）显示四件事：

- **绑定情况** —— 监听地址、绑定模式、当前客户端数。回退到 loopback 时给出醒目的提示并
  说明原因（"没找到 Tailscale 网卡——Tailscale 在跑吗？"）。
- **配对二维码** —— 内容形如 `mizar://pair?h=<host:port>&c=<CODE>&n=<主机名>&v=1`；
  同时显示分组后的可读码与剩余有效期。生成新码会作废旧码。
- **设备名册** —— 在线设备在前、按新增时间倒序；每条带短标识（`tokenPrefix`）与最后活跃
  时间；可一键吊销，**立即生效并断开该设备的连接**。
- **已吊销设备** —— 折叠在下方，保留记录而不是删除。

面板数据走 DSH 自己的 `/api` 通道（`/api/mizar.status|pairing|revoke`），复用浏览器的
会话 cookie，不引入第二套鉴权。路由通过 `ctx.inject(['connection'], …)` 注册，所以
headless / SDK 这类没有浏览器载体的组合仍然拥有完整的监听器与 Bridge，只是没有面板。

## 方法表（协议 v1）

| 方法 | 作用 |
|---|---|
| `host.info` | 主机身份与协议版本 |
| `session.list` | 会话列表，按最近活动排序 |
| `session.stats` | 某个会话的用量帧（token / 缓存命中 / 上下文 / 吞吐 / 模型 / 权限） |
| `session.create` | 新建会话；带 `sessionId` 时接管或恢复 |
| `session.prompt` | 发消息；`requestId` 是幂等键，重试不会重复发送 |
| `session.cancel` | 打断当前 turn |
| `session.rename` | 改名 |
| `model.catalog` | 模型目录，含每个模型的思考强度等级 |
| `session.model.set` | 切换模型与思考强度 |
| `permissions.catalog` | 权限预设目录 |
| `session.permission.set` | 切换权限预设（走 `/permission` 命令） |
| `interactions.pending` | 当前等待操作者处理的审批与提问 |
| `approval.answer` | 回答审批（仅 `allowed-once` / `rejected`） |
| `question.answer` | 回答提问批次 |

## 两个必须知道的事实

1. **`apply()` 早于 strict descriptor 注册。** 插件在 composition 阶段就激活，但
   DSH 的 strict Typert 描述符稍后才注册。此时立即 `invoke()` 会报
   `gateway/invocation-unavailable`（"no active Remote method exports this endpoint"）。
   这是**时序问题，不是能力缺失**。所有网关消费者都必须先用
   [`awaitEndpoints()`](src/ready.ts) 等描述符就绪（实测稳定在 126 个）。
2. **读 `ctx.typert` 必须在 `inject` 里声明 `typert`。** 否则 Cordis 会直接抛
   `cannot get property "typert" without inject`。

因此宿主半注入 `['typert', 'typertGateway', 'sessionProjections', 'sessions']`。

---

## 客户端半为什么要手写构建

DSH 对插件浏览器半**只接受一种产物形态**：调用
`window.__ModuleLoader__.load({ id, factory })` 的脚本，其中 `factory` 是一个
CommonJS 模块体。没有 ESM 路径，而 DSH 自己的客户端构建链**没有作为包发布**。

[`client/build.mjs`](client/build.mjs) 因此自己复刻了这个信封。三个容易搞错的点：

- 模块体必须在 factory **内部**，否则会在脚本解析时就执行，而不是在 shell
  物化 bundle 时执行；
- `id` 必须等于包名，boot graph 靠它匹配；
- 九个基线模块（react ×4、cordis、client-store、ui-slots、ui-primitives、
  ui-dockkit）由 shell 提供，必须保持 external——打包进第二份 React 会破坏 hooks。

[`test/client-bundle.test.ts`](test/client-bundle.test.ts) 用 shell 的方式物化产物
并断言以上三点，另外断言 `apply` 确实向 `main` 与 `sidebar.panellist` 注册了面板。

---

## 安全边界

- 插件**不**修改 DSH 的绑定策略，也不暴露 DSH 自己的 web GUI。
- 默认绑定模式 `tailscale`：只绑 tailnet 网卡地址（IPv4 `100.64.0.0/10`、IPv6
  `fd7a:115c:a1e0::/48`）。找不到 tailnet 网卡时回退 `127.0.0.1`，不会静默暴露到局域网。
- 链路加密由 Tailscale（WireGuard）提供；`tls.mode` 开关保留给将来走局域网直连的场景。
- 设备令牌可单独吊销；配对码 5 分钟过期、单次使用、带限流。
- 手机能发 prompt 就等于能在 Mac 上执行任意代码——这是产品能力的本质，不是缺陷。
  配对与吊销是它的边界。

---

## 环境要求

| | |
|---|---|
| macOS | DSH 桌面版（本文按 `0.2.0-rc.2` 验证） |
| Windows | 同一插件，纯 Node、零原生依赖、代码中无 POSIX 专属调用 —— **但从未运行过**，见 [Windows 状态](docs/windows-status.md) |
| iOS | Xcode 27 / Swift 6.4 / iOS 27 SDK；部署目标 iOS 18+ |
| 网络 | 两端安装 Tailscale（或用 `bind.mode` 走局域网/自带 VPN） |
| Node | 22+（宿主插件用到全局 `WebSocket`） |

**关于液态玻璃**：用 Xcode 26+（iOS 26+ SDK）构建后，标准 SwiftUI 控件在 iOS 26/27
上**自动**呈现 Liquid Glass，同一个二进制在 iOS 18–25 上保持旧外观——这是由
*构建所用 SDK* 决定的，与部署目标无关；Info.plist 的 `UIDesignRequiresCompatibility`
可以显式退回旧观感（本项目不设）。仅在 26 才引入的 API（如 `glassEffect`）需要用
`if #available(iOS 26, *)` 守卫。


---

## 中继服务器（不依赖 Tailscale）

校园网这类网络**封禁入站**，所以手机永远连不上 Mac 的监听地址——这是实测结论，不是猜测。
中继的思路是反过来：**Mac 主动出站**连到你的服务器，之后就通过那条连接可达。

```
Mac 插件 ──出站 wss──▶ 你的服务器 ◀──https/wss── 手机
   /tunnel                │            /r/<room>/mizar/v1/...
                          └─ 请求重放给 127.0.0.1:19390（现有监听器，零改动）
```

**Mizar 协议一个字都没改**：隧道只是换了基地址，配对、帧、方法表全部照旧。

配对二维码现在可以同时带直连地址（`h`）和中继地址（`u`）：
**App 先试直连，失败再走中继**，所以一张二维码同时覆盖「同一个 Wi-Fi」和「任何网络」。

- 部署步骤：[docs/relay-deployment.md](docs/relay-deployment.md)（含宝塔面板配置）
- 服务器源码：[`relay/`](relay/)

**中继能看到经过它的明文流量**——它终止 TLS。你自己运维时这是可接受的，也正因如此
**端到端加密列为后续独立阶段**。

---

## 已知问题

- **`testASentMessageAppearsInTheConversation` 持续失败。** 消息确实送达宿主（mock 记录到
  `prompt received`，冒烟测试也证明幂等），但断言拿不到它出现在输入框上方。**这不是中继引入的
  回归**——中继只改了传输层，没有碰对话或输入框。早先两版测试即使在移除修复后也能通过，
  因为它们匹配到了 TextField 清空后残留的幽灵文本。
- **Windows 从未运行过。** 代码检查通过，但没有 Windows 机器验证。
- **打洞尚未实现。** 中继的 UDP 探测口已经建好（用来测量双方公网端点），但真正在 UDP 上跑
  Mizar 帧需要一套可靠传输 + 加密，**门控在实测结果上**——先确认这条网络能不能打通再写。
