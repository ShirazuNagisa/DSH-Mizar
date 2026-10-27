# dsh-mizar 0.9.0 — AGI Mizar 的 DSH 侧插件

**这是一个辅助插件。单独安装它没有任何作用。**

0.9.0 起，`dsh-mizar` 不再自己对外服务：没有监听器、没有配对码、没有设备名册、没有中继、
没有推送、没有面板。手机不再直连 DSH。它只做一件事——把 DSH 进程里的东西交给
[AGI Mizar](https://github.com/ShirazuNagisa/AGI-Mizar) 桌面端。

```
手机 App ──▶ AGI Mizar 桌面端 ──▶ 本插件（在 DSH 进程内）──▶ DSH
                 │
                 ├──▶ Claude Code（直连）
                 └──▶ Codex（直连）
```

## 四个仓库

| 仓库 | 角色 |
|---|---|
| [AGI Mizar](https://github.com/ShirazuNagisa/AGI-Mizar) | 桌面端，唯一的宿主与网关 |
| **DSH-Mizar（本仓库）** | DSH 侧辅助插件 |
| DSH-Mizar-iOS | 手机 App |
| DSH-Mizar-Android | 手机 App |

---

## 安装

需要 DSH 0.2.1-rc.2、Node ≥ 22，以及**已经装好的 AGI Mizar 桌面端**。

```sh
dsh plugin --profile desktop add dsh-mizar@0.9.0
```

装完**重启 DSH**——插件只在启动时加载。

如果重启后没连上，先看 `~/.agi-mizar/dsh-plugin.log`：这个插件没有面板，而 GUI 启动的 DSH 会把
stdout 丢掉，那个文件是它唯一能说"我为什么没起来"的地方。每次加载会清空重写。

桌面端运行时会在 `~/.agi-mizar/endpoint.json` 写一个回环端口和一次性令牌，插件读它、
拨过去、握手。桌面端没运行，插件就只是每隔几秒重试一次，**不改变 DSH 的任何行为**。

## 它做什么

只有四件，每一件都必须在进程内才能做：

| 能力 | 为什么不能挪到桌面端 |
|---|---|
| 转发 `session/event` 与 `projection/changed` | Cordis 的进程内订阅，外面听不到 |
| 代理任意 `typertGateway` 端点调用 | 网关是进程内服务 |
| 代理进程内服务（工作区注册表、投影存储） | 这些没有 Typert endpoint |
| 参与 `approval/request` / `user-questions/request` waterfall | Cordis waterfall 只存在于进程内 |

**转发是全量的**：不投影、不裁剪、不改写、不认识业务字段。DSH 以后加事件、加端点，
插件不需要更新——桌面端可以直接调用它不认识的端点。

## 它不做什么

监听端口、配对、设备令牌、吊销、中继、推送、上传、文件预览、余额、P2P、侧边栏面板、配置页。
这些全部在 AGI Mizar 桌面端。

## 配置

```yaml
- name: dsh-mizar
  config:
    # 桌面端发布的地址文件
    endpointFile: ~/.agi-mizar/endpoint.json
    # 允许桌面端代理的进程内服务
    services: [workspaceRegistry, sessions, sessionProjections, userApproval, userQuestions]
    reconnect:
      baseMs: 1000
      maxMs: 30000
      heartbeatMs: 15000
    # 诊断用：把每条转发的事件打到 stdout（很吵）
    logEvents: false
```

协议细节见 [`docs/protocol-link-v1.md`](docs/protocol-link-v1.md)。

## 开发

```sh
npm install
npm run build          # 编译到 lib/（lib/ 是提交进仓库的产物）
npm run typecheck
npm test               # 69 个测试，几秒内跑完
```

没有桌面端也能联调：`npm run fake-desktop` 会写一个真的 endpoint 文件、起一个 WebSocket 服务端、
打印收到的每一帧；在 stdin 里敲 `invoke session/list` 就能发起一次调用。然后重启 DSH。

## 从 0.8.x 升级

**这是破坏性版本。** 升级后手机无法再直连这台 DSH，旧的配对记录全部失效（`hostId` 换到了桌面端）。

1. 先装 AGI Mizar 桌面端；
2. 升级插件：`dsh plugin --profile desktop add dsh-mizar@0.9.0`；
3. 重启 DSH；
4. 在桌面端重新扫码配对。

还需要 0.8.x 的话，旧版仍在 npm 上：`npm i dsh-mizar@legacy`（= 0.8.14）。
它和 0.9.0 不冲突——0.8.x 监听 19390，0.9.0 不监听任何端口。

## 许可

GPL-3.0-only。
