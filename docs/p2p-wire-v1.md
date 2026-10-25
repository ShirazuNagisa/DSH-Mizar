# MizarNet wire format v1（直连路径）

这是 P2P 直连路径的**线格式规范**，以及它的两份实现：

| 实现 | 位置 | 状态 |
|---|---|---|
| Swift（iOS 内核） | `iOS/MizarKit/Sources/MizarKit/Net/` | 完整：编解码、STUN、打洞、会话 |
| TypeScript（插件） | `src/transport/p2p/`（`wire.ts` / `crypto.ts` / `encoding.ts`） | 编解码与加密层已落地；socket / STUN / 会话 / 引擎待接 |

两份实现由**同一份 fixture** 交叉验证：`protocol/fixtures/p2p/wire.json`。
Swift 侧写入、TypeScript 侧读取，任何一侧改动而另一侧没跟上，测试就会红。

## 1. 报文

所有整数大端。固定 15 字节头：

```
magic "MZP1" (4) | type (1) | connection id (8) | payload length (2)
```

`connection id` 是 64 位无符号整数，在 TypeScript 里必须用 `bigint`——它随机覆盖整个
64 位空间，超过 2^53 的值放进 `number` 会被静默取整，于是包被发往一个不存在的连接。

| type | 名称 | 载荷 |
|---|---|---|
| 1 | ClientHello | `ephemeral pk (32) ‖ idLen (1) ‖ endpoint id ‖ signature (64)` |
| 2 | ServerHello | 同上 |
| 3 | Data | `packet number (4) ‖ ack count (1) ‖ acks (4×n) ‖ message length (4) ‖ sealed` |
| 4 | Keepalive | 空 |
| 5 | Close | `reasonLen (1) ‖ reason` |
| 6 | Ack | `ack count (1) ‖ acks (4×n)` |

`payload length` 必须与数据报实际长度**严格相等**：一个 UDP 数据报就是一个包，
长度不符的包要么损坏要么不属于本协议，折中处理只会把错误边界递给会话。

hello 就是打洞探针——没有单独的探测阶段，第一跳即是加密握手。

## 2. 握手

签名覆盖的字节（`handshakeMessage`）：

```
type (1) ‖ connection id (8) ‖ ephemeral public key (32) ‖ endpoint id (utf8)
```

类型字节是域分隔：同一个密钥签出的 ClientHello 不能当作 ServerHello 通过验证
（否则 hello 会被反射回发送方）。连接 id 也在签名内，包不能被搬到另一个连接。

身份是**派生**的，不是生成的：

```
seed = SHA-256(secret ‖ purpose ‖ 0x01)
purpose = "mizar-net/host/v1"（桌面） | "mizar-net/device/v1"（手机）
seed → Ed25519 私钥；endpoint id = base64url(公钥)（43 字符）
short id = 公钥的前 8 个 Crockford base32 字符
```

派生意味着配对建立的信赖直接延续：持有 host secret 就持有桌面的端点密钥，
不需要多存一份凭证。

## 3. 会话密钥与逐包封装

```
salt      = SHA-256("mizar-net/session/v1" ‖ sorted(id1, id2) 各接 0x00)
key_dir   = HKDF-SHA256(ikm = X25519 共享秘密, salt, info =
            "mizar-net/dialer-to-acceptor/v1" | "mizar-net/acceptor-to-dialer/v1", 32B)
nonce     = 4 个 0x00 ‖ packet number 的 8 字节大端     （共 12 字节）
```

- 每个方向一把钥匙，两侧都算、按角色选——握手没有协商方向的余地。
- **包号即 nonce**：线上不带 nonce，每包省 12 字节，也没有可伪造的 nonce。
- AAD = 头 ‖ 包号 ‖ 消息长度。消息长度在 AEAD 之外、AAD 之内，所以一个分片无法被
  重新框进另一个消息。头在 AAD 内，所以中继或攻击者无法把数据包改写成保活包。
- AEAD 是 ChaCha20-Poly1305，密文后接 16 字节 tag。空消息封出来就是 16 字节——
  这是合法长度，不是"空包"。

## 4. 一条硬规则：签名不能比较字节

**Apple CryptoKit 的 Ed25519 签名使用随机 nonce**：同一密钥、同一消息，两次签名
得到的 64 字节不同（都已验证过）。因此：

- 跨语言契约是**验证**，不是相等；
- 任何地方都不得用签名做身份判断、去重或重放检测——重放要靠包号窗口；
- 测试里也不要断言"重新签一遍得到同样字节"，那会红。

这条是实测得出的（2026-10-25，Xcode 27 / Swift 6.4），不是推测。

## 5. fixture 与重新生成

```
cd iOS && MIZAR_P2P_FIXTURES=1 scripts/swift.sh test --filter MizarNetFixtureEmitter
cp iOS/protocol/fixtures/p2p/wire.json dsh/protocol/fixtures/p2p/wire.json
cd dsh && npx vitest run test/p2p-wire.test.ts test/p2p-crypto.test.ts
```

fixture 在 `p2p/` 子目录里，因为 `protocol/fixtures/` 顶层归 Mizar v1 的黄金帧所有，
两套协议的加载器都不递归，混放会让 v1 的"fixture 集合"断言失败。

fixture 里的种子是字节图案，不是秘密；里面的签名各是一份有效样本，不可复现。

## 6. TypeScript 侧的状态

| 模块 | 状态 |
|---|---|
| `encoding.ts` / `wire.ts` / `crypto.ts` | 完成，与 Swift 逐字节互验（fixture） |
| `socket.ts` | 完成：`dgram` 封装，一个端口绑定全程不动，`events()` 按到达顺序 |
| `stun.ts` | 完成：RFC 5389 绑定事务、XOR-MAPPED-ADDRESS、未知属性按长度跳过 |
| `session.ts` | 完成：分片重组（按包号顺序）、ACK（25ms 独立定时器 + 捎带）、重传（300ms 起翻倍、8 次）、22s 保活、66s 空闲判降级 |
| `engine.ts` | 完成：候选收集、轮次打洞、接受方回打、最小连接 id 调和、拨号预算、意图声明 |
| 端口映射（UPnP-IGD / NAT-PMP） | **未做**——桌面是接受方，这是提高直连率最有效的一环 |

`policy.ts` 里的数字与 `MizarNetPathPolicy.standard` 逐项一致——两端的打洞节奏必须
同一个数量级，否则一边已经放弃、另一边还在发包。

### 6.1 两套实现的真连接测试

字节一致只证明格式；能连上才证明行为。Swift 侧有一个只用 MizarKit 公开 API 写的
命令行端点 `iOS/MizarKit/Probe`，Node 侧启动它、双方在回环上真打一次洞：

```
cd dsh && MIZAR_P2P_INTEROP=1 npx vitest run test/p2p-interop.test.ts
```

两个方向都测：

- **Node 拨号 → Swift 接受**：Node 发 ClientHello，Swift 验签并回 ServerHello，
  Node 用对方 ephemeral 算出会话密钥，发消息，Swift 解密后回 `echo:…`；
- **Swift 拨号 → Node 接受**：反方向，验证 **CryptoKit 接受 Node 签出的 Ed25519 签名**
  （这一步正是字节 fixture 覆盖不到的地方）。

默认门控（`MIZAR_P2P_INTEROP=1` 才跑）：它需要 Swift 工具链和一次 `swift build`，
不该成为日常单测的前置条件。
