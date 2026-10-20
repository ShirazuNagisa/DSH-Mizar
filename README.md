# DSH-Mizar 插件

用手机看 DSH Agent 干活，也能给它发消息、回答审批。

这个仓库是 **电脑侧插件**（DSH 的一个 Cordis 插件，跑在 DSH 所在的那台机器上）。另外三个仓库：

| | |
|---|---|
| **DSH-Mizar-iOS** | 手机 App（iOS / iPadOS） |
| [**DSH-Mizar-Android**](https://github.com/ShirazuNagisa/DSH-Mizar-Android) | 手机 App（Android） |
| **DSH-Mizar-Relay** | 中继服务器，让手机从任何网络连上你的电脑 |

## 一、装插件

**推荐用 npm 装**:插件已发布到 npm,包名 **`dsh-mizar`**,与当前 DSH 运行时(0.2.1-rc.2)对齐。
装完都要**重启 DSH** —— 插件只在启动时加载,不重启等于没装。

### 推荐:图形界面(不碰终端)

1. 打开 DSH,左侧栏点 **插件(Plugins)**
2. 安装输入框里填 **`dsh-mizar`**,点安装
3. 确认它弹出来的包名 / 版本 / 描述
4. 重启 DSH

### 推荐:命令行

```sh
dsh plugin --profile desktop add dsh-mizar          # 跟随 npm 最新版
dsh plugin --profile desktop add dsh-mizar@0.8.4    # 锁定某个版本
```

两种装法都会把依赖写成 `dsh-mizar@^x.y.z`。升级只要再跑一次 `add dsh-mizar@latest`。

重启后侧边栏会出现 **DSH-Mizar** 面板。

### 为什么是 npm,而不是 GitHub 直装

| | **npm(推荐)** | GitHub 直装 |
|---|---|---|
| 版本 | 有版本号,可锁 `@0.8.4` | 跟随 `main` 最新提交,不可锁 |
| 可追溯 | `npm view dsh-mizar versions`、`npm outdated` | 只有 commit hash |
| 完整性 | registry **sha512 校验** | 无包完整性校验 |
| 前提 | 只要能访问 registry | 需要 git + pnpm 的 git 支持 |
| 适合 | **所有人** | 只适合尝鲜未发布的提交 |

### 备选:GitHub / 本地 tarball

```sh
# 尝鲜:装 main 上还没发版的提交
dsh plugin --profile desktop add ShirazuNagisa/DSH-Mizar

# 离线 / 内网:在有网的机器上 npm pack,再把 .tgz 传过去
npm pack dsh-mizar
dsh plugin --profile desktop add /path/to/dsh-mizar-0.8.4.tgz
```

### 装不到最新版 / 镜像同步延迟

插件发布在 npm 官方源(`registry.npmjs.org`)。国内镜像(如 `registry.npmmirror.com`)偶尔滞后,
表现是 `pnpm` 抓到一个旧的或占位版本。两种情况:

- **加 `--registry` 直连官方源**:
  ```sh
  dsh plugin --profile desktop add dsh-mizar@0.8.4 --registry=https://registry.npmjs.org
  ```
- 或者去 [npmmirror 同步页](https://npmmirror.com/sync/dsh-mizar) 点一次「同步」,等镜像更新。

> GUI 的安装框走的是本机默认 registry;镜像没同步时,用上面的 CLI 命令更稳。

### 版本必须与 DSH 对齐

DSH 会**精确比对**插件声明的 `@deepseek-ai/dsh-*` 与运行时版本，不匹配时安装会被拒绝：

```
Plugin dsh-mizar@0.8.4 is incompatible with dsh 0.2.1-rc.2
```

- 正常做法：升级到匹配的插件版本（DSH 每个 rc 发布后，插件跟一个 `+0.0.1`）；
- 临时跑起来（**有风险**，只在确认没有 API 变更时用）：
  ```sh
  dsh plugin --profile desktop allow-version dsh-mizar@0.8.4 --dsh-version 0.2.1-rc.2 --accept-risk
  ```

## 二、配对

1. 电脑上打开 DSH，点侧边栏的 **DSH-Mizar**
2. 面板里会出现二维码
3. 手机装好 App 后扫码

**没有别的步骤。** 不用填 token，不用填地址，不用改文件。

## 三、插件做什么

- 把会话列表、对话正文、用量、审批和提问转给手机
- 手机可以发消息、打断正在跑的 turn、回答审批和提问、切换模型与权限
- 付费账户可以在会话里发送照片或文件；图片作为 DSH 图片内容，文件作为 DSH 文件内容或可读路径句柄
- 推送（审批 / 提问 / 跑完）经中继转给 Apple
- 手机和电脑在同一个局域网时优先直连（局域网通信），连不上再走中继；中继开着时监听器也会绑局域网地址

### 监听地址:中继开着也绑局域网

监听器默认绑**这台电脑的局域网 IPv4 地址**，中继开着的时候也一样（另外总会绑 `127.0.0.1`，
中继靠它把手机请求转回本机）。0.9.4 起「局域网通信」是产品承诺的功能：手机和电脑在同一个
局域网时直连，不占中继带宽，也是手机端解锁付费功能的条件。如果中继一开就把监听器缩回
loopback，手机永远找不到可直连的地址，这个功能等于不存在。

监听器有设备令牌鉴权和配对频率限制。把它绑到局域网上，只是让同网段的手机能直连，不会把
DSH 自己的 Web 接口暴露出去（那是 DSH 的安全边界，插件不碰）。

**想退回「只监听本机」的老姿势**（比如这台电脑接在不可信的网络上，只用中继）：

```yaml
# ~/.dsh/profiles/<profile>/cordis.patch.yml
- id: mizar
  config:
    relay:
      preferLoopback: true
```

把 `preferLoopback` 换成 `bind.mode: loopback` 效果相同，两个写一个就够。代价是**没有局域网
通信**：手机即使和电脑在同一个 Wi-Fi 也走中继，局域网解锁（附件、全量细节）不生效，其余
功能不变。

### 中继隧道自愈：断线会自己重连

中继方向有两个只有长期运行才会暴露的故障，0.8.6 起都做了兜底：

- **半开隧道。** 电脑换网络（Wi-Fi 切换、VPN 断掉、休眠唤醒）时，本地 socket 可能既收不到
  中继的 close、也不再有任何流量，而系统仍报 `ESTABLISHED`。中继那边过了 90 秒没收到
  pong 就把房间摘掉；插件这边却一直显示「已连接」，于是再也不重拨 —— 手机无论直连还是中继
  都连不上，只能重启 DSH。现在插件自己有**静默看门狗**：超过 `relay.watchdogMs`（默认
  120 秒，即中继 30 秒一次 ping 的四个周期）没收到中继任何一帧，就强制丢弃这条 socket 并
  重拨。可用 `relay.watchdogMs: 0` 关掉。
- **端口漂移。** DSH 可能重复挂载/重载插件；以前每次挂载都绑一个新监听，端口从 19390 一路
  漂到 19391、19392，手机配对里保存的直连地址就永远失效了。现在一个进程只保留**一个**挂载：
  新挂载要等旧挂载完全释放监听之后才绑端口；网络变化导致监听地址改变时，隧道也会立刻用新
  地址重拨，并把监听端口的变化同步给隧道（否则隧道健康、手机请求却全部 502）。
- **0.8.7 修了 0.8.6 单实例的漏洞。** 0.8.6 的注册表是模块级的，而 DSH 会在同一进程里多次
  加载插件模块，每份副本各有一张空注册表——实测一个进程因此挂了 8 个监听（19390–19397）。
  0.8.7 把注册表放到 `globalThis`（`Symbol.for('dsh-mizar.mount-registry')`），所有模块副本
  共用同一个槽位，一个进程只剩一个监听。

日志里对应 `relay: the tunnel has been silent for …s — redialling it`、
`relay: the network changed — redialling the tunnel` 和 `relay: the listener moved to port …`。

### 对话只传总结

一页历史里只保留这些：你的提问、每一轮的 `turn/start` 和 `turn/end`、每个 `step/start`
（只用来数「几步」），以及**每一轮里模型最后那条有正文的消息**。

逐步叙述、工具调用与结果、流式过程，以及**还没结束的那一轮的中间回复**，一律不发。
手机上那两行状态 —— 「已完成，用时 xx」和「深度求索中，用时 xx」—— 都不能展开，
下面直接就是这一轮的总结。全量历史经中继是服务器上最大的一块流量，这是为了把它压下来。

分页切点取自 `session/follow` 首帧的 `cursor`（DSH 自己对 `throughSeq` 的定义）。
用 `session/projections` 的 `asOfSeq` 会滞后于日志头，刚发出的那一轮就不在页里 ——
手机上表现为「AI 明明在干活，却没有正在工作的提示」。

## 四、通知

三种情况手机会收到推送，插件通过中继发给 Apple：

- Agent 卡在**权限审批**上，等你点头
- Agent 卡在**提问**上，等你回答
- 某个会话**跑完了**（跑挂/中断了会说挂掉，不会谎报完成）

**一轮结束不会立刻推。** DSH 里一个指令常常连着跑好几个 turn，每个 turn 都推一次等于一个
指令三条通知 —— 所以插件会等这个会话安静 15 秒才发。正在看着 App 的时候什么都不发。

**锁屏上的 Live Activity 会跟着结束。** iPhone 把正在跑的会话画在锁屏 / 灵动岛上计时；
App 被挂起时它自己没机会收尾。所以 App 会把这次活动的推送令牌随注册交给插件，插件存下来、
转给中继；会话跑完、且手机上还看得到的会话一个都不在跑时，那条「跑完了」的通知会让中继
顺手结束 Live Activity —— 任务结束后计时不会一直涨。

推送要 Apple 的签名密钥，密钥只能放在服务器上（放在插件里就等于公开）。**用官方中继
什么都不用做**；自建中继需要配 `apns`，见
[Relay 仓库的部署文档第 10 节](https://github.com/ShirazuNagisa/DSH-Mizar-Relay/blob/main/docs/deployment.md#10-push-notifications)。

## 四·五、发布(维护者)

发布走 **trusted publishing(OIDC)**:GitHub Actions 用一次性的 OIDC 身份向 npm 换发布凭证,
**没有长期令牌,也没有验证码要输**。发布就是推一个版本 tag。

一次性配置(npmjs.com,用账号的安全密钥验证):

1. 打开 `dsh-mizar` 包页面 → **Settings** → **Publishing access** → **Trusted publisher** →
   **GitHub Actions**;
2. 填:
   - Organization or user:`ShirazuNagisa`
   - Repository:`DSH-Mizar`
   - Workflow filename:`publish.yml`
   - Environment name:留空
   - **Allowed actions**:勾上 **`npm publish`**(直接发布;只勾暂存的话每次发布还要人工批准);
3. 保存。

之后发布:

```sh
cd dsh
npm version patch            # 或手改 package.json 的 version
git push                     # 版本号先上 main
git tag vX.Y.Z && git push origin vX.Y.Z
```

workflow(`.github/workflows/publish.yml`)会:**校验 tag 与 package.json 版本一致** →
`npm ci` → typecheck → 全部测试 → build → `npm publish --provenance`。任何一步失败都不会发布。

为什么不用手工 `npm publish`:这个账号的第二因子是**安全密钥(WebAuthn)**,npm CLI 不支持
WebAuthn,`Enter OTP:` 永远过不去;trusted publishing 是 npm 对 CI 发布的官方方案,还顺带生成
来源证明(provenance)。

> 手工 `npm publish` 对这个账号已经不可用:第二因子是安全密钥,npm CLI 没有 WebAuthn
> 挑战,`Enter OTP:` 永远过不去。需要手工发布时,先给账号加一个验证器 App(TOTP),
> 或者继续用 tag 工作流。

## 五、开发

```sh
npm install                 # 依赖（npm cache 建议指到本地：npm_config_cache=$PWD/.devcache/npm）
npm test                    # 全部测试
npm run typecheck
npm run build               # tsc + 浏览器半边；lib/ 是提交进仓库的，必须与全新构建一致
```

`lib/` **故意提交进仓库**：`dsh plugin add` 装的是 git 检出，没有构建步骤，缺了 `lib/`
等于插件装不上。所以改完 `src/` 一定要 `npm run build` 再提交。

跑一个真的开发实例（用仓库内的 `.devhome`，不碰你 `~/.dsh` 的正式配置）：

```sh
node scripts/dev.mjs install     # 构建并装进 mizar-dev profile
node scripts/dev.mjs boot        # 起一个真 DSH；日志 .devstate/dev.log
node scripts/dev.mjs stop
```

对着它跑一次真实链路的冒烟测试（会打印配对码）：

```sh
MIZAR_CODE=XXXX-XXXX node scripts/smoke-listener.mjs
```

**开发实例不要连中继。** `.devhome` 是从正式配置里拷出来的，会拿到同一个中继房间号，
两边一抢就会把正式那条隧道踢掉 —— `.devhome/profiles/mizar-dev/cordis.patch.yml` 里
已经写了 `relay: enabled: false`。

归档：`archive/full-message-transport/` 是 0.7.2 之前那套「全量传输」的实现，**不参与
编译**，留着以便以后要用（见该目录的 README）。

## 常见问题

**手机连不上。**
面板顶部会写原因。同一个局域网内会优先直连；不在同一个网络时走中继，只要电脑和手机都能上网就行。

**面板里没有二维码。**
重启 DSH。装完不重启，插件不会加载。

**想改成局域网直连 / 为什么没走局域网。**
默认就会优先走局域网：App 每次刷新先扫一遍本机网络，能直连就直连，连不上才走中继；二维码和 `host.info` 里两条路都带着。
如果之前为了「只监听本机」手动配过 `bind.mode: loopback` 或 `relay.preferLoopback: true`，把这两项删掉（或改成 `bind.mode: lan` / `preferLoopback: false`），重启 DSH 后监听器就会重新绑局域网地址。

**插件版本对不对。**
DSH 启动日志里有 `[mizar] dsh-mizar <版本号> · state: … · devices: N live` 这一行。

**收不到通知。**
按顺序查：App 里「设置 → 通知」有没有允许；插件日志里有没有 `push: registered …`
（说明手机把推送令牌交上来了）；中继上 `curl localhost:8787/healthz` 的
`pushDevices` 是不是大于 0。三条都对还是没有，看中继日志里 Apple 回的是什么 ——
`BadDeviceToken` 基本就是环境选错了。

---

协议、架构决策、自建中继、研究记录：[docs/](docs/)

## 许可

本项目以 **GNU General Public License v3.0**（GPLv3，SPDX：`GPL-3.0-only`）发布。
许可证全文见 [LICENSE](LICENSE)。
