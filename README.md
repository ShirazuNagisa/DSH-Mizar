# DSH-Mizar

**远程监控并指导 DSH Agent 工作。** 一个 DSH 插件 + 一个 Swift 原生 iOS/iPad App。

> **当前状态：Phase 0 与 Phase 1 完成。** 宿主插件已能启动独立监听端口、配对设备、
> 持久化凭据并通过鉴权 WebSocket 通信，全部经真实链路端到端验证（29/29）。
> Bridge（把 DSH 会话数据变成手机友好的帧）从 Phase 2 开始。
> 关键设计结论见 [决策记录 0001](docs/decision-0001-in-process-gateway.md)。

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

```
DSH-Mizar/
├─ docs/
│  ├─ decision-0001-in-process-gateway.md   # Phase 0.1 结论（必读）
│  └─ protocol-v1.md                        # 待写：Mizar 协议规范
├─ protocol/                                # 待写：帧 schema + 两端共用的黄金帧
├─ dsh/                                     # Cordis 插件（TypeScript）
│  ├─ src/          宿主半：index · config · ready · spike
│  ├─ client/       浏览器半：esbuild 封装器 + 面板
│  ├─ test/         vitest
│  └─ cordis.patch.yml
└─ iOS/                                     # 待建：Swift 原生 App
```

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

插件自身的循环：

```sh
cd dsh
npm run build      # tsc（宿主半）+ esbuild 封装（浏览器半）
npm run typecheck  # 两份 tsconfig
npm test           # vitest
```

端到端冒烟（需要先 `scripts/dev.sh boot`；profile 里已开启 `pairing.issueOnStart`，
启动时会打印配对码）：

```sh
CODE=$(grep -oE 'pairing code: [0-9A-Z-]+' .devstate/dev.log | head -1 | sed 's/pairing code: //')
MIZAR_CODE="$CODE" node scripts/smoke-listener.mjs
```

它走真实 HTTP 与 WebSocket，断言的是真正保护操作者的行为：错误配对码被拒、已兑换的码
无法重放、未知令牌在任何方法执行前就被拒、畸形帧与版本不符会被回以明确错误码而不是被
半读。29 项断言。

> **为什么 `scripts/dev.sh` 的变量叫 `MIZAR_*` 而不是 `DSH_*`？**
> 在 DSH 会话内运行时，环境里已经有 `DSH_PROFILE=desktop` 等变量。早期版本用
> `${DSH_PROFILE:-mizar-dev}`，结果被环境变量覆盖，脚本悄悄把目标指向了
> **保留的 Desktop profile**。所以开发脚本一律用 `MIZAR_*`，并在调用子进程前
> 用 `env -u` 清掉继承来的 DSH 会话标记。

---

## 两个必须知道的事实

1. **`apply()` 早于 strict descriptor 注册。** 插件在 composition 阶段就激活，但
   DSH 的 strict Typert 描述符稍后才注册。此时立即 `invoke()` 会报
   `gateway/invocation-unavailable`（"no active Remote method exports this endpoint"）。
   这是**时序问题，不是能力缺失**。所有网关消费者都必须先用
   [`awaitEndpoints()`](dsh/src/ready.ts) 等描述符就绪（实测稳定在 126 个）。
2. **读 `ctx.typert` 必须在 `inject` 里声明 `typert`。** 否则 Cordis 会直接抛
   `cannot get property "typert" without inject`。

因此宿主半注入 `['typert', 'typertGateway', 'sessionProjections', 'sessions']`。

---

## 客户端半为什么要手写构建

DSH 对插件浏览器半**只接受一种产物形态**：调用
`window.__ModuleLoader__.load({ id, factory })` 的脚本，其中 `factory` 是一个
CommonJS 模块体。没有 ESM 路径，而 DSH 自己的客户端构建链**没有作为包发布**。

[`client/build.mjs`](dsh/client/build.mjs) 因此自己复刻了这个信封。三个容易搞错的点：

- 模块体必须在 factory **内部**，否则会在脚本解析时就执行，而不是在 shell
  物化 bundle 时执行；
- `id` 必须等于包名，boot graph 靠它匹配；
- 九个基线模块（react ×4、cordis、client-store、ui-slots、ui-primitives、
  ui-dockkit）由 shell 提供，必须保持 external——打包进第二份 React 会破坏 hooks。

[`test/client-bundle.test.ts`](dsh/test/client-bundle.test.ts) 用 shell 的方式物化产物
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
| Windows | 同一插件，纯 Node 实现、零原生依赖 |
| iOS | Xcode 27 / Swift 6.4 / iOS 27 SDK；部署目标 iOS 18+ |
| 网络 | 两端安装 Tailscale |

**关于液态玻璃**：用 Xcode 26+（iOS 26+ SDK）构建后，标准 SwiftUI 控件在 iOS 26/27
上**自动**呈现 Liquid Glass，同一个二进制在 iOS 18–25 上保持旧外观——这是由
*构建所用 SDK* 决定的，与部署目标无关；Info.plist 的 `UIDesignRequiresCompatibility`
可以显式退回旧观感（本项目不设）。仅在 26 才引入的 API（如 `glassEffect`）需要用
`if #available(iOS 26, *)` 守卫。
