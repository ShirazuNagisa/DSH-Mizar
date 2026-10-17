# Research 0001 — 插件自更新(仅 dsh-mizar)可行性

Status: **暂缓实现**。研究完成于 2026-10-17,对照环境 DSH `0.2.1-rc.2`(桌面端)/ dsh-mizar `0.8.2`。
结论:技术上可行,且不需要 DSH 官方先支持;但它依赖 DSH 内部服务(非公开插件契约),并有两个覆盖不到的盲区。
用户决定暂不实现,重新启动的条件见文末。

> 本文是从运行中的主机、装进 asar 的 DSH 源码和一次 Cordis 语义实验里读出来的,不是设计稿。
> 引用格式为「包名 + 文件 + 函数/行号」,行号以 `0.2.1-rc.2` 的构建为准,升版后会漂移,以函数名为准。

---

## 结论(TL;DR)

- **可行**:dsh-mizar 可以在自己的宿主半侧内置一个"只更新自己"的更新器,发现新版本后借 DSH 的
  `pluginManager` 服务完成安装,**由桌面端 HMR 热替换,不需要用户卸载、通常也不需要重启 DSH**。
- **关键机制只有三条**:
  1. 桌面端 HMR 是开着的,且会替换 `node_modules` 下已加载文件发生变化的插件;
  2. `pluginManager` 是根作用域的 Cordis 服务,任何插件都能 `ctx.get('pluginManager')`,它自带
     profile 写锁、pnpm 子进程管理、manifest/lockfile 快照恢复、版本闸门和安装进度事件;
  3. `installBundle` 只对"安装前就能知道包名"的 spec 做 `already-installed` 拒绝;换一个
     **tarball URL / 带 commit 的 git URL**,包名在安装前不可知,于是可以**原地覆盖安装**。
- **两个盲区必须先接受**:
  1. **DSH 自身升级后,插件可能因版本闸门加载失败——那时插件代码根本没运行,自更新无能为力**,
     仍需手动更新一次插件(或用 `allow-version` 豁免)。这是最大盲区。
  2. 用的是 DSH 内部服务,不是公开契约;DSH 改内部实现就可能失效。缓解办法是特性探测 + CI 守护,
     失效时降级为"只提醒 + 给手动命令"。
- 另有工程性风险:坏版本可能让插件先死掉(回滚是尽力而为)、更新后 profile 依赖会变成 tarball URL、
     信任根变成 npm 账号、更新瞬间 relay 断 1–3 秒。

---

## 一、事实基线(2026-10-17 实测)

| 事实 | 值 |
|---|---|
| DSH 应用 / 运行时 | 桌面 App `0.2.1-rc.2`;宿主进程以 `--expose-internals …/dsh-desktop-host/lib/index.js <asar>/dsh ~/.dsh/profiles/desktop …` 启动 |
| 运行中的 profile | `~/.dsh/profiles/desktop`;`pnpm-workspace.yaml` 为 `packages: ['.']` + `nodeLinker: hoisted`,插件目录是真实目录而非符号链接 |
| 当前安装源 | `package.json`: `"dsh-mizar": "github:ShirazuNagisa/DSH-Mizar"`;lockfile 锁到 commit `17cc12b…`,包内 `version` 为 `0.8.2` |
| npm 上的 0.8.2 | `registry.npmjs.org` 的 `latest = 0.8.2`,但与上面那次 commit **不是同一次构建**;`@deepseek-ai/dsh-base` 的 `next = 0.2.1-rc.2`(与运行时一致,没有更新的版本) |
| HMR | 桌面端开启:launcher 提供 `profileContext` 时由 base 组合包启用,`root: []`(不监听源码,但每次重组仍比对已加载模块文件) |
| 宿主进程用户/目录 | 与普通 Node 进程相同;插件可读 `~/.dsh/profiles/desktop`、可写 `~/.dsh/.mizar` |
| `dsh plugin` | 纯 pnpm 转发器:`--help` 明说 "forwarding the remaining arguments to pnpm in the profile directory",没有 update 子命令 |

---

## 二、为什么现在"没有插件更新"

1. **插件在 DSH 启动时被加载进宿主进程**,更新意味着替换磁盘上的代码并让宿主重新加载;
2. GUI 插件页的「更新」只对**官方按需组合包**提供:Host 只给这类条目返回 `installTarget`
   (`dsh-plugin-manager` `index.js` 的 `listBundles` / `OFFICIAL_ON_DEMAND_CATALOG` 路径),
   第三方包没有它,界面文案写的是"其他插件通过卸载后重新安装升级"
   (`dsh-client-ui-plugin-manager` README / `lib/client.js` 的 `installTarget` 分支);
3. 插件市场只把已安装包标成 `update-available`,升级动作仍是卸载→安装(`dsh-plugin-market` README 已知限制);
4. `pluginManager` 服务里没有 `updateBundle`:只有 `listBundles` / `listPlugins` / `setBundleEnabled` /
   `setPluginEnabled` / `installBundle` / `waitForInstall` / `cancelInstall` / `removeBundle` /
   `registries` / `inspect` / 版本豁免相关方法(`dsh-plugin-manager/lib/index.js` 约 1629–2164 行);
5. 开着 HMR 时,`installBundle` 对"包名已在 profile 依赖里"的 spec 会在 pnpm 之前直接
   `throw ManagementFailure('already-installed')`(`index.js:1990-1991`)——这就是"必须先卸载"的直接原因。

官方自己的"更新"也不是原子操作:**先 `removeBundle`,再 `installBundle` 两个独立调用**
(`dsh-client-ui-plugin-manager/lib/client.js:1162-1181`、`1574-1606`),删除之后安装失败,该包保持未安装。

---

## 三、关键机制(可行性的全部依据)

### 1. HMR 热替换

- `@deepseek-ai/dsh-hmr` 在 base 组合包里,桌面端启用;`root: []` 表示不监听源码文件,
  但 **每次 profile 重组(reconcile)都会比对已加载模块在磁盘上的 inode/size/mtime**,把变化过的
  模块连同其导入方逐出、停掉受影响的运行条目,再导入新文件并启动
  (`dsh-hmr` README「使用本包」段;`lib/index.js` 的 `reconcileProfile` 约 1320 行起)。
- 文档明确覆盖 `node_modules` 下的已安装包:"profile 目录下已加载文件在磁盘上发生变化的插件…包括
  `node_modules` 之下的已安装包,以及已链接包的目标"。
- 重组的触发源:profile `package.json` 的 `dsh.profile.bundles` 变化、profile/home patch 文件变化、
  **以及每一次 `pluginManager` 操作**(`removeBundle`/`installBundle`/`setBundleEnabled` …)。
  单纯的依赖字段变化**不会**触发重组——所以"自己 spawn pnpm 装完就生效"是行不通的,必须走
  `pluginManager` 操作或 patch 变更。
- 替换版本导入/启动失败时:旧插件被停止、模块被逐出、新文件保留,操作报 `failed`(旧代码不再运行);
  之后每次重组都会**再次导入此前失败的条目**,所以把文件修好即可无重启恢复。
- 约束:`hmr.reconcileProfile()` 必须在 `hmr.runExclusive()` 内调用,且 runExclusive 拒绝嵌套
  (`dsh-hmr/lib/index.js` 的 `runExclusive` 约 748 行、`reconcileProfile` 约 1320 行)。
  **绝不能从插件自己的 `apply()` 或 `ctx.effect` 里直接调 reconcile**——会死锁(被替换的就是调用者,
  HMR 要等它的 fiber 停稳)。交给 `pluginManager` 去调,它自己在 `configure()` 里持锁调用。

### 2. `pluginManager` 服务

- 普通 Cordis `Service`,`super(ctx, "pluginManager")`(`index.js:1605`),`inject = ['loader','profileContext']`;
  位于根 isolate 作用域,同一棵树里的任何插件都能 `ctx.get('pluginManager')`(或声明 inject)拿到。
- 宿主侧调用没有调用者身份、权限或"调用者是否还活着"的校验(`@Remote` 只是线上元数据)。
- 关键方法(入参/结果形状来自生成的 `lib/typert.remote-client.js`):
  - `installBundle(spec, { enabled?, saveExact?, requestId?, approvedBuilds?, registry? })`
    → `{ changed, application: 'applied'|'restart-required'|'failed'|'cancelled'|'overridden',
        restartReason?, stage, target, bundle?, version?, packageResult, pendingBuilds?, error? }`
  - `removeBundle(name)` / `waitForInstall(requestId)` / `cancelInstall(requestId)`
  - `listBundles()`(含每个 bundle 的 `version`、`source`、`installed`、`enabled`、`rows`、`error`)
  - `registries()`(配置里的 registry 集合 + pnpm 自身指向的源,含 npmmirror 回退)
  - `inspect(spec, options?, signal?)`(安装前读出 spec 指向什么、`already-installed` 等拒绝原因)
- `change()` 对整次操作持有 **profile 的 `package.json.lock`**(`index.js:2373-2400`),所以并发的手动
  插件操作会串行;`installBundle` 在 pnpm 之前快照 `package.json` + `pnpm-lock.yaml`,失败时恢复
  (兼容性拒绝还会按恢复后的锁文件 `pnpm install --frozen-lockfile` 把 `node_modules` 也还原)。

### 3. `installBundle` 的 `already-installed` 与"覆盖安装"旁路

- 拒绝条件(`index.js:1990-1991`):`ownerContext.get('hmr') !== undefined`
  **且** `specPackageName(spec, 当前依赖) !== undefined`
  **且** 该名字已在依赖里。
- `specPackageName`(`index.js:1373-1378`)只对 registry spec(返回 `name`)和本地路径(读 package.json
  取 `name`)给得出名字;对 **git / tarball URL** 会在"依赖里已保存的 spec 字符串"中找匹配——换一个
  **不同的字符串**(新的 tarball URL,或带新 commit 的 git URL)就找不到,于是返回 `undefined`,
  **不触发拒绝**,继续走 pnpm。
- 之后 `installBundle` 用"安装前后依赖值的变化"定位装进来的包名(`installed[0]`),读新 manifest,
  做兼容性检查,选入 bundle(已选则 no-op),再 `publishAndReload()` → `hmr.reconcileProfile()`。
  对已加载的插件来说,这就是**原地热替换**。
- 结论:**"覆盖安装"是自更新最省事、失败面最小的应用方式**。代价是 profile 依赖从
  `^x.y.z`(或 git URL)变成 tarball URL;功能正常,只是 `listBundles().source` 和 GUI 里的"来源"会显示 URL,
  手动 `dsh plugin add dsh-mizar` 可以再归一化。

### 4. 版本闸门与自动回滚

- 闸门:插件 manifest 的 `engines.dsh` 与 `@deepseek-ai/dsh-*` peer 必须与运行中的 DSH 版本吻合
  (`evaluatePluginCompatibility`;运行时版本由 `app-boot/lib/index.js:271` 的 `getDshRuntimeVersion()` 读出)。
  **本插件的发布版本是刻意与 DSH 运行时精确对齐的**,所以自更新只能选"peer 与当前运行时一致"的版本;
  没有兼容新版本时,正确行为是"等 DSH 升级",而不是硬装。
- registry spec 的闸门在 pnpm **之前**(`pnpm view` 预检);tarball / git spec 只能装完再判,
  拒绝时会恢复 manifest+lockfile 并按旧锁文件重装 `node_modules`(`operations.js` 约 535-557 行),
  旧版本继续可用——这层回滚是白送的,自更新可以直接利用。
- pnpm 本身失败时只恢复 manifest+lockfile,**不恢复 `node_modules`**(`installBundle` 的 catch 只
  `restoreFiles`)。自己做覆盖安装时,应在 apply 前 `cp -a node_modules/dsh-mizar` 留一份备份,
  pnpm 失败且旧代码仍在跑时还原之。

### 5. 重启与没有 HMR 的宿主

- 没有 HMR 时 `installBundle` 返回 `application: 'restart-required'` + `restartReason: 'no-hmr'`,
  GUI 用 toast 提示"重启 DSH 生效"(`dsh-client-ui-plugin-manager/lib/client.js` 的 restart 文案);
- **没有受支持的编程式重启**:desktop-host 的 host↔Electron IPC 只有 `shutdown`/`quit-inspection`/
  `update-tasks`;`app.relaunch()` 只出现在崩溃恢复、开发菜单和 App 自动更新路径里。重启 = 用户 ⌘Q 再打开。
- Headless/SDK 组合包会禁用 HMR 或拒绝移除运行中的 bundle(`stop-profile`),这类 profile 上只能
  "检查 + 提醒 + 给手动命令"。

---

## 四、方案 A(推荐):宿主侧自更新器(覆盖安装)

### 设计

只针对本插件,硬编码包名 `dsh-mizar`;不更新其他插件,不更新 DSH 本体。

- 新增 `src/update/`:
  - `version.ts` — semver 比较、兼容性筛选(纯函数,易测);
  - `registry.ts` — 查 npm registry 元数据(`dist-tags`、所有 `versions`、`dist.integrity`、peerDependencies);
    优先用 `ctx.get('pluginManager').registries()` 给出的源(pnpm 配置 + npmmirror 回退),没有 pluginManager 时
    才直连官方源;
  - `journal.ts` — 读写 `~/.dsh/.mizar/update.json`;
  - `manager.ts` — 检测、apply、(尽力)回滚;所有外部依赖(fetch、pluginManager、clock、logger)注入以便测试。
- 现状读取:`pm.listBundles()` 找到自己,拿 `version` 与 `source`(判断安装渠道);运行时版本用
  `getDshRuntimeVersion()`(来自 `@deepseek-ai/dsh-app-boot`),失败时退回"本插件声明的 peer 版本"
  (插件能加载,说明闸门已过,通常两者相等;用户开过版本豁免时可能不等,此时偏保守)。
- 候选版本:所有已发布版本里,`@deepseek-ai/*` peer 全部与运行时吻合、且(默认)不带 prerelease、
  发布已满 `minAgeHours`(默认 24)的最高版本。没有 → 状态 `up-to-date` 或 `no-compatible`。
- 应用:`pm.installBundle(<tarball URL>, { enabled: true, requestId, saveExact: true })`。
  - tarball URL 用回答版本信息的那一个 registry 的 `dist.tarball`(大陆镜像可用),可选地先下载并核对
    `dist.integrity`(sha512)再交给 pnpm;
  - 安装完成后 `application: 'applied'` 表示 HMR 已热替换;`restart-required` 表示缺少 HMR,提示重启;
    `failed`/抛错表示未替换,按失败处理并视情况还原 `node_modules` 备份。
- **不要**在插件 `apply()` 里同步等待安装;从 HTTP 路由(已有的 `/api/mizar.*` fetch 路由)或定时器里发起,
  先 ack 再异步跑,状态走 journal 和轮询,避免"响应还没发出去插件就被替换"。
- 升级成功后的确认:journal 里写 `{ from, to, spec, backup, startedAt, pid }`;新实例启动时读到 journal、
  版本等于 `to` → 记成功、清 journal、通知面板(可选推送);旧实例若等到了结果但版本没变 → 记失败、清 journal。

### 状态机(面板卡片)

`idle → checking → up-to-date | available | no-compatible | error → applying → updated | restart-required | failed`

状态搭现有面板的 2 秒轮询(`/api/mizar.status`)一起返回,新增两个 POST:
`/api/mizar.update.check`、`/api/mizar.update.apply`。apply 只负责发起并立即返回,结果靠轮询,
这样即使宿主半侧被替换,页面也能从 journal 恢复状态。

### 策略与默认值

- `notify`(默认):发现新版本 → 面板角标/说明 + 可选 iPhone 推送;用户点「立即更新」才应用;
- `auto`(需用户显式开启):仅在同时满足以下条件时自动应用:
  HMR 在线、`pluginManager` 可用、没有正在运行的会话回合、距上次尝试超过退避窗口、
  目标版本发布已满 `minAgeHours`、候选版本与当前运行时精确对齐;
- `off`:只显示当前版本;
- 检查频率:插件启动后随机延迟、之后每 `checkIntervalHours`(默认 24)一次;失败指数退避。

### 回滚(尽力而为,按顺序)

1. **兼容性拒绝**:DSH 自己恢复 manifest+lockfile+`node_modules`,旧插件继续跑——无需处理;
2. **pnpm/校验失败、尚未重组**:旧代码仍在跑,捕获回调 → 还原 apply 前备份的 `node_modules/dsh-mizar`
   与(必要时的)manifest+lockfile → 报 `failed`;
3. **新版本导入/启动失败**(重组失败,旧代码已停):旧实例的异步 catch 里用
   `pm.installBundle(<旧版本 tarball URL>)` 装回,HMR 会重新导入失败的条目,旧代码恢复;
   若 catch 没能执行(例如宿主重启),下次启动会加载坏文件——所以在 apply 前额外留一个**不随插件销毁
   被清掉的 watchdog**(裸 `setTimeout`,不挂 `ctx.effect`),超时后核对 journal 与 `listBundles().version`,
   必要时装回旧 tarball;
4. **最坏情况**:文件仍是坏的且自动回滚失败 → 按 README 手动
   `dsh plugin --profile desktop add dsh-mizar@<旧版本>` 后重启 DSH。

### UI 与推送

- 面板新增「版本与更新」卡片:当前版本、安装渠道、最新兼容版本、检查/更新按钮、自动更新开关、上次检查时间;
- 文案走插件现有 `client/src/i18n.ts`(中/英),样式复用现有卡片;
- 可选:给 iPhone 发一条"插件已更新/可更新"的推送——relay 对 `PushKind` 是透传的,插件加新 kind、
  iOS 端补映射即可;不做也不影响主流程。

---

## 五、方案 B(备选,未采纳)

| 方案 | 做法 | 优点 | 问题 |
|---|---|---|---|
| B1 官方同款"卸载→安装" | 宿主或客户端先 `removeBundle` 再 `installBundle('dsh-mizar@x.y.z', {saveExact:true})` | 依赖是干净的 `^x.y.z`;与官方流程一致 | 两个调用**非原子**;第一次调用会停掉自己,第二次由被逐出的代码发起(未集成验证);第二次失败则包未安装;期间插件完全离线 |
| B2 客户端驱动 | 面板注入 `ctx.remote.pluginManager`,由浏览器半侧执行 B1 | 浏览器页面不随插件卸载而消失,是最接近官方的"外部 actor",可显示进度、可重试 | 只有页面开着时可行,无法自动;同样非原子 |
| B3 独立 updater bundle | 另发一个小包常驻,由它更新 dsh-mizar | 不自我卸载,最稳,可完整 await/重试/回滚 | 用户要装两个包;发布、版本对齐、协议都翻倍 |
| B4 自己 spawn pnpm | 插件直接 `dsh plugin add …` | 看起来简单 | **已否决**:绕开 profile 写锁与 `run.json`、绕开兼容闸门、失败只恢复清单不恢复 `node_modules`;pnpm 退出后也没有任何东西触发 HMR 重组,还得再想办法触发重组;detached 子进程在退出 DSH 后可能变僵尸 |
| B5 等上游 | 给 DSH 提需求:第三方包也支持 `updateBundle` / `dsh plugin update` | 最正确、长期最稳 | 不可控;当前 `next = 0.2.1-rc.2`,没有相关能力 |

自更新器应把 apply 层抽象出来(B5 出现后切换),并**在手动路径里提供 B1/B2 的"干净更新"入口**作为补充。

---

## 六、风险与边界

1. **DSH 升级盲区(最重要)**:插件 peer 与运行时的精确对齐意味着 DSH 升到新 rc 后,旧插件会被闸门拒绝加载;
   插件不运行,自更新也就无从执行,仍需手动更新一次插件(或 `allow-version`)。可以在 iOS/面板侧做
   "DSH 已升级、请更新插件"的提示,但不能自动完成。
2. **非公开契约**:`pluginManager` 的方法、`installBundle` 的绕过规则、HMR 语义都可能随 DSH 变化;
   要做特性探测、失败关闭(fallback 到"只提醒"),并让 rc-watch CI 覆盖。
3. **坏版本**:自动更新等于自动执行新代码;回滚是尽力而为。缓解:发布前跑满测试、发布后 24h 才自动装、
   只对精确对齐运行时的版本自动应用、保留 journal 与备份。
4. **供应链**:信任根变成 npm 账号。已开 2FA;后续可上 GitHub Actions + `npm publish --provenance`,
   更新器只装官方 registry(或用户配置的镜像)上本包发布的 tarball,不装任意 URL。
5. **观感/元数据**:依赖变成 tarball URL,`listBundles().source` 与 GUI"来源"不再显示 npm 版本范围;
   手动 `add` 可归一化。
6. **短暂断连**:更新瞬间旧插件停止、relay WebSocket 关闭,新实例起来后重连(约 1–3 秒);
   iOS 现有重连逻辑可覆盖;应避免在正在跑任务时自动更新。
7. **首次鸡生蛋**:带更新器的版本必须**手动装一次**(当前 profile 是 git 安装,第一次自更新会顺便把源切到 npm)。
8. **配置/隐私**:检查更新只需请求 registry 元数据,不发送设备或会话信息;与现有 relay 出网行为一致。

---

## 七、若将来实现:改动清单与验证

**改动(预计 v0.9.0,1–2 天)**

- 新增 `src/update/{version,registry,journal,manager}.ts`;
- `src/panel/api.ts` 加 `update.check` / `update.apply` 路由(沿用 `scoped.connection.fetch.register` 模式);
- `src/panel/status.ts` 的 `PanelStatus` 增加 update 状态;
- `client/src/panel.tsx` 加「版本与更新」卡片,`client/src/i18n.ts` 加中英文案,`client/src/styles.ts` 复用现有卡片样式;
- `src/index.ts` 里可选取 `ctx.get('pluginManager')` / `ctx.get('profileContext')`,缺失时降级;
- `package.json` 增加 `@deepseek-ai/dsh-app-boot` peer(取运行时版本)与对应 dev 版本;
- 测试:纯函数(版本选择/兼容性/spec 生成)、journal 恢复、fake pluginManager 的状态机、面板渲染、
  bundle 基线约束(`client/build.mjs` 只允许基线 externals);真实宿主另做 spike。
- `MIZAR_VERSION`(当前 `src/index.ts:86` 硬编码 `0.8.2`)改为从自身 package.json 读,避免两处漂移。

**必须先做的 spike(真宿主,开发 profile,不碰用户桌面 profile)**

1. 在 `mizar-dev` profile 上装一个 dev tarball,面板触发一次真实 `installBundle(tarball URL)`,
   确认:HMR 热替换、无需重启、relay 重连、新版本自报版本、journal 清理;
2. 故意发布一个 `apply()` 抛错的 dev 版本,确认回滚路径(旧实例 catch / watchdog)能装回旧版并恢复;
3. 无 HMR 的模拟宿主,确认 `restart-required` 与降级提示;
4. 并发一次手动插件操作,确认 profile 锁串行、不会互相覆盖。

**待验证的开放问题**

- 插件发起 `pm.installBundle` 后自身被 HMR 逐出:代码级已确认 Cordis 不会取消 detached 异步任务、
  被 dispose 后 `ctx.get` 仍可用(2026-10-17 本地 Cordis 语义实验);但**真实的 pluginManager 集成调用
  尚未跑过**,spike 第 1 项就是要验证它。
- 生产构建下浏览器半侧会不会随 `lib/client.js` 变化自动重载(dev 有 bundle watcher;
  生产只有插件图更新)——不自动重载就提示刷新页面。
- 本地 tarball 备份与镜像 registry 的 tarball URL 在 lockfile 里的长期可用性。

---

## 八、证据与出处

- HMR 语义、触发源、失败行为、`runExclusive`/`reconcileProfile`:
  `@deepseek-ai/dsh-hmr` README 与 `lib/index.js`(`runExclusive` 约 748、`reconcileProfile` 约 1320)。
- `pluginManager` 服务与方法、`already-installed` 守卫、`specPackageName`、`change()` 写锁:
  `@deepseek-ai/dsh-plugin-manager/lib/index.js`(服务约 1605、`installBundle` 约 1970、守卫 1991、
  `specPackageName` 1373、`change` 约 2373),README「使用本包 / 理解实现」。
- 兼容性闸门与回滚:`@deepseek-ai/dsh-app-boot/lib/index.js:271,311`;
  `@deepseek-ai/dsh-plugin-manager/lib/types/operations.js`(快照/恢复、兼容拒绝后 `pnpm install --frozen-lockfile`);
  `lib/typert.remote-client.js` 的 `installBundle` 结果 schema。
- 官方更新 = remove→install、只给官方按需包:`@deepseek-ai/dsh-client-ui-plugin-manager`
  README 与 `lib/client.js`(removeBundle 约 1174、`installTarget` 分支约 1164)、
  `@deepseek-ai/dsh-plugin-market` README「已知限制」。
- 无编程式重启:desktop-host IPC 通道(只有 shutdown / quit-inspection / update-tasks)与
  Electron 主进程里 `app.relaunch()` 的用途(崩溃恢复/开发菜单/App 更新)。
- 本插件集成点:`src/index.ts:86`(`MIZAR_VERSION`)、`src/index.ts:96`(`inject`)、
  `src/panel/api.ts:31/102/136`(面板 fetch 路由)、`client/src/panel.tsx:120`(`/api/mizar.status` 轮询)、
  `client/build.mjs`(客户端基线 externals)、`test/client-bundle.test.ts`(基线约束)。
- 机制类结论均读自上述源码/文档;唯一"实验类"结论是 `2026-10-17` 的本地 Cordis 语义实验
  (被 dispose 的 fiber 的 detached 异步任务仍会完成、`ctx.get` 仍可用),脚本未提交,结论需 spike 复核。

---

## 九、重新评估的触发条件

- DSH 上游出现 `updateBundle` / `dsh plugin update` / 第三方包更新 UI;
- 用户明确要求自动跟随插件更新;
- 插件发布频率上升、或"DSH 升级后插件忘记手动更新导致连不上"成为实际故障;
- 准备下一次 DSH 运行时大版本升级之前(自更新 + 升级提示可以一起做)。
