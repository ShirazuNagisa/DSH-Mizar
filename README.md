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

App 还没上 TestFlight，暂时要自己编译。

```sh
git clone git@github.com:ShirazuNagisa/DSH-Mizar.git
cd DSH-Mizar

scripts/ios.sh run        # 装进模拟器
```

**装到真机**：用 Xcode 打开 `iOS/DSH-Mizar.xcodeproj`，在 Signing 里选自己的开发者账号，
然后选你的设备运行。

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

每一轮默认折叠成一条「已完成，用时 xx」，点开看这一轮的所有步骤。

## 常见问题

**手机连不上。**
面板顶部会写原因。默认走中继，只要 Mac 和手机都能上网就行，不需要在同一个 Wi-Fi。

**面板里没有二维码。**
重启 DSH。装完不重启，插件不会加载。

**想改成局域网直连。**
默认是「有中继就走中继」。二维码里同时带直连地址，App 会先试直连、失败再走中继。

**插件版本对不对。**
DSH 启动日志里有 `[mizar] dsh-mizar <版本号> · state: … · devices: N live` 这一行。

---

开发、架构、协议、自建中继：[docs/](docs/)
