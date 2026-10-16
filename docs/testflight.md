# 发布到 TestFlight — 网页操作全流程

产物已经就绪（`scripts/release.sh archive|export` 都成功过），剩下一半只能在网页上做。

## 先抄这些值

下面每一步要填的东西都在这里，**从这张表复制，不要凭记忆**：

| 字段 | 值 |
|---|---|
| **Bundle ID** | `me.shirazu.dshmizar` |
| **显示名** | `DSH-Mizar` |
| **版本号** | `0.7.1` |
| **构建号** | `12` |
| **Team ID** | `5Q2A46685M` |
| 团队名 | Vreeland Lee |
| 签名身份 | `Apple Distribution: Vreeland Lee (5Q2A46685M)` |
| 建议 SKU | `dshmizar001` |
| 主要语言 | Chinese (Simplified) 或 English |
| 支持设备 | iPhone + iPad |
| 本地化 | `en`、`zh-Hans` |
| 出口合规 | 已在 Info.plist 声明豁免 |

---

## 第 1 步：确认 App ID 已注册

**打开**：https://developer.apple.com/account/resources/identifiers/list

在列表里找 **`me.shirazu.dshmizar`**。

- **有** → 跳到第 2 步
- **没有** → 点右上角 **`+`**
  1. 选 **App IDs** → **Continue**
  2. 类型选 **App** → **Continue**
  3. **Description**：`DSH-Mizar`
  4. **Bundle ID**：选 **Explicit**，填 `me.shirazu.dshmizar`
  5. **Capabilities**：勾上 **Push Notifications**
     （通知要用它。不勾的话真机上 `registerForRemoteNotifications()` 会静默失败：
     权限弹窗问了、用户点了允许、然后什么都不会到 —— 这是最难查的一种坏法。
     其余 iCloud、App Groups 都不用勾）
  6. **Continue** → **Register**

> ⚠️ `me.shirazu.dshmizar` **必须和 Xcode 工程里完全一致**，包括大小写。
> 拼错了后面第 2 步的下拉框里就找不到它。

---

## 第 2 步：创建 App 记录

**这一步 Xcode 替你做不了**，只能在网页上做，而且**一个 Bundle ID 只做一次**。
我第一次试上传时它就停在这里，报 `Downloading App Information`。

产物都在 **`release/`**（工作区根目录，非隐藏）：

```
release/
├─ DSH-Mizar.xcarchive        ← 双击打开 Organizer，用它上传
├─ export/DSH-Mizar.ipa       ← 已签名的构建，可以手动用 Transporter 上传
└─ dsh-mizar-0.1.0.tgz        ← Mac 端插件本体（npm 包，装到 DSH 里）
```

---

**打开**：https://appstoreconnect.apple.com/apps

1. 点左上角的 **`+`** → **New App**
2. 弹窗里填：

| 字段 | 填什么 |
|---|---|
| **Platforms** | 勾 **iOS** |
| **Name** | `DSH-Mizar` |
| **Primary Language** | Chinese (Simplified) |
| **Bundle ID** | 下拉选 `me.shirazu.dshmizar` |
| **SKU** | `dshmizar001`（用户看不到，随便填，唯一即可） |
| **User Access** | Full Access |

3. 点 **Create**

> **Name 是全局唯一的。** 如果 `DSH-Mizar` 被占用了，换一个比如
> `DSH-Mizar Remote` —— **只影响 App Store 上显示的名字**，不影响 Bundle ID，
> 也不影响手机上装出来的名字（那个由 `CFBundleDisplayName` 决定，是 `DSH-Mizar`）。

> **Bundle ID 下拉里找不到它？** 说明第 1 步没做，或者拼错了。回去做第 1 步。

---

## 第 3 步：上传构建

这一步**不在网页上**，但做完之后剩下的都在网页上。

**最省事的方式**（用你 Xcode 里已登录的账号，不需要额外配任何密钥）：

```bash
open release/DSH-Mizar.xcarchive
```

Xcode 的 **Organizer** 会打开：

1. 选中 **DSH-Mizar 0.1.0 (1)**
2. 点右侧 **Distribute App**
3. 选 **TestFlight & App Store** → **Distribute**
4. 后面一路默认：
   - **Upload**（不是 Export）
   - **Automatically manage signing**
   - 最后点 **Upload**
5. 等进度条走完，出现 **Upload Successful**

> 命令行也可以（`scripts/release.sh upload`），但需要一份 App Store Connect
> API 密钥。网页这边走 Organizer 更快。

---

## 第 4 步：等它处理完

回到 **https://appstoreconnect.apple.com/apps** → 点进 **DSH-Mizar** →
左侧 **TestFlight** 标签。

构建会显示 **Processing**（正在处理），通常 **5–15 分钟**。

处理完状态变成 **Ready to Submit** 或出现在构建列表里。

### 如果出现 "Missing Compliance"

正常情况下**不该出现**——我已经在 `Info.plist` 里声明了
`ITSAppUsesNonExemptEncryption = false`。

万一出现了，点那个黄色提示进去回答：

> **Does your app use encryption?**
> 选 **No**（或者选 "it uses only exempt encryption"）

这个 App 只用系统的 HTTPS/TLS，属于豁免范围。

---

## 第 5 步：加测试人员

左侧 **TestFlight** → **Internal Testing**（内部测试）

1. 点 **`+`** 建一个测试组，名字随便，比如 `Me`
2. 点 **`+`** 往组里加人：
   - **内部测试**：只能加你 App Store Connect 团队里的成员。
     一个个人开发者账号通常就是你自己，**用你的 Apple ID 邮箱**
   - **不需要 Apple 审核**，加完立刻能装 ← **自己测试走这条最快**
3. 加完在构建那一栏点 **`+`** → 选 `0.1.0 (1)` → **Add**

> **外部测试**（External Testing）可以加最多 10000 人，但**第一次需要 Apple 审核**，
> 通常 1–2 天。自己用不上走这条。

---

## 第 6 步：手机上装

1. App Store 搜 **TestFlight**，装上（Apple 官方出品，免费）
2. 打开 TestFlight，用**你接受邀请时用的那个 Apple ID** 登录
3. 会看到 **DSH-Mizar**，点 **Install**
4. 装完直接从 TestFlight 里打开

---

## 常见卡点

| 现象 | 原因 | 怎么办 |
|---|---|---|
| `Downloading App Information` 报错 | App 记录还没建 | 做第 2 步 |
| Bundle ID 下拉里没有 | App ID 没注册 / 拼写不符 | 做第 1 步 |
| Name 报"已被使用" | 名字全局唯一 | 换一个名字，Bundle ID 不变 |
| 卡在 Processing 超过 1 小时 | 偶发 | 换个构建号重新上传一次 |
| 出现 Missing Compliance | 罕见 | 按第 4 步回答 |
| 构建传上去了但 TestFlight 里没有 | 少了出口合规回答，或没加进测试组 | 检查第 4、5 步 |
| 想传第二次 | **构建号必须更大** | 见下 |

### 传第二个构建的时候

改 `iOS/DSH-Mizar.xcodeproj/project.pbxproj` 里这两个值：

- `MARKETING_VERSION` → 用户看到的版本，例如 `0.1.1`
- `CURRENT_PROJECT_VERSION` → 构建号，**必须比上一次大**（`1` → `2`）

`ExportOptions.plist` 里 `manageAppVersionAndBuildNumber` 是 **false**，
所以 Xcode 不会自作主张改构建号。这是故意的：否则上传完之后你无法回答
"这个构建到底是哪一版"。

然后重新 `scripts/release.sh archive` 再走第 3 步。

---

## 必须说清楚的一件事

**这个 App 单独装上是用不了的。**

它要连到一台跑着 DSH 的 Mac，而那台 Mac 上要装 `dsh-mizar` 插件。测试人员必须同时有：

1. 一台 Mac，装了 DSH 和本插件
2. Mac 和手机在同一个局域网，或 Mac 已经连上中继（见 [中继部署](relay-deployment.md)）
3. 从 Mac 的 DSH Web 面板扫码配对

所以 **TestFlight 的适用范围是"你自己"或"你帮忙配好 Mac 的人"**。作为公开上架它没有
独立价值，审核时也会被问到"用户拿到这个 App 能做什么"。

要发布给不认识的人，缺的不是 TestFlight，而是：Mac 端插件的公开分发方式 + 配对引导
流程，或者一个中继服务。
