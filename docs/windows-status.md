# Windows 支持状态

**结论先说：插件没有任何 POSIX 专属调用，代码层面应当可以在 Windows 上运行，
但它从未在 Windows 上执行过。** 这份文档把"验证过的"和"没验证过的"分开。

## 代码检查：没有会崩的东西

对整个 `dsh/src/` 做过排查：

| 检查项 | 结果 |
|---|---|
| 信号处理（`SIGTERM` / `process.on`） | ✅ 没有 |
| `process.getuid` / `getgid` | ✅ 没有 |
| `/proc/` 或任何 Linux 专属路径 | ✅ 没有 |
| 硬编码的 `/tmp` 或 `/usr/` | ✅ 没有（仅 Tailscale CLI 候选路径里有，且按平台分支） |
| 路径拼接 | ✅ 全部用 `node:path` 的 `join()` |
| 计时器 | ✅ 全部用 `unref?.()` 可选链，不会阻止进程退出 |
| 子进程 | ✅ `execFile` 带 `windowsHide: true`，不会弹出控制台窗口 |

网络部分用 `os.networkInterfaces()`，本身就是跨平台的。

## 两处真实的平台差异

### 1. 文件权限模式在 Windows 上是空操作

```ts
await open(temp, 'w', 0o600)
await mkdir(dir, { recursive: true, mode: 0o700 })
```

Node **接受**这些模式但 Windows **忽略**它们。含义是：

- macOS / Linux：状态文件（含设备令牌哈希）由 POSIX 权限保护
- Windows：由**用户配置文件的 ACL** 保护

两者都是"只有本账户和管理员可读"，但**是两套不同的机制**。这一点已经写进
`store.ts` 的注释里，因为它是一个真实的差异而不是等价物。

**如果你要在 Windows 上加固**，需要显式设置 ACL（`icacls`），Node 没有内置 API：

```powershell
icacls "$env:USERPROFILE\.dsh\.mizar" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
```

### 2. 开发脚本是 bash-only

`scripts/` 下四个脚本（`dev.sh`、`ios.sh`、`release.sh`、`swift.sh`）都是 bash，
**在 Windows 上需要 Git Bash 或 WSL**。而且：

- `ios.sh` 和 `swift.sh` 只在 macOS 上有意义（iOS 构建）
- `dev.sh` 用了 `lsof`、`kill_tree`、`env -u` —— **Git Bash 里 `lsof` 不存在**

所以 **Windows 上目前没有可用的开发/冒烟harness**。这是真实缺口。

## 已在单元测试中覆盖的 Windows 分支

`dsh/test/tailscale.test.ts` 里的 `describe('Windows')` 有 7 个用例，通过注入
`platform` 参数执行 Windows 代码路径（本机无法真正运行）：

- 找到 `C:\Program Files\Tailscale\tailscale.exe`
- 找不到时报告缺失而不是猜路径
- 隧道断开 → 走客户端 CLI
- 守护进程无响应 → 启动客户端（**不是 `open`**）
- **断言永不调用 `/usr/bin/open`** —— macOS 专属二进制
- 登录自启在 Windows 上报告"不适用"而不是"关闭"
- 候选路径里不含任何 POSIX 路径

最后一条"永不调用 open"是这里最有价值的断言：在 Windows 上调用 `open` 会
**静默失败**，而现象是"手机连不上"，排查方向会完全跑偏。

## 尚未验证的部分

| 项目 | 状态 |
|---|---|
| 插件在 Windows 上启动 | ❌ 从未运行 |
| 监听器绑定 Windows 网卡地址 | ❌ 从未运行 |
| Web 面板在 Windows 浏览器里 | ❌ 从未运行 |
| iOS App 连 Windows 主机 | ❌ 从未运行 |
| 安装到 DSH desktop profile（Windows） | ❌ 从未运行 |
| Tailscale 在 Windows 上的自动拉起 | ❌ 从未运行 |

**代码检查不能替代运行。** 上面这一整列都是零。

## 在 Windows 上验证需要做什么

1. **装 Node.js 22+**（用到全局 `WebSocket`）
2. **装 DSH**，确认 `dsh` 命令可用
3. **把插件装进 profile**：目前 `scripts/dev.sh bootstrap` 是 bash 的，
   Windows 上需要手动做，或者用 Git Bash 试试
4. **装 Tailscale for Windows**，登录
5. **启动**，看日志里有没有 `[mizar] listening on`
6. **从手机连**，跑一遍配对 → 会话列表 → 审批

如果需要，我可以把 `dev.sh` 的核心逻辑抽成**跨平台的 Node 脚本**
（Node 在两端都有），这样 Windows 上也能跑冒烟测试。但那需要在真正有
Windows 机器时才能验证它有效。
