# DSH-Mizar 插件

用手机看 DSH Agent 干活，也能给它发消息、回答审批。

这个仓库是 **Mac 侧插件**（DSH 的一个 Cordis 插件）。另外两个仓库：

| | |
|---|---|
| **DSH-Mizar-iOS** | 手机 App（iOS / iPadOS） |
| **DSH-Mizar-Relay** | 中继服务器，让手机从任何网络连上你的 Mac |

## 一、装插件

```sh
dsh plugin --profile desktop add ShirazuNagisa/DSH-Mizar
```

**然后重启 DSH。** 插件只在启动时加载，不重启等于没装。

重启后侧边栏会出现 **DSH-Mizar** 面板。

## 二、配对

1. Mac 上打开 DSH，点侧边栏的 **DSH-Mizar**
2. 面板里会出现二维码
3. 手机装好 App 后扫码

**没有别的步骤。** 不用填 token，不用填地址，不用改文件。

## 三、插件做什么

- 把会话列表、对话正文、用量、审批和提问转给手机
- 手机可以发消息、打断正在跑的 turn、回答审批和提问、切换模型与权限
- 推送（审批 / 提问 / 跑完）经中继转给 Apple
- 手机和 Mac 在同一个 Wi-Fi 时也可以直连，二维码里两条路都带着

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

推送要 Apple 的签名密钥，密钥只能放在服务器上（放在插件里就等于公开）。**用官方中继
什么都不用做**；自建中继需要配 `apns`，见 [relay-deployment.md 第 10 节](docs/relay-deployment.md)。

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
面板顶部会写原因。默认走中继，只要 Mac 和手机都能上网就行，不需要在同一个 Wi-Fi。

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

协议、架构决策、自建中继：[docs/](docs/)
