# DSH-Mizar

用手机看 DSH Agent 干活，也能给它发消息、回答审批。

一个 DSH 插件 + 一个 iOS/iPad App。

## 一、装插件

```sh
dsh plugin --profile desktop add ShirazuNagisa/DSH-Mizar
```

**然后重启 DSH。** 插件只在启动时加载，不重启等于没装。

重启后侧边栏会出现 **DSH-Mizar** 面板。

## 二、装 App

两个客户端说同一套协议，选一个装就行。

### iPhone / iPad

App 还没上 TestFlight，暂时要自己编译。

```sh
git clone git@github.com:ShirazuNagisa/DSH-Mizar.git
cd DSH-Mizar

scripts/ios.sh run        # 装进模拟器
```

**装到真机**：用 Xcode 打开 `iOS/DSH-Mizar.xcodeproj`，在 Signing 里选自己的开发者账号，
然后选你的设备运行。

### Android

```sh
cd Android
./gradlew :app:assembleDebug
adb install -r app/build/outputs/apk/debug/app-debug.apk
```

推送（FCM）是可选的：把 Firebase 的 `google-services.json` 放进 `Android/app/` 并在中继上配好
FCM 服务账号就会生效，不放也能正常用——只是没有后台通知。构建环境、镜像与已知的平台差异见
[Android 客户端](docs/android.md)。

## 三、配对

1. Mac 上打开 DSH，点侧边栏的 **DSH-Mizar**
2. 面板里会出现二维码
3. 手机打开 App，扫码

**没有别的步骤。** 不用填 token，不用填地址，不用改文件。

## 四、能做什么

- 看会话列表和对话正文
- 发消息，打断正在跑的 turn
- 回答审批和提问
- 看用量、缓存命中、上下文占用
- 切换模型、思考强度、权限
- 历史存在手机上：断网也看得到会话、标题、模型和上下文用量

每一轮默认折叠成一条「已完成，用时 xx」，点开看这一轮的所有步骤。**还在跑的那一轮写的是「正在处理，已用时 xx」**，并且只显示状态、不把当时最后一条消息当成结论。

## 五、通知

三种情况下手机会收到推送，Mac 上的插件通过中继发给 Apple：

- Agent 卡在**权限审批**上，等你点头
- Agent 卡在**提问**上，等你回答
- 某个会话**跑完了**
- （跑挂/中断了会说挂掉，不会谎报完成）

**一轮结束不会立刻推。** DSH 里一个指令常常连着跑好几个 turn，每个 turn 都推一次等于一个指令三条通知 —— 所以插件会等这个会话安静 15 秒才发。正在看着 App 的时候什么都不发。

推送要 Apple 的签名密钥，而密钥只能放在服务器上（放在插件里就等于公开）。**用官方中继的话什么都不用做**；自建中继需要配 `apns`，步骤见 [relay-deployment.md 第 10 节](docs/relay-deployment.md)。

第一次打开 App 会依次问通知权限和本地网络权限（两个系统弹窗，不会同时出现）。相机权限只在点「扫码」的那一刻才问 —— 一个大部分会话都用不上的权限，在启动时问就是在教人闭着眼睛点「不允许」。

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
按顺序查：App 里「设置 → 通知」有没有允许；Mac 的插件日志里有没有 `push: registered …` 这一行（说明手机把推送令牌交上来了）；中继上 `curl localhost:8787/healthz` 的 `pushDevices` 是不是大于 0。三条都对还是没有，看中继日志里 Apple 回的是什么 —— `BadDeviceToken` 基本就是 `MIZAR_APNS_ENV` 选错了。

---

开发、架构、协议、自建中继：[docs/](docs/)；Android 端的构建与平台差异：[docs/android.md](docs/android.md)。
