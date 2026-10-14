# 发布到 TestFlight

本机已经验证过的部分，和需要你在 Apple 网站上做的部分，分得很清楚。

## 已验证：产物是合格的

```
scripts/release.sh archive   → ** ARCHIVE SUCCEEDED **
scripts/release.sh export    → ** EXPORT SUCCEEDED **
```

`.devcache/release/export/DSH-Mizar.ipa` 的实际内容：

| 项目 | 值 |
|---|---|
| 版本 | `0.1.0` |
| 构建号 | `1` |
| Bundle ID | `me.shirazu.dshmizar` |
| 签名 | `Apple Distribution: Vreeland Lee (5Q2A46685M)` |
| 图标 | `AppIcon60x60@2x.png`、`AppIcon76x76@2x~ipad.png` |
| 本地化 | `en.lproj`、`zh-Hans.lproj` |
| 出口合规 | `ITSAppUsesNonExemptEncryption = false` |

出口合规那一项**必须在 Info.plist 里声明**。否则每次上传后构建都会卡在
App Store Connect 的 "Missing Compliance"，等你手动回答一个问题。

---

## 需要你做的第一步：建 App 记录

**Xcode 不能替你创建 App Store Connect 的记录**，这一步只能在网页上做，而且
只做一次。

1. 打开 https://appstoreconnect.apple.com → **My Apps** → **+** → **New App**
2. 填写：
   - **Platforms**：iOS
   - **Name**：`DSH-Mizar`（这个名字在 App Store 上必须全局唯一，被占用就换一个，比如 `DSH-Mizar Remote`）
   - **Primary Language**：Chinese (Simplified) 或 English
   - **Bundle ID**：选 `me.shirazu.dshmizar` —— **如果下拉里没有它，说明你的开发者账号里还没有这个 App ID**，先去
     https://developer.apple.com/account/resources/identifiers 注册一个 Explicit App ID
   - **SKU**：随便填一个唯一字符串，比如 `dshmizar001`（用户看不到）
   - **User Access**：Full Access

## 第二步：上传

```bash
scripts/release.sh upload
```

它会归档、导出并直接上传到 App Store Connect。

**上传需要认证。** Xcode 里已经登录了你的账号，所以最省事的方式是
**直接用 Xcode 上传**：

```bash
open .devcache/release/DSH-Mizar.xcarchive
```

Xcode 的 Organizer 会打开 → 点 **Distribute App** → **TestFlight & App Store**
→ 一路下一步。这条路用的是 Xcode 里已登录的凭据，不需要额外配置。

### 想在命令行上传的话

需要一份 App Store Connect API 密钥（比 App 专用密码更可靠）：

1. https://appstoreconnect.apple.com/access/integrations/api → **Team Keys** → **+**
2. 角色选 **App Manager**，生成后**立刻下载 `.p8` 文件**（只能下一次）
3. 记下 **Key ID** 和 **Issuer ID**

```bash
scripts/release.sh archive
xcodebuild -exportArchive \
  -archivePath .devcache/release/DSH-Mizar.xcarchive \
  -exportPath .devcache/release/export \
  -exportOptionsPlist iOS/ExportOptions.plist \
  -allowProvisioningUpdates \
  -authenticationKeyPath ~/Downloads/AuthKey_XXXXXX.p8 \
  -authenticationKeyID XXXXXXXXXX \
  -authenticationKeyIssuerID xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

## 第三步：等待处理

上传成功后构建会出现在 App Store Connect → 你的 App → **TestFlight** 标签页，
状态是 **Processing**。通常 5–15 分钟。

处理完成后可能会显示 **"Missing Compliance"** —— 如果出现了，点进去回答
"Does your app use encryption?"。本项目已经在 Info.plist 里声明了豁免，所以
正常情况下**不该**出现。

## 第四步：加测试人员

TestFlight 标签页 → **Internal Testing** → **+** 建一个测试组 →

- **内部测试**：最多 100 人，必须是你 App Store Connect 团队里的成员，
  **不需要 Apple 审核**，加完立刻能装
- **外部测试**：最多 10000 人，**第一次需要 Apple 审核**（通常 1–2 天）

自己测试的话用内部测试最快。

## 第五步：手机上装

1. App Store 搜 **TestFlight** 装上
2. 用**你接受邀请时用的那个 Apple ID** 登录
3. 会看到 DSH-Mizar，点 **Install**

---

## 版本号怎么改

```bash
# 看当前版本
scripts/release.sh bump
```

改 `iOS/DSH-Mizar.xcodeproj/project.pbxproj` 里的两个值：

- `MARKETING_VERSION` —— 用户看到的版本号，如 `0.1.0`
- `CURRENT_PROJECT_VERSION` —— 构建号，**每次上传必须比上一次大**

`ExportOptions.plist` 里 `manageAppVersionAndBuildNumber` 是 **false**，
所以 Xcode 不会自作主张改构建号。这是故意的：否则上传完之后你无法回答
"这个构建到底是哪一版"。

---

## 一个必须说明的限制

**这个 iOS App 单独装上是用不了的。**

它需要连到一台跑着 DSH 的 Mac，而那台 Mac 上要装 `dsh-mizar` 插件。
测试人员必须同时具备：

1. 一台 Mac，装了 DSH 和本插件
2. Mac 和手机在同一个 Tailscale 网络里（或同一个局域网）
3. 从 Mac 的 DSH Web 面板扫码配对

所以 **TestFlight 的分发范围应该限定在"自己用"或"给你配好 Mac 的人"**。
作为公开 App Store 上架，它没有独立价值 —— 这一点在审核时也会被问到。

如果要发布给不认识的人用，需要的不是 TestFlight，而是：
- Mac 端插件的公开分发方式（npm 包或安装器）
- 一个配对/发现的引导流程
- 或者一个中继服务（见 README 里的架构讨论）
