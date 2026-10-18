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
dsh plugin --profile desktop add dsh-mizar@0.8.3    # 锁定某个版本
```

两种装法都会把依赖写成 `dsh-mizar@^x.y.z`。升级只要再跑一次 `add dsh-mizar@latest`。

重启后侧边栏会出现 **DSH-Mizar** 面板。

### 为什么是 npm,而不是 GitHub 直装

| | **npm(推荐)** | GitHub 直装 |
|---|---|---|
| 版本 | 有版本号,可锁 `@0.8.3` | 跟随 `main` 最新提交,不可锁 |
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
dsh plugin --profile desktop add /path/to/dsh-mizar-0.8.3.tgz
```

### 装不到最新版 / 镜像同步延迟

插件发布在 npm 官方源(`registry.npmjs.org`)。国内镜像(如 `registry.npmmirror.com`)偶尔滞后,
表现是 `pnpm` 抓到一个旧的或占位版本。两种情况:

- **加 `--registry` 直连官方源**:
  ```sh
  dsh plugin --profile desktop add dsh-mizar@0.8.3 --registry=https://registry.npmjs.org
  ```
- 或者去 [npmmirror 同步页](https://npmmirror.com/sync/dsh-mizar) 点一次「同步」,等镜像更新。

> GUI 的安装框走的是本机默认 registry;镜像没同步时,用上面的 CLI 命令更稳。

### 版本必须与 DSH 对齐

DSH 会**精确比对**插件声明的 `@deepseek-ai/dsh-*` 与运行时版本，不匹配时安装会被拒绝：

```
Plugin dsh-mizar@0.8.3 is incompatible with dsh 0.2.1-rc.2
```

- 正常做法：升级到匹配的插件版本（DSH 每个 rc 发布后，插件跟一个 `+0.0.1`）；
- 临时跑起来（**有风险**，只在确认没有 API 变更时用）：
  ```sh
  dsh plugin --profile desktop allow-version dsh-mizar@0.8.3 --dsh-version 0.2.1-rc.2 --accept-risk
  ```

## 二、配对

1. 电脑上打开 DSH，点侧边栏的 **DSH-Mizar**
2. 面板里会出现二维码
3. 手机装好 App 后扫码

**没有别的步骤。** 不用填 token，不用填地址，不用改文件。

## 三、插件做什么

- 把会话列表、对话正文、用量、审批和提问转给手机
- 手机可以发消息、打断正在跑的 turn、回答审批和提问、切换模型与权限
- 推送（审批 / 提问 / 跑完）经中继转给 Apple
- 手机和电脑在同一个 Wi-Fi 时也可以直连，二维码里两条路都带着

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
面板顶部会写原因。默认走中继，只要电脑和手机都能上网就行，不需要在同一个 Wi-Fi。

**面板里没有二维码。**
重启 DSH。装完不重启，插件不会加载。

**想改成局域网直连。**
默认是「有中继就走中继」。二维码里同时带直连地址，App 会先试直连、失败再走中继。

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
