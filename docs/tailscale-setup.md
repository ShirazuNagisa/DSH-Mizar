# Tailscale 安装与组网

DSH-Mizar 默认只在 **tailnet** 上监听。理由：DSH 官方明确拒绝把它的 GUI 绑到
`0.0.0.0`（那等于把"在 Mac 上执行任意代码"暴露给整个局域网）。Mizar 用 Tailscale
把可达范围收敛到你自己的设备集合，链路加密由 WireGuard 提供，因此不需要自签证书。

> 如果你暂时不想装 Tailscale，插件会自动回退到 `127.0.0.1`，开发完全不受影响；
> 只是手机连不上。

---

## 1. Mac 端

安装包已经下载好并校验过，放在 `.devcache/downloads/`（该目录不进版本控制）：

| | |
|---|---|
| 文件 | `Tailscale-1.104.1-macos.pkg` |
| 大小 | 21 MB |
| SHA-256 | `67ec55f18ee2afac0a8fb57f7811977f4ad6df1debd4a187fa0db3dbb5d401d5` |
| 签名 | Developer ID Installer: Tailscale Inc. (W5364U7YZB) |
| 公证 | 已通过 Apple 公证服务（`pkgutil --check-signature` 显示 trusted） |

```sh
open .devcache/downloads/Tailscale-1.104.1-macos.pkg
```

然后：

1. **安装**：安装器会要求管理员密码。
2. **批准系统扩展**：首次启动时 macOS 会弹出"允许系统扩展"。到
   **系统设置 → 通用 → 登录项与扩展**（或 **隐私与安全性**）里点允许，可能要求重启。
   这一步不能跳过——不批准的话 tailnet 网卡不会出现。
3. **登录 tailnet**：用 Google / Microsoft / GitHub 或自建 Headscale 登录。
4. **确认**：

   ```sh
   /Applications/Tailscale.app/Contents/MacOS/Tailscale status
   /Applications/Tailscale.app/Contents/MacOS/Tailscale ip -4
   ```

   第二条应当打印一个 `100.x.y.z` 地址——插件就是靠这个网段识别 tailnet 的。

5. **防火墙**：如果开了 macOS 防火墙，确认 Tailscale 被允许接受传入连接。

### 为什么不用 Mac App Store 版

App Store 版能用，但它是沙箱化的：CLI 不在标准路径、不能做 subnet router / exit node。
standalone 版多一个可脚本化的 `tailscale status --json`，插件将来可以用它做更准确的
网卡识别与状态展示。

---

## 2. iPhone / iPad 端

1. App Store 安装 **Tailscale**。
2. 用**同一个账号**登录同一 tailnet。
3. 打开 VPN 开关（系统会要求添加 VPN 配置）。
4. 在 Mac 上跑 `tailscale status`，能看到 iPhone 的条目即成功。

---

## 3. Mizar 侧的期望

插件按**地址段**识别 tailnet，不看接口名：

- IPv4：`100.64.0.0/10`（CGNAT，Tailscale 专用）
- IPv6：`fd7a:115c:a1e0::/48`

按地址段而不是接口名是刻意的：开发这台机器上有 **9 个 `utun*` 接口**，全部来自别的
VPN 软件。任何基于名字的判断要么漏掉真正的 tailnet，要么绑上别人的隧道。

找不到 tailnet 地址时插件**回退到 `127.0.0.1` 并把原因写进 Web 面板与日志**，绝不
顺手绑到局域网网卡上。

---

## 4. 为什么不走 SSH 隧道

SSH 端口转发也能用（插件支持 `bind.mode: loopback`），但用户侧步骤明显更多，而且
**并不能解决"随时随地"**：

1. Mac 上开启"远程登录"，需要管理员权限。
2. iPhone 上准备 SSH 客户端并配置密钥或密码。
3. 每次使用都要手动建立 `ssh -L 19390:127.0.0.1:19390 user@mac`。
4. **iOS 会在后台挂起 SSH 连接**：切走再回来通常要重建隧道，无法像 VPN 一样常驻。
5. App 还要额外知道本机转发端口，端口冲突时还得换号。
6. 离家/离公司时 Mac 没有公网可达入口——纯 SSH 隧道本身**不做 NAT 穿透**，还需要
   公网 IP + 路由器端口映射，或者第三台跳板机。

Tailscale 一步覆盖了 1–6，所以它是默认路径；SSH 隧道作为文档化的备选保留。
