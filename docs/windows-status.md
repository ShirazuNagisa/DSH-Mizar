# Windows 支持状态

**结论先说：`src/` 里没有任何 POSIX 专属调用，并且已在一台 Windows 11 机器上
实测过插件的挂载、监听、面板和冒烟链路（见下文）。** 这份文档把"验证过的"和
"没验证过的"分开。

## 代码检查：没有会崩的东西

对整个 `src/` 做过排查：

| 检查项 | 结果 |
|---|---|
| 信号处理（`SIGTERM` / `process.on`） | ✅ 没有 |
| `process.getuid` / `getgid` | ✅ 没有 |
| `/proc/` 或任何 Linux 专属路径 | ✅ 没有 |
| 硬编码的 `/tmp` 或 `/usr/` | ✅ 没有 |
| 路径拼接 | ✅ 全部用 `node:path` 的 `join()` |
| 计时器 | ✅ 全部用 `unref?.()` 可选链，不会阻止进程退出 |
| 子进程 | ✅ `src/` 里没有 `child_process`；开发脚本里的子进程见下文 |

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
相应地在 Windows 上，文件权限那条测试只断言文件存在，不断言 `0o600`。

**如果你要在 Windows 上加固**，需要显式设置 ACL（`icacls`），Node 没有内置 API：

```powershell
icacls "$env:USERPROFILE\.dsh\.mizar" /inheritance:r /grant:r "$env:USERNAME:(OI)(CI)F"
```

### 2. 开发脚本：宿主侧已有跨平台版本

`scripts/dev.mjs` 是 `dev.sh` 的 Node 重写，取代了 `dev.sh` 里四处不可移植的做法：

| bash 做法 | Node 做法 |
|---|---|
| `pgrep -P` 递归杀进程树 | POSIX 下 `detached` 起进程组，一次 `kill(-pid)`；Windows 下 `taskkill /T /F` |
| `lsof` 查端口占用 | POSIX 用 `lsof`，Windows 用 `netstat -ano` |
| `env -u DSH_PROFILE …` 手写清单 | Node 原生在 spawn env 里删，清单不会失同步 |
| `tail -f` | Windows 走 PowerShell `Get-Content -Wait` |

**在 macOS 上已验证等价**：`boot` 结果一致，`smoke` 全绿，`stop` 之后
端口释放且无残留进程。iOS 构建用的 `ios.sh` / `swift.sh` / `release.sh` 只在
macOS 上有意义，已随 iOS 客户端移到独立仓库，不构成 Windows 缺口。

**仍然没验证的**：`dev.mjs` 里的 Windows 应用安装路径是**推测的**
（`%LOCALAPPDATA%\Programs\…` 与 `%PROGRAMFILES%\…`）。`MIZAR_APP` 可以覆盖。
另外 `netstat` / `taskkill` 分支已经随 `smoke` 走通，但没有针对"端口被占"
场景的断言。

## 已经在 Windows 上跑过的部分

2026-10-16，在一台 Windows 11 机器上（DSH desktop 0.2.0-rc.2，Node 24）实际执行过，
命令与结果如下。

| 项目 | 状态 |
|---|---|
| 插件在 Windows 上启动 | ✅ `[mizar] apply() entered` → `mounted (bind=lan port=19390)` → `ready` |
| 监听器绑定 Windows 网卡地址 | ✅ `listening on <局域网 IPv4>:19390, …`（**不含 127.0.0.1**） |
| Web 面板在 Windows 浏览器里 | ✅ 冒烟测试里的面板段全过：launch token → 303 + cookie → `/api/mizar.status` → 发码 → 撤设备 |
| 单元测试（插件本体） | ✅ `vitest run` 全绿 |
| 单元测试（中继） | ✅ `vitest run` 全绿（中继在独立仓库） |
| 端到端冒烟（真实 wire） | ✅ `node scripts/dev.mjs smoke` 通过，0 失败 |
| 安装到 dev profile（Windows） | ✅ `node scripts/dev.mjs install` 成功 |
| 安装到 DSH desktop profile | ❌ 未做（会重启正在用的 DSH，留给操作者） |
| iOS App 连 Windows 主机 | ❌ 未做（需要一台 iPhone） |
| Android 客户端连 Windows 主机 | ✅ `:mizarkit:hostCheck` 全过（见 [Android 仓库](https://github.com/ShirazuNagisa/DSH-Mizar-Android) 的 docs/android.md） |

### 三个必须知道的环境事实

1. **`scripts/dev.mjs` 在 Windows 上能用，但它的子进程活不过它自己。** `boot` 打印
   「已就绪」之后一旦父进程退出，dev 实例就被收走（没有 `detached`）。要一边起宿主一边跑客户端，
   必须在**同一条命令**里完成，或者自己用 `Start-Process` 起那个 exe。`smoke` 之所以一直正常，
   正是因为它在一条命令里完成。
2. **`dsh plugin add` 走 pnpm 时，pnpm 的 isolated 链接可能解析不了。** 它建的 junction
   不被 Node 的 `fs.realpathSync` 穿透（`realpathSync.native` 可以），于是 esbuild 找不到
   自己的可选平台包。用 `nodeLinker: hoisted`（DSH 自己的 profile 也是这个形状）即可。
3. **Windows 上的 TLS 信任链可能和 Node/JVM 默认信任库不一致**（企业代理或自签根证书
   环境常见）。git 可以改 `http.sslBackend=openssl` 并给一份 PEM；Node 用
   `NODE_EXTRA_CA_CERTS`；Gradle 发行版可以先用 Node 或镜像下载、再预置到 wrapper 缓存里。

### 本轮顺手修掉的测试可移植性问题

三处断言把**平台或区域**当成了输入，在 Windows/中文环境下必然失败，已改：

- `test/store.test.ts`：`resolveMizarHome` 的期望值写死成正斜杠路径（改用 `join` 拼），
  以及 `0o600` 在 Windows 上是空操作（加平台分支并把原因指向本文档）。
- `test/i18n.test.ts`：Node 21+ 有全局 `navigator`，`language` 就是本机区域——「没有浏览器时
  默认英文」这条断言实际断言的是跑测试的人用哪国语言。改成显式 stub 掉 `navigator`。
- `test/panel-render.test.tsx`：同一原因，面板文案断言先固定语言再渲染。

## 仍然没做的

- 监听器上的 TLS（配置里有 `tls.mode`，实现里没有）。
- 从真机（iPhone 或 Android 手机）连 Windows 主机的完整交互。

## 把插件装进 live（desktop）profile —— Windows 实测步骤

一个 profile 要加载本插件，只需要三处（`link:` 不必真的跑 pnpm，junction 等价）：

1. `~/.dsh/profiles/<profile>/package.json`：`dependencies` 加 `"dsh-mizar": "link:<仓库路径>"`，
   `dsh.profile.bundles` 追加 `"dsh-mizar"`（行本身由插件自带的 `cordis.patch.yml` 插入，profile 只放 config）。
2. `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加 `- id: mizar` 的 `config`（`relay.enabled`、`bind.addresses`）。
3. `~/.dsh/profiles/<profile>/node_modules/dsh-mizar` 指向仓库（`New-Item -ItemType Junction`，
   与 pnpm `link:` 产物相同）。profile 的 `pnpm-workspace.yaml` 需为 `nodeLinker: hoisted`。

**必须重启 DSH**：bundles 在启动时解析，插件行由 bundle patch 插入。回滚＝还原备份的两个文件并删除
`node_modules/dsh-mizar`。
