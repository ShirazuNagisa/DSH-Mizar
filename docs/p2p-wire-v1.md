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
| `portmap.ts` | 完成：UPnP-IGD（SSDP + SOAP）与 NAT-PMP，引擎在绑定后申请映射、续租、关闭时删除（见 §7） |

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

## 7. 端口映射：对称 NAT 的唯一解

矩阵里有一条判决是硬的：**对称型接受方打不通**。它的映射随目的地址变化，任何一方
从 STUN 学到的地址对它自己都不成立——再多打洞轮次也改变不了这一点。

能改变的是「不去问 NAT」。端口映射是向路由器提一个请求：把这个 UDP 端口永久转发给我。
路由器一旦答应，这个端点对所有拨号方都可达，锥型也好、对称也好。这是当前提高直连率
最有效的一环，也是唯一能救对称接受方的手段。

两种协议，因为家用路由器只会说其中一种：

| 协议 | 发现 | 请求 | 备注 |
|---|---|---|---|
| **UPnP-IGD** | SSDP 组播到 239.255.255.250:1900，读 `LOCATION` | HTTP + SOAP `AddPortMapping` | 家用路由器最常见；拒绝是 HTTP 500 + `UPnPError` 里的错误码（718 = 端口已被占用） |
| **NAT-PMP** | 无，直接问网关的 5351 端口 | 12 字节二进制请求 | 更简单，一次往返；Apple 路由器与部分厂商支持 |

### 7.1 它自己做不到的一件事

两种协议都不返回**外部 IP**：NAT-PMP 的映射响应只有端口，IGD 还要额外调一次
`GetExternalIPAddress`。所以映射只提供一半地址——另一半（公网 IP）仍然来自 STUN。

引擎因此把两者配对：`(STUN 观测到的地址, 路由器转发的端口)`。这个组合才是拨号方
真正能用的候选。没有 STUN 就没有外部地址，此时映射会被**主动撤销**而不是留在路由器上：
一个没人用的转发口，就是一扇开着的门。

### 7.2 失败是常态，不是错误

关掉 UPnP 的路由器、公司网关、封锁组播的访客 Wi-Fi——这些都返回 `null`，
打洞照原样进行。测试把三种情况都钉住了：网关答应、网关拒绝（错误码要能被读出来）、
网关根本不回（3 次重试共 750ms 后放弃）。

### 7.3 租约与拆除

`NewLeaseDuration: 0` / NAT-PMP lifetime 0 表示「永久」，但很多路由器会自己裁剪成
较短租约。所以映射按**半租约**续租，并且在引擎关闭时显式删除——不留一个没人用的
转发口在路由器上。

## 8. 桌面侧接线（插件）

`src/net/p2p.ts` 是桌面端的门面，三件事：

| 部分 | 作用 |
|---|---|
| `deriveEndpointIdentity(tunnelSecret)` | 端点密钥由 tunnel secret 派生（与手机同一构造），不需要新凭证，重装后端点 id 不变 |
| `P2PService` | 常驻引擎 + `accept()` 循环 + 每路信令。桌面是被拨号的一方，所以引擎必须进程级 |
| `StreamChannel` | 把 p2p 流包装成监听器认的 `MizarChannel`：一条消息一帧 |

监听器的连接处理因此抽成了 `#serve(channel:remote:forgetSocket:)`：WebSocket 与 p2p
共用**同一份**鉴权、方法分发与投递账本——直连换的是传输，不是协议。这对
`host.info` 也成立：p2p 会话里的 `hello` 同样是设备令牌校验。

### 8.1 信令怎么走

```
phone ──WS──▶ relay /r/<room>/mizar-net/signal ──隧道──▶ 插件 listener /mizar-net/signal
                                                              │
                                                     P2PService.attachSignal
                                                              ▼
                                                        engine.offerCandidates
```

两端各发一次 `hello`（`{"v":1,"type":"hello","endpointId":…,"candidates":[…]}`），
之后是 `candidates`。收到即喂给引擎——被叫方的回打正是靠这个打开自己的过滤器。
版本不匹配或 JSON 坏掉就地丢弃：这条通道凡是拿到房间的人都能连，坏数据只能拖累它自己。

### 8.2 默认不查 STUN

`P2PService.start` 的 `stunServers` 默认是空数组。绑一个 UDP socket 很便宜，
但"让第三方知道我这条连接从哪来"不该是安装即发生的事。没有 STUN 时只广播 host
候选——同一局域网可用；跨网仍然走中继，和今天完全一样。打开它的时候应当指向本项目
自建的 STUN，那是 App 灰度的一步。

## 9. STUN：用自己的服务器，而不是别人的

打洞的前提是每端知道自己「从外面看长什么样」。这个答案只能由公网上的第三方给出，
而「第三方是谁」是个真实的选择：公共 STUN（Google 等）零成本，但等于把「这台设备
什么时候、从哪个地址连了哪里」交给一个与项目无关的公司；自建则多一个要维护的服务。

结论是自建，而且**就放在中继服务器上**：`dshmizar.shirazu-nagisa.com:3478`。

### 9.1 它是什么

`dsh-relay/src/stun.ts`，RFC 5389 的一个真子集：Binding Request 进，Binding Success
Response 出，只有一个属性 —— XOR-MAPPED-ADDRESS。**故意只做这么点**：

- 不做认证：STUN 问的是「我的地址是什么」，这个问题里没有秘密；
- 不做 TURN：本项目的兜底是 443 上的 WebSocket 中继，在封锁 UDP 的网络里照样能用，
  而 TURN 需要一整套分配与配额机制；
- 不做 IPv6：两端目前都是 IPv4，第二族意味着第二个 socket 和第二套防火墙规则。

XOR 不是混淆。它是为了让中途改写地址的中间设备无法**悄悄**污染答案：客户端用同一个
常量反解，要么得到真相，要么得到一个说不通的值 —— 而不是一个看似合理、实际会把打洞
送进别人 NAT 绑定的错误地址。

### 9.2 反射放大是被设计过的

UDP 源地址可以伪造，所以「任何收到的包都回一个」等于把自己变成反射放大器。三条约束：

- 严格校验：不是合法 Binding Request 就**不回**（类型、魔术 cookie、长度必须是 4 的
  倍数且与数据报长度一致）；
- 双桶限速（`src/udp-guard.ts`，与端点探测共用）：每源 5 次/秒、全局 200 次/秒，
  全局桶先扣，所以分布式伪造也无法用单个受害者的地址把我们打满；
- 尺寸：请求 20 字节，应答 32 字节，放大约 1.6 倍 —— 攻击者拿到的是比正常协议还差的
  杠杆。

### 9.3 两端的默认值

| 端 | 默认 | 说明 |
|---|---|---|
| iOS `MizarNetQUICEngine.defaultSTUNServers` | `["dshmizar.shirazu-nagisa.com:3478"]` | 与手机本来就要连的中继同一个主机名，不新增信任 |
| 插件 `net.stunServers` | 空 → 由 `resolveStunServers` 从 `relay.url` 推出 | 自建中继的人得到 `[]`，不会把电脑通告给我们的服务器 |

**故意没有公共 STUN 兜底。** 如果这台服务器不可达，端点保留 host 候选，打洞退化为
局域网内，远程会话照旧走中继 —— 用户感知不到差别，换取的是不把连接事实泄露给陌生人。

### 9.4 验证

```bash
# 从任意一台公网机器（本项目用主力1）
python3 - <<'PY'
import socket, struct, os
COOKIE = 0x2112A442
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(3)
s.sendto(struct.pack("!HHI", 1, 0, COOKIE) + os.urandom(12), ("124.223.105.30", 3478))
data, _ = s.recvfrom(2048)
print(len(data), "bytes")     # 32
PY
```

2026-10-25 实测：32 字节应答，XOR 解出的端口与本地端口一致；垃圾包无应答；
同一来源 3 连发全部应答（每源上限 5/s）。Swift 引擎对接同一台服务器 53ms 拿到
`124.228.221.210:61921` —— 那是真实 NAT 之后的映射，不是回环。
