# 附件扩展验证记录

日期：2026-10-19。基于电脑插件上游 `02d4cc5fc4a3bd633c03a40f9bbab76c4f5b1faa`，Windows / Node24 / DSH 0.2.1-rc.2。

## 构建与单元/集成测试

| 命令 | 结果 |
|---|---|
| `npm run build` | PASS，host与browser产物 |
| `npm run typecheck` | PASS，host与client |
| `npm test -- --maxWorkers=2` | **580/580 PASS，28/28测试文件** |

上游原有497测试保持通过；新增83项：

- `test/attachments.test.ts`：61项，元数据/名称、Base64、边界、乱序与重复块、SHA256、图片签名、设备/会话归属、配额、TTL、并发、清理及Windows私有目录。
- `test/attachment-bridge.test.ts`：16项，真实服务调用形状、DSH receipt、混合/纯附件prompt、旧文字兼容、幂等与冲突、失败保留及成功释放。
- `test/attachment-socket.test.ts`：4项，真实loopback WebSocket认证、分块/重连、设备隔离、撤销和传输边界。
- `test/attachment-composition.test.ts`：2项，真实Cordis Context装配与可选服务查找。

没有移植Android镜像的通知补发代码或相关测试，因此测试数量不同于Android PR内的插件副本。

## 当前分支真实 DSH 端到端验证

隔离profile直接加载本分支的 `lib/index.js`（启动日志版本保留上游0.8.3），不安装到正式profile，不修改用户会话。客户端请求经本地运行的**原版Relay源码**及本分支RelayClient到达该插件。

20个检查全部通过，包括：

1. 经中继配对与认证、附件能力协商、真实DSH创建会话。
2. 一次消息包含PNG、20MiB随机文件、中文名UTF-8文本、PDF运输样本、空ZIP共5件；所有上传完成。
3. 空文本加5附件的 `session.prompt` 被真实DSH接纳。
4. 相同requestId重试只生成一条持久user message；改变文字复用requestId被拒绝。
5. 声明20MiB+1的文件被拒绝。
6. 会话持久日志出现1个图片引用和4个文件引用；4个普通文件的落盘长度与SHA256一致。
7. 离线确定性模型适配器收到图片引用并完成一轮，未调用付费外部模型。

20MiB文件分块时最大的上传payload为87,463字节（不含外层RPC信封），远小于512KiB监听器上限和原中继900KiB上限。

PDF是运输测试用最小样本，ZIP为空ZIP；此项验证字节传输与持久化，不声称验证文档解析效果或模型识图准确率。未进行Android/iOS真机UI测试。

## 公共中继证据边界

既往公共中继探测首次连接返回HTTP429，未进入文件/帧大小测试；没有绕过限制或继续施压。本次端到端验证全在loopback与自有临时房间进行。**没有公共服务器上传成功或其线上配额的保证**。

原始日志含临时配对信息或本机路径，留在本地，不提交到仓库。此文记录已执行结果；单测代码可用上述命令重跑。
