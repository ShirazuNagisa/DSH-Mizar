# Deploying the DSH-Mizar relay

The relay is the third answer to "how does the phone reach the Mac", after the two in
This document: a small Node service you run on a server with a public
address, which lets a Mac that **cannot accept inbound connections at all** still be reachable.

This document is the operator's guide. It is written to be followed top to bottom on a fresh
server, with BaoTa Panel (宝塔面板) assumed for the web side because that is where the sharp edges
are.

> **Verified against the source, not against a server.** The relay has only ever been exercised by
> its own test suite, run locally (`npm test` in [`relay/`](../relay/)), plus the loopback runs the
> responses below were copied from. Nobody has deployed it to a real host and put a phone through
> it yet. Read this as reviewed-and-consistent-with-the-code rather than proven-in-production, and
> expect the first deployment to teach us something.

---

## 1. What this is, and why

A Mac at home or in an office usually cannot be dialled from outside: consumer NAT drops unsolicited
inbound packets, and campus or corporate networks block them outright. The relay inverts the
problem. The Mac opens **one outbound WebSocket** to the relay and holds it open; anything arriving
at the relay for that Mac is replayed down that socket.

```text
 iPhone ──── HTTPS / WSS ────► nginx (TLS) ──► relay (127.0.0.1:8787) ──┐
                                                                       │ one outbound WSS
                                                                       │ the Mac opened
 Mac (plugin listener on 127.0.0.1:19390) ◄────────────────────────────┘
```

The Mac has no inbound port, no port forwarding, no VPN and no second network to join. It dials
`wss://mizar.example.com/tunnel` with `Authorization: Bearer <token>`, the relay derives a **room**
from that token, and the Mac becomes reachable at `https://mizar.example.com/r/<room>/…`.

What the relay does and does not do:

| | |
|---|---|
| It **does** terminate a WebSocket with the Mac and multiplex phone traffic over it | HTTP requests are replayed and their answers returned; phone WebSockets are bridged through |
| It **does not** understand the Mizar protocol | a request is a method, a path, headers and a body; the relay moves those and knows nothing about sessions, devices or approvals |
| It **does not** authenticate phones | the phone still pairs with the plugin's own pairing code and then speaks with a device token, over the tunnel, exactly as it would on a LAN |
| It **does** decide which Mac a request reaches | and only from the token, never from anything the Mac or the phone claims |

Two deliberate behaviours are worth knowing before you debug anything:

- **A room with no Mac connected and a room that never existed answer the same 404.** Telling them
  apart would let anyone enumerate which Macs are online.
- **A phone WebSocket is not accepted until the Mac accepts it.** An unreachable Mac produces an
  HTTP error rather than a socket that opens and immediately dies. The two look identical in a
  client's logs, and only one of them is diagnosable.

### The endpoints the relay serves

| Path | Who uses it | What happens |
|---|---|---|
| `/tunnel` | the Mac | WebSocket upgrade, authenticated with `Authorization: Bearer <token>`; an unknown token gets `401` and a closed socket |
| `/r/<room>/…` | the phone | replayed over the tunnel; WebSocket upgrades are bridged; `404` when that room has no live tunnel |
| `/healthz` | you | `{"ok":true,"rooms":1,"inFlight":0,"version":1}` — `rooms` counts the Macs currently attached (section 7) |
| `udp/<probePort>` | peers | endpoint probe: any datagram gets JSON back containing the sender's public address and port |

---

## 2. Requirements

| | |
|---|---|
| **Server** | a public IPv4 address that does not change. Any small VPS is enough — the relay stores nothing, runs one Node process and holds a handful of sockets |
| **Node** | 20 or newer, from [`relay/package.json`](../relay/package.json) `engines`. Check with `node --version` |
| **Domain** | one name with an `A` record pointing at the server, e.g. `mizar.example.com` |
| **TLS** | a certificate for that name. This guide uses Let's Encrypt through BaoTa; any certificate that nginx can load works |
| **Disk** | tens of megabytes. The configuration is a text file, not a database |
| **Network** | inbound TCP 443 (and TCP 80 for the certificate), optionally inbound UDP 8788 for the probe |
| **On the Mac** | the `dsh-mizar` plugin already installed and working, and the tunnel token in its own config (section 6) |

---

## 3. 快速开始

> 详细理由都在后面的章节里。这一节只给"从零到能用"的顺序。

1. 服务器要有**固定公网 IPv4**，域名 `mizar.example.com` 的 A 记录指向它。
2. 把仓库里的 `relay/` 整个目录传到服务器，建议放在 `/www/wwwroot/dsh-mizar-relay`。
3. 装依赖并构建（注意顺序，`tsc` 是 devDependency）：

   ```sh
   cd /www/wwwroot/dsh-mizar-relay
   npm ci                # 含编译器等开发依赖
   npm run build         # 产出 lib/
   npm ci --omit=dev     # 只留运行时依赖 ws
   ```

4. 生成隧道令牌：`openssl rand -base64 32`。**一个 Mac 一个令牌**，等同于"成为那台 Mac"的
   凭证，不要外传、不要提交进 git。
5. 写配置：`cp relay.config.example.json relay.config.json`，把令牌填进 `tokens`，
   `chmod 600 relay.config.json`。默认 `port: 8787`、`host: 127.0.0.1`、`probePort: 8788`。
6. 用 systemd 或宝塔的 **Node 项目** 跑起来，工作目录必须是该目录（配置文件是相对路径读的）。
7. 宝塔建站 → 申请 Let's Encrypt 证书 → 开 **强制 HTTPS** → 反向代理到
   `http://127.0.0.1:8787`（发送域名 `$host`）。
8. 在反向代理的配置文件里**至少**加上这几行（完整清单与逐条理由见 5.3），
   **否则 WebSocket 一定失败、隧道大约每分钟断一次**：

   ```nginx
   proxy_http_version 1.1;
   proxy_set_header Upgrade $http_upgrade;
   proxy_set_header Connection "upgrade";
   proxy_read_timeout 3600s;
   proxy_send_timeout 3600s;
   ```

9. 安全组/防火墙放行 TCP 80、TCP 443；想要打洞探测再放行 **UDP 8788**。**绝不要**放行 8787。
10. Mac 插件配置里打开 `relay`（见第 6 节），重启 DSH，日志出现
    `relay: serving room …`，然后在面板里生成配对二维码给手机扫。
11. 验证：`curl https://mizar.example.com/healthz` 应返回
    `{"ok":true,"rooms":1,"inFlight":0,"version":1}`。

---

## 4. Step by step

### 4.1 Copy `relay/` to the server

The relay is the `relay/` directory of this repository and nothing else — it does not import the
plugin, and the plugin does not import it. Copy that one directory:

```sh
# from the repository root on the Mac
rsync -av --exclude node_modules --exclude lib \
  relay/ root@203.0.113.10:/www/wwwroot/dsh-mizar-relay/
```

Two notes on what you get:

- `relay/lib/` is **git-ignored** (the plugin's `lib/` is committed, the relay's is not — see
  [.gitignore](../.gitignore)). A `git clone` therefore contains no build output; that is expected,
  and section 4.2 builds it. `rsync` above skips a local `lib/` for the same reason: shipping stale
  JavaScript from a laptop is worse than compiling on the server.
- `package-lock.json` **is** committed, which is what makes `npm ci` reproducible.

### 4.2 Install and build

```sh
cd /www/wwwroot/dsh-mizar-relay
node --version        # must print v20.x or newer
npm ci                # install everything, including the TypeScript compiler
npm run build         # tsc -p tsconfig.json  →  lib/
npm ci --omit=dev     # drop the compiler and the test runner; only ws remains
```

These are the script names exactly as declared in [`relay/package.json`](../relay/package.json):

| Script | Command | When you use it |
|---|---|---|
| `build` | `tsc -p tsconfig.json` | once per deployment; writes `lib/` |
| `start` | `node lib/index.js` | what the service runs, effectively |
| `typecheck` | `tsc -p tsconfig.json --noEmit` | optional |
| `test` | `vitest run` | optional sanity check; needs devDependencies, so run it before the prune |

> **The order matters, and `npm ci --omit=dev` alone will not work.** The build script is `tsc`,
> and `typescript` is a **devDependency**. Prune first and `npm run build` fails with a missing
> compiler. Either build first and prune afterwards (above), or — if you would rather not install a
> compiler on the server at all — run `npm ci && npm run build` on the Mac, copy `lib/`,
> `package.json` and `package-lock.json` across, and run `npm ci --omit=dev` there.
>
> `npm ci --omit=dev` deletes `node_modules` and reinstalls from the lockfile, which is why it is
> safe to run after the build: `lib/` is not inside `node_modules`. `npm prune --omit=dev` does the
> same job in place.

### 4.3 Generate the tunnel token

```sh
openssl rand -base64 32          # 44 characters, mixed case, may contain + / =
openssl rand -hex 32             # 64 characters, hex only — easier to paste into a config file
```

Either is fine. Use a separate token per Mac: one token is one room, so the list is also your
inventory, and retiring a Mac is deleting one line.

**A token is not a password for an account — it is the capability to *be* that Mac.** Whoever holds
it can attach a process to the relay as your Mac, receive every phone request, and answer as the
plugin would. That is a stronger position than holding a room id (section 9). So:

- generate it on the server, paste it into one file, and do not send it through chat, tickets or
  email;
- never commit it. `relay.config.json` is deliberately not in the repository — only
  `relay.config.example.json` is — and you should keep it that way in any deployment repo of your
  own;
- `chmod 600` the file (section 4.4), so it is unreadable to other local users.

#### Where the room comes from

You do not choose the room, and you do not configure it. The relay derives it:

```text
room = first 12 characters of Crockford base32( SHA-256( "dsh-mizar-relay/room:" + token )[0..8] )
```

The alphabet is `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (no `I`, `L`, `O` or `U`, so a room read off a
screen cannot be mistyped into a different valid one). The relay computes it and tells the Mac in
its first frame; the Mac never invents one, so a tunnel cannot claim a room that belongs to a
different token.

To cross-check the room for a token, on the server, from the relay directory:

```sh
node -e 'import("./lib/room.js").then(m => console.log(m.deriveRoom(process.argv[1])))' 'THE-TOKEN'
```

For the stand-in token used throughout this document that prints `GJ31NAZY4PRH`.

Two consequences worth internalising:

- The room is a **function of the token**, so the same token always yields the same room on every
  machine — and **rotating a token changes the room**. Every QR code and stored pairing against the
  old room stops working, and phones must re-pair.
- Whitespace *around* an entry is trimmed in both forms — the file's array is joined with commas and
  trimmed entry by entry, exactly like the environment list — but whitespace *inside* an entry is
  part of the token, and therefore part of the room. When a room looks wrong, suspect the token
  first.

### 4.4 Write `relay.config.json`

```sh
cd /www/wwwroot/dsh-mizar-relay
cp relay.config.example.json relay.config.json
chmod 600 relay.config.json
$EDITOR relay.config.json
```

With the token from step 4.3 (the string below is a **stand-in** — replace it with your own), the
file looks like this:

```json
{
  "port": 8787,
  "host": "127.0.0.1",
  "tokens": ["Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA"],
  "maxBodyBytes": 4194304,
  "maxMessageBytes": 4194304,
  "maxClientsPerRoom": 8,
  "requestTimeoutMs": 30000,
  "tunnelIdleMs": 90000,
  "probePort": 8788
}
```

Every key, its environment override and its default — the authoritative list, from
[`relay/src/config.ts`](../relay/src/config.ts):

| Key | Environment override | Default | What it does |
|---|---|---|---|
| `port` | `MIZAR_RELAY_PORT` | `8787` | TCP port for the plain-HTTP server. TLS is nginx's job, not this process's |
| `host` | `MIZAR_RELAY_HOST` | `127.0.0.1` | interface to bind. Leave it; see 5.4 |
| `tokens` | `MIZAR_RELAY_TOKENS` | *none — required* | the bearer tokens a Mac may present at `/tunnel`. One token = one Mac = one room |
| `maxBodyBytes` | `MIZAR_RELAY_MAX_BODY` | `4194304` (4 MiB) | largest replayed request body. Past it the relay answers `413` |
| `maxMessageBytes` | `MIZAR_RELAY_MAX_MESSAGE` | `4194304` (4 MiB) | largest single WebSocket message. Past it the bridge closes with code `1009` |
| `maxClientsPerRoom` | `MIZAR_RELAY_MAX_CLIENTS` | `8` | concurrent phone connections allowed per room. A resource guard, not authentication |
| `requestTimeoutMs` | `MIZAR_RELAY_REQUEST_TIMEOUT` | `30000` | how long a phone request waits for the Mac before `502`, and how long a phone WebSocket waits for the Mac to accept its upgrade before `504` |
| `tunnelIdleMs` | `MIZAR_RELAY_TUNNEL_IDLE` | `90000` | how long a tunnel may go without answering a ping before the relay drops it. The relay pings every `tunnelIdleMs / 3` (30 s at the default), never faster than 5 s |
| `probePort` | `MIZAR_RELAY_PROBE_PORT` | `8788` | UDP port for the endpoint probe; `0` disables it and opens no socket at all |

Rules that are easy to trip over:

- **Environment wins over the file.** A container or a unit file can override a mounted config
  without rewriting it. An **empty** value counts as *unset*, not as an empty string — that is what
  an undefined Docker variable looks like.
- In the file `tokens` is a JSON **array**; in the environment `MIZAR_RELAY_TOKENS` is a
  **comma-separated list**. Setting the environment variable replaces the file's list entirely, so
  a stale `MIZAR_RELAY_TOKENS` in a unit file will silently ignore an edit to `relay.config.json`.
- Numbers given through the environment arrive as strings and are parsed as numbers, so
  `MIZAR_RELAY_PORT=8787` behaves as written and `"probePort": 0` disables the probe. A value that is
  not a number at all is not rejected at load time: it becomes `NaN` and the process dies on start-up
  with `ERR_SOCKET_BAD_PORT` (see section 8).
- **No token at all is a start-up failure.** The process prints the reason and exits `1`:
  an empty token list would accept any tunnel, and a relay that exposes a machine which can run code
  is worse than one that refuses to start.

### 4.5 Run it under systemd

Port 8787 is above 1024, so nothing here needs root. Run the relay as its own unprivileged user:

```sh
useradd --system --home-dir /www/wwwroot/dsh-mizar-relay --shell /usr/sbin/nologin mizar-relay
chown -R mizar-relay:mizar-relay /www/wwwroot/dsh-mizar-relay
command -v node        # note the absolute path; the unit file needs it
```

Then `/etc/systemd/system/dsh-mizar-relay.service`:

```ini
[Unit]
Description=DSH-Mizar relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=mizar-relay
Group=mizar-relay
WorkingDirectory=/www/wwwroot/dsh-mizar-relay
ExecStart=/usr/bin/node /www/wwwroot/dsh-mizar-relay/lib/index.js
Restart=always
RestartSec=2

# Optional. Any MIZAR_RELAY_* here overrides relay.config.json — including
# MIZAR_RELAY_TOKENS, which replaces the file's whole token list.
# Environment=MIZAR_RELAY_PORT=8787
# Environment=MIZAR_RELAY_HOST=127.0.0.1
# Environment="MIZAR_RELAY_TOKENS=Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA"
# Environment=MIZAR_RELAY_PROBE_PORT=8788

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

Why each of the lines that matter:

- **`WorkingDirectory`** is not decoration. The config file is read from the path
  `relay.config.json` **relative to the process's working directory**. Start the process from
  anywhere else and it will find no file — which is legal, because everything may come from the
  environment — and then fail with "no tunnel token configured", or, worse, come up with a
  different configuration than you think.
- **`ExecStart`** points at `node` and the built entry directly rather than at `npm start`. The
  `start` script is exactly `node lib/index.js`, so the effect is the same, but this way systemd
  supervises Node itself instead of supervising npm supervising Node — one less process to signal
  on restart. Use the absolute `node` path from `command -v node`; systemd does not read your
  shell's `PATH`, and a Node installed by nvm or by BaoTa's Node manager is not in `/usr/bin`.
- **`Restart=always`** with a short `RestartSec` is what makes a relay restart invisible: the Mac
  reconnects on its own with exponential backoff (section 6).
- **The `Environment=` lines** are shown quoted on purpose: base64 tokens can contain `/`, `+` and
  `=`, and quoting keeps systemd from splitting at a space. systemd performs no shell expansion
  here, so the value is taken literally.
- **If you would rather not put the secret in the unit file** (which is world-readable), move it to
  a file only root and the service user can read and point at it with
  `EnvironmentFile=/etc/dsh-mizar-relay.env` containing `MIZAR_RELAY_TOKENS=…`. Same semantics,
  different permissions.
- **`ProtectHome=true`** hides `/home`, `/root` and `/run/user`. It is fine with the install path
  used here, and wrong if you put the relay under `/root` or `/home` — drop that line in that case.

Enable and watch it:

```sh
systemctl daemon-reload
systemctl enable --now dsh-mizar-relay
systemctl status dsh-mizar-relay
journalctl -u dsh-mizar-relay -f
```

The relay logs to stdout, so journald holds everything and there is no log file to rotate.

#### Alternative: BaoTa's Node project manager

If you would rather keep it in the panel: **网站 → Node 项目 → 添加 Node 项目**, project directory
`/www/wwwroot/dsh-mizar-relay`, startup file `lib/index.js` (or the `start` script, which is the
same command), the port it listens on, and a user that can read the directory.

Two things the manager will not do for you:

- **Build.** `lib/index.js` does not exist until `npm run build` has run, and the manager starts the
  app rather than a build. Run the three commands from 4.2 in the project directory yourself, before
  you add the project.
- **Set the working directory for you.** Whatever the manager uses as the process's working
  directory is where `relay.config.json` must be. If it starts the process elsewhere, either move
  the config or override every key with `MIZAR_RELAY_*` environment variables in the project's
  settings.

Either way, verify with `curl` (section 7) rather than trusting the panel's green dot.

---

## 5. BaoTa Panel (宝塔面板)

This is the part that decides whether the deployment works. None of it is specific to BaoTa
beyond the menu names; any nginx front end needs the same six directives.

### 5.1 Site, certificate, forced HTTPS

1. **网站 → 添加站点.** Domain `mizar.example.com`. No database, no PHP — choose the "static"
   option (纯静态) and create it.
2. **站点设置 → SSL → Let's Encrypt.** Select the domain and apply. BaoTa writes the certificate,
   adds the `server` block for 443 and reloads nginx. The HTTP-01 challenge needs inbound **TCP 80**
   reachable at that moment; if the domain sits behind Cloudflare's proxy, use a DNS challenge or
   temporarily grey-cloud the record.
3. **Turn on 强制 HTTPS** (Force HTTPS) in the same panel. The certificate is not optional here:
   the tunnel token and every prompt travel through this hostname, and the relay itself speaks plain
   HTTP.

### 5.2 Reverse proxy to `http://127.0.0.1:8787`

**站点设置 → 反向代理 → 添加反向代理:**

| Field | Value |
|---|---|
| 代理名称 (name) | `mizar-relay` |
| 目标 URL (target) | `http://127.0.0.1:8787` |
| 发送域名 (Host) | `$host` |
| 缓存 (cache) | off |

Point the proxy at **`/`**, not at `/r/`. The relay serves three paths — `/healthz`, `/tunnel` and
`/r/…` — and proxying only one of them produces the worst kind of failure: the site answers on 443,
the certificate is valid, and the tunnel silently never comes up.

BaoTa keeps the generated snippet in its own file under `/www/server/panel/vhost/nginx/proxy/` and
includes it from the site's `server` block. The **配置文件** button on the reverse-proxy row opens
exactly the file you need to edit next.

### 5.3 The nginx directives that must be added

Add these inside the proxy's `location` block:

```nginx
proxy_http_version 1.1;
proxy_set_header Upgrade $http_upgrade;
proxy_set_header Connection "upgrade";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_read_timeout 3600s;
proxy_send_timeout 3600s;
```

| Directive | Why it is there |
|---|---|
| `proxy_http_version 1.1` | WebSocket upgrades exist in HTTP/1.1. nginx talks HTTP/1.0 to upstreams by default, where `Upgrade` is not a thing |
| `proxy_set_header Upgrade $http_upgrade` | forwards the client's `Upgrade: websocket` to the relay. Without it the relay never sees an upgrade request at all |
| `proxy_set_header Connection "upgrade"` | tells the relay this connection is an upgrade and not a keep-alive request. **This and the line above are a pair** — with only one of them the handshake is stripped and what the client gets back is a plain HTTP response instead of `101 Switching Protocols` |
| `proxy_set_header Host $host` | keeps the hostname the client used, rather than `127.0.0.1:8787`, in the request the Mac eventually replays |
| `proxy_set_header X-Real-IP $remote_addr` | the phone's real address. The relay forwards it to the Mac as an ordinary request header (it is not a hop-by-hop header), which is the only way the Mac can see who is calling — from the plugin's side the connection arrives from loopback |
| `proxy_read_timeout 3600s` | **the one people lose an evening to.** nginx's default is 60 s: a proxied socket that says nothing for 60 s is closed. The tunnel is exactly such a socket whenever it is quiet, and the symptom is a Mac that reconnects roughly every minute, forever |
| `proxy_send_timeout 3600s` | the write-side equivalent, for a large answer being pushed to a slow phone |

What the two failure modes actually look like:

- **Missing `Upgrade`/`Connection`.** The Mac's connection to `wss://…/tunnel` ends with a non-101
  response, so no tunnel ever registers; `/healthz` reports `"rooms":0` while answering perfectly
  over HTTPS, which is what makes this confusing. The phone's WebSocket fails the same way.
- **Short `proxy_read_timeout`.** The tunnel connects, `rooms` becomes `1`, and then it drops about
  every 60 seconds. The relay logs `relay: tunnel for room … disconnected` in a loop, the Mac logs
  `relay: reconnecting in Ns`, and everything appears to work between drops. The relay pings its
  tunnel every 30 seconds, which usually keeps the Mac's leg under the limit — but the phone's leg
  can be quiet for longer, a raised `tunnelIdleMs` widens the gap, and a 60-second window is far too
  close to a 30-second heartbeat to rely on.

Then:

```sh
nginx -t && nginx -s reload
```

> **A tidier variant.** Setting `Connection` to the literal `"upgrade"` means it is also sent on
> plain requests, like `/healthz` and the HTTP replay under `/r/…`. The relay strips `Connection`
> and `Upgrade` before forwarding anything to the Mac, so this is tolerated. If you prefer the
> standard form, declare this once in the `http` context (for BaoTa that means the nginx main
> configuration, **not** inside the site's `server` block, where a `map` is invalid):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

> …and use `proxy_set_header Connection $connection_upgrade;` in the location instead.

> **Renewal note.** If Let's Encrypt renewal ever starts failing after this proxy is in place, check
> that `/.well-known/acme-challenge/` still resolves to files on disk rather than being proxied to
> the relay, which would answer its JSON `404` and fail the challenge.

### 5.4 Why the relay binds `127.0.0.1` only

`host` defaults to `127.0.0.1` and you should leave it there. nginx terminates TLS in front of the
relay, so the only thing that ever needs to reach the Node process is nginx, on the same machine.
The Node process speaks **plain HTTP**: no certificate, no encryption of its own.

That has two consequences:

- Exposing 8787 publicly would put the tunnel token on the wire in clear text as a bearer header,
  readable by anything between the Mac and the server. TLS in front is not a nicety here; it is the
  only encryption the tunnel has.
- It would also expose `/r/<room>/…` unencrypted to the entire internet. The room is a weaker secret
  than the token (section 9), and it is not meant to be the thing standing between a stranger and
  your Mac.

So: bind loopback, let nginx own 443, and **do not open 8787 in the security group or the host
firewall.** If you have a reason to bind something else — a container network, a second machine —
set `host` deliberately and put a firewall in front of it.

### 5.5 Firewall and security group

| Port | Protocol | Open? | Why |
|---|---|---|---|
| 443 | TCP | yes | phones and the Mac's tunnel |
| 80 | TCP | yes | the HTTPS redirect and Let's Encrypt's HTTP-01 challenge |
| 8788 | UDP | only if you want the probe | endpoint discovery for peer-to-peer hole punching; the reply tells a peer how it looks from outside |
| 8787 | TCP | **never** | the relay's plain-HTTP port; nginx is the only client it should have |

Set this in both places that apply to you: the cloud provider's security group and the host firewall
(`ufw allow 80,443/tcp`, `ufw allow 8788/udp`) or BaoTa's own **安全** page.

The probe is the one thing that must be reachable from outside to be useful — it answers "what is my
public address and port" to whoever asks, which is the whole of STUN for this purpose — so it binds
`0.0.0.0` rather than loopback. If you do not want the endpoint discovery, set `probePort` to `0`:
the relay then opens no UDP socket at all and the firewall rule is unnecessary.

---

## 6. Configuring the Mac plugin

The Mac side needs the relay's URL and the very same token. The plugin's `relay` block lives in the
DSH profile configuration — the row's `config`, which belongs to the profile's own patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`); the row itself is inserted by the plugin's bundle
patch, so two profiles can configure Mizar independently. Confirm what actually took effect with:

```sh
dsh --profile <profile> --dump-config | grep -A 10 mizar
```

A worked example:

```yaml
# the mizar row's config
relay:
  enabled: true
  url: https://mizar.example.com
  token: Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA
  publicUrl: ''
  preferLoopback: true
  reconnectBaseMs: 1000
  reconnectMaxMs: 60000
```

| Key | Default | What it means |
|---|---|---|
| `enabled` | `false` | off by default on purpose: turning it on means one machine's agent traffic flows through another machine. The tunnel only starts when this is `true` **and** `url` and `token` are both non-empty; otherwise the plugin logs `relay: enabled but url or token is empty — not connecting` |
| `url` | `''` | the relay's base URL, e.g. `https://mizar.example.com`. `https://` and `wss://` are both accepted — the client translates to `wss://` for the tunnel — so the value you copy out of a browser works as-is |
| `token` | `''` | the tunnel token, exactly the string in the relay's `tokens` list. It is sent as `Authorization: Bearer …` on the tunnel upgrade and never appears in a QR code |
| `publicUrl` | `''` | the base URL a **phone** should be given, when it differs from `url`. Empty means "the same host as `url`" |
| `preferLoopback` | `true` | while the tunnel is up, bind only `127.0.0.1` instead of the configured bind mode. With a tunnel the phone never needs to reach the Mac directly, so the listener stops exporting itself onto whatever network the Mac is on |
| `reconnectBaseMs` | `1000` | first reconnect delay after the tunnel drops; doubles, with jitter, up to the cap |
| `reconnectMaxMs` | `60000` | longest reconnect delay |

### `publicUrl`, and when you need it

`publicUrl` exists for one situation: **the Mac reaches the relay by a different address than the
phone does.** A Mac sitting on the same LAN as the relay can dial it privately, while phones on
mobile data cannot:

```yaml
relay:
  enabled: true
  url: http://192.168.1.10:8787        # the Mac's path to the relay, over the LAN
  token: Zt8kQ2mR9vX4pL6cH1sB3nD7fG0jW5yA
  publicUrl: https://mizar.example.com # what the QR code must carry for phones
```

With `publicUrl` empty, the phone is given the relay URL itself, with the scheme a phone needs
(`https` when `url` is `https` or `wss`, otherwise `http`). The room is derived from the token, not
from either URL, so both addresses lead to the same room. Note the trade-off in the example above:
the Mac-to-relay leg is then plain `ws://` across the LAN, which is fine inside a trusted network and
not fine anywhere else — if it bothers you, point `url` at the public hostname too and keep the whole
path inside TLS.

### Sequence, and what the Mac logs

1. Set `relay.enabled: true` with `url` and `token`, then **restart DSH** — the listener's bind mode
   and the tunnel are both decided at start-up.
2. Watch the DSH log for:

   ```text
   relay enabled: binding loopback instead of lan
   relay: connected to wss://mizar.example.com/tunnel
   relay: serving room GJ31NAZY4PRH (protocol 1, this build speaks 1)
   relay: phones should pair against https://mizar.example.com/r/GJ31NAZY4PRH
   ```

3. **Only now issue the pairing code.** The QR code's relay entry is the room, and the room is not
   known until the relay's welcome frame arrives. Generate the code before the tunnel is up and the
   QR has no relay address to carry — and with `preferLoopback` on, the only direct address is
   loopback, which is deliberately left out of a QR because a phone cannot reach it. The result is no
   QR at all, rather than one that scans and then fails.

The phone is then authenticated the same way it would be on a LAN: it pairs with a live, single-use
code, is issued a device token, and speaks the ordinary Mizar protocol at
`https://mizar.example.com/r/GJ31NAZY4PRH/mizar/v1/…`. Nothing about pairing, device tokens or
revocation changes because a relay is in the middle.

---

## 7. Verification

### The health endpoint

From the server, bypassing nginx and then through it:

```sh
curl -sS http://127.0.0.1:8787/healthz
curl -sS https://mizar.example.com/healthz
```

A healthy relay answers, with `content-type: application/json` and `cache-control: no-store`:

```json
{"ok":true,"rooms":1,"inFlight":0,"version":1}
```

Reading it:

| Field | Meaning |
|---|---|
| `ok` | the process is up and answering |
| `rooms` | how many Macs currently have a tunnel attached. `0` with the Mac's plugin enabled means the tunnel never established — the token, or the nginx directives in 5.3 |
| `inFlight` | phone requests and WebSocket streams waiting on a Mac right now. A number that stays above zero while nothing is happening means a stuck Mac or a stalled tunnel |
| `version` | the tunnel protocol version, `1`. It must match what the Mac logs as "this build speaks" |

If the second command returns nginx's HTML error page instead of that JSON, nginx is not reaching
the relay: check that the proxy covers `/` and that `systemctl status dsh-mizar-relay` is happy.

### That the routing actually reaches Node

A plain `GET /tunnel` (no upgrade, no token) is not a tunnel handshake, so the relay answers its own
JSON `404`:

```sh
curl -i https://mizar.example.com/tunnel
# HTTP/1.1 404 Not Found
# content-type: application/json; charset=utf-8
# {"error":"not found"}
```

The useful part is the *shape* of the 404: JSON from the relay proves nginx forwarded the request,
while nginx's own HTML 404 proves it did not. The same trick works for a room:

```sh
curl -sS https://mizar.example.com/r/GJ31NAZY4PRH/mizar/v1/hello
```

With the Mac connected this is the plugin's unauthenticated identity probe and answers
`200` with something like
`{"hostId":"…","hostName":"…","protocolVersion":1,"pairingOpen":false,"paired":true}`. With the Mac
offline it is the relay's `404 {"error":"not found"}` — the same answer as a room that never
existed, by design.

### What the relay logs

On start-up, three lines (the third only when the probe is enabled):

```text
relay: listening on 127.0.0.1:8787
relay: serving 1 room(s)
relay: endpoint probe on udp/8788
```

Then, as things happen:

| Line | Meaning |
|---|---|
| `relay: tunnel for room <room> connected` | a Mac authenticated and attached |
| `relay: tunnel for room <room> connected (replaced a stale one)` | the same Mac reconnected before its old socket was noticed — normal after a network blip |
| `relay: tunnel for room <room> disconnected` | the tunnel closed. Repeating roughly every minute is the nginx timeout in 5.3 |
| `relay: tunnel refused — unknown token` | a Mac presented a token that is not in the list |
| `relay: tunnel for room <room> stopped answering; dropping it` | no pong inside `tunnelIdleMs`; the relay is not routing to a half-open socket any more |
| `relay: stream refused for room <room>: <reason>` | a phone WebSocket the Mac would not accept |
| `relay: probe socket error: <message>` | the UDP probe failed to bind — usually another process on 8788 |
| `relay: SIGTERM, shutting down` | systemd asked it to stop; it closes tunnels and exits `0` |

### The panel, and the Mac's own view

The plugin's status payload carries a `relay` object:

```json
{"enabled":true,"connected":true,"room":"GJ31NAZY4PRH","pairBaseURL":"https://mizar.example.com/r/GJ31NAZY4PRH","lastError":null}
```

`connected` and `pairBaseURL` are separate on purpose: a relay that is enabled but unreachable is the
state you most need to distinguish from "no relay configured" — in the first case phones that used to
work have stopped, in the second they never would have. The bundled panel UI renders binding, the
pairing QR and the device roster; the relay fields are in the same payload
(`/api/mizar.status`) and the same facts appear in the DSH log lines quoted in section 6. The device
roster is still the authoritative answer to "who has access", relay or no relay.

> Nothing in this section has been run against a real server. The response bodies were reproduced by
> running the built relay on loopback, which exercises the code paths but not TLS, nginx, DNS or
> firewalls.

---

## 8. Troubleshooting

| Symptom | Likely cause | What to do |
|---|---|---|
| The Mac's tunnel is refused with `401`, relay logs `tunnel refused — unknown token` | the Mac's `relay.token` is not byte-for-byte one of the relay's `tokens` | compare the two strings; watch for a trailing newline from a copy-paste, a smart quote, or a token that was rotated on one side only. Check whether `MIZAR_RELAY_TOKENS` is set in the unit file — it **replaces** the file's list, so editing `relay.config.json` then has no effect |
| `/r/<room>/…` answers `404 {"error":"not found"}` even though the QR code scanned | the room in the URL is not the room the token derives (typo, whitespace in the token, or the token was rotated), **or** the Mac is simply offline. The relay deliberately does not distinguish these | check `rooms` in `/healthz`: `1` means a Mac is attached and the room is wrong; `0` means no Mac is attached. Cross-check the room with the `deriveRoom` one-liner in 4.3, and re-issue the QR code after the tunnel is up |
| `/r/<room>/…` answers `502 {"error":"the Mac did not answer","detail":…}` | the tunnel is up but the plugin's local listener did not answer — DSH restarting, listener not bound, or the tunnel congested | read the Mac's DSH log; the plugin reports the local failure reason itself. A `504` here instead means the request outlived `requestTimeoutMs` |
| The phone's WebSocket fails to connect, or opens and dies instantly; the Mac's tunnel never establishes | nginx is not upgrading the connection — `proxy_http_version 1.1` and the `Upgrade`/`Connection` pair are missing or only half present | add all three lines from 5.3 to the proxy location, `nginx -t`, `nginx -s reload`. Confirm with `/healthz`: `rooms` stays `0` while HTTPS itself works fine |
| The tunnel drops and reconnects about once a minute | nginx's default 60-second `proxy_read_timeout` closed a quiet socket | set `proxy_read_timeout 3600s` (and `proxy_send_timeout 3600s`), reload nginx. The relay log showing `tunnel for room … disconnected` on that rhythm is the confirmation |
| `curl /healthz` works on 443 but the tunnel never comes up, and the Mac logs `relay: reconnecting in Ns` | as above, or the token is wrong, or `relay.enabled` is true while `url`/`token` is empty | check the Mac's log for `relay: enabled but url or token is empty — not connecting`, and compare tokens |
| The endpoint probe gets no answer | inbound UDP 8788 is blocked (cloud security group, host firewall), or `probePort` is `0` | open UDP 8788 in both places, or set `probePort: 0` and stop expecting a reply |
| `413 {"error":"request body too large"}` | the request body exceeded `maxBodyBytes` | raise `maxBodyBytes` if the payload is legitimate |
| The relay exits `1` on start with "no tunnel token configured" | `tokens` is empty, or the process is running somewhere the config file is not, or `MIZAR_RELAY_TOKENS` is set to an empty string | check `WorkingDirectory`, then the file, then the environment |
| The relay crash-loops with `RangeError [ERR_SOCKET_BAD_PORT]: options.port should be >= 0 and < 65536` | a numeric setting came from the environment as a non-number, e.g. `MIZAR_RELAY_PORT=8787a`, so it parsed to `NaN`. Numbers are not validated at load time | fix or remove the offending `MIZAR_RELAY_*` variable — `systemctl show -p Environment dsh-mizar-relay` prints what systemd is actually passing |
| Requests to `https://mizar.example.com/healthz` return nginx's HTML page | the reverse proxy does not cover `/` — only some path under it | point the proxy at `/`; the relay serves `/healthz`, `/tunnel` and `/r/…` from one port |
| Everything works, then stops after a certificate renewal | the renewed config was reloaded without the proxy directives, or the ACME path is proxied to the relay | re-check 5.3 in the current config file; confirm `/.well-known/acme-challenge/` is served from disk |

Two logs answer almost every question here, and reading them together is faster than guessing:

```sh
journalctl -u dsh-mizar-relay -f          # the relay's view
tail -f /www/wwwlogs/mizar.example.com.log # nginx's view (BaoTa's log directory)
```

The relay log says whether a Mac attached and with which room; the nginx log says whether the request
even arrived, and with what status.

---

## 9. Security notes

Stated plainly, without alarmism, because these are properties of the design rather than defects.

**The relay terminates TLS, so whoever runs it can read everything in transit.** Requests, prompts,
session content and the agent's answers pass through the Node process as plaintext on the loopback
side of nginx. The relay does not *interpret* any of it — it has no idea what a session is, and it
never parses a Mizar frame — but "does not interpret" is not "cannot read". When you run the relay
yourself, on your own server, that is usually exactly what you want: you are the one person who
already has access to the Mac. It is *not* fine to hand the relay to somebody else and assume the
tunnel protects you. That is why end-to-end encryption between the phone and the plugin is listed as
future work: with the tunnel as it exists today there is nowhere for it to live, because the relay is
a TLS terminator on the path.

**The room id is a weaker secret than the token, and it travels.** The room appears in a QR code, in
the phone's stored pairing, and in nginx's access log — all places a token must never appear. Knowing
a room lets a stranger reach the plugin's two unauthenticated endpoints, `/mizar/v1/hello` and
`/mizar/v1/pair`; `/pair` still demands a live, single-use code and is rate limited, so a room leak
is survivable. A token leak is not: it lets somebody *be* your Mac, receive every phone request and
answer as the plugin would. That asymmetry is the reason tokens live in exactly two configuration
files and rooms are allowed to travel in QR codes.

**The phone is still authenticated by the plugin, not by the relay.** The relay has no user accounts
and no concept of a device; it cannot grant a phone anything. Pairing codes expire (five minutes by
default), are single-use and rate limited, and the device tokens they issue are individually
revocable — revocation disconnects that device immediately. None of that changes because traffic
arrives through a tunnel, and none of it can be bypassed by reaching the relay.

**Practical hardening, in the order it matters:**

- Keep `host` at `127.0.0.1` and 8787 closed to the internet (5.4). Plain HTTP on a public port puts
  the token on the wire in clear text.
- `chmod 600 relay.config.json`, and do not commit it. One token per Mac, so revoking a Mac is
  deleting one entry and restarting.
- If others can read the unit file, keep the token out of it and use a root-only `EnvironmentFile`.
- Treat a screenshot of the pairing QR as a room disclosure; re-issue the code afterwards rather than
  leaving a live one on screen.
- Keep Node patched — the relay's dependency footprint is one package (`ws`), which is the whole
  reason it is easy to keep current.
- The size and concurrency caps (`maxBodyBytes`, `maxMessageBytes`, `maxClientsPerRoom`,
  `requestTimeoutMs`, `tunnelIdleMs`) are resource guards rather than security controls. They are the
  difference between a stuck phone costing one socket and a stuck phone costing the process.
- Finally: the room derivation means a rotated token changes the room. When you retire a token,
  remember that phones paired against the old room must re-pair — and that anything holding the old
  token can no longer attach.

---

## 10. Push notifications

The relay is the only machine in this system that can reach Apple, so it is the only machine that
can send a notification. The plugin does not have — and must not have — the signing key: a key that
ships inside a plugin installed from a public registry is not a key, it is a public string.

The plugin tells the relay *what happened*; the relay decides nothing. Its judgement stays where the
evidence is, on the Mac.

### 10.1 Making the key

In the Apple developer portal:

1. **Keys → +**, name it anything, tick **Apple Push Notifications service (APNs)**, continue,
   register, download the `.p8`. **It can only be downloaded once.**
2. Note the **Key ID** (10 characters) it shows and your **Team ID** (top right of the portal).
3. The **topic** is the app's bundle id: `me.shirazu.dshmizar`.

The key file is text. Copy its whole contents, including the `-----BEGIN PRIVATE KEY-----` lines.

### 10.2 Configuring the relay

Add an `apns` object to `relay.config.json` (see `relay/relay.config.example.json`), or set the
environment instead — the environment wins, and a container usually wants it:

| file key | environment | meaning |
|---|---|---|
| `key` | `MIZAR_APNS_KEY` | the `.p8` contents; `\n` is unescaped for you |
| — | `MIZAR_APNS_KEY_FILE` | or a path to the `.p8`, instead of inline |
| `keyId` | `MIZAR_APNS_KEY_ID` | the 10-character key id |
| `teamId` | `MIZAR_APNS_TEAM_ID` | the 10-character team id |
| `topic` | `MIZAR_APNS_TOPIC` | the app's bundle id |
| `production` | `MIZAR_APNS_ENV` | kept for config compatibility, no longer used for routing — see below |
| `timeSensitive` | `MIZAR_APNS_TIME_SENSITIVE` | `1` to ask iOS to break through Focus |

**Which APNs service to use is decided per device, not per relay.** Apple runs two completely
separate push services and they do not accept each other's device tokens: a token minted by a debug
build only works against `api.sandbox.push.apple.com`, and sending it to production earns
`BadDeviceToken` — which says nothing about the real mistake.

Which one a phone needs is a fact the *phone* has and a server cannot infer, so the app reports it
with its registration and the relay routes each notification to the host that device's token belongs
to. One relay therefore serves a Mac with a TestFlight phone and an Xcode phone on it at the same
time, with nothing to configure. `MIZAR_APNS_ENV` is kept so existing config files keep loading, and
leaving it set either way changes nothing.

**`timeSensitive` is off by default** because it is only honoured when the app carries the
time-sensitive-notifications entitlement, and asking for a capability an app was not provisioned for
is not a decision the relay should make on an operator's behalf.

Leave the whole `apns` object out and everything else still works: the plugin is told that push is
unavailable, logs it once, and keeps serving sessions. A relay that refuses to boot because a
notification key is missing would take the tunnel down with it, and the tunnel is the part that
matters.

### 10.3 Checking it

```sh
curl -s localhost:8787/healthz
# {"ok":true,"rooms":1,"inFlight":0,"pushDevices":1,"push":true,"version":1}
```

`push: true` means a key is loaded; `pushDevices` counts the phones currently registered. And per
room, with the Mac's own tunnel credential:

```sh
curl -s -H "Authorization: Bearer $TOKEN" localhost:8787/push/v1/status
# {"ok":true,"devices":[{"deviceId":"…","environment":"sandbox","locale":"zh-Hans","registeredAt":…}],"enabled":true}
```

Device tokens are deliberately **not** in that answer: a diagnostic that leaks credentials is not a
diagnostic.

The `environment` reported per device is the one its token belongs to, and it is what the relay
routes that device's notifications through.

A phone appears in `pushDevices` only after its app has been granted permission and told the Mac
about it — which happens on the launch *after* the operator taps Allow. If the count is zero, the
permission was refused or the app has not been opened since. Revoking a device from the panel removes
it here as well, so a phone the operator has just removed stops being woken immediately rather than at
the next relay restart.

### 10.4 What gets sent

Three things, and the list is deliberately short — a notification that arrives for everything is one
nobody reads.

| when | tile | priority |
|---|---|---|
| an agent is blocked on a **permission prompt** | 需要你的许可 / Permission needed | 10, immediate |
| an agent is blocked on a **question** | 模型有问题要问你 / The model has a question | 10, immediate |
| a session **stopped working** | 任务完成 / 任务出错 / 任务已停止 | 5, may be batched |

The third one waits **15 seconds of silence** before it is sent. DSH does not emit one turn per
instruction: measured on a real session, the log holds long runs of consecutive `turn/start` with no
`user/message` between them, because the agent kept working after the turn that answered the prompt
had ended. Announcing every `turn/end` would be three notifications for one instruction — and
teaching somebody to ignore all of them.

The tile says what *happened*, not merely that something did: a turn that ended in `error`,
`aborted`, `blocked`, `max-tokens` or `interrupted` is reported as failed or stopped. Telling an
operator their agent finished when it stopped on an error is worse than saying nothing.

**A notification is not sent to a phone whose app is on screen.** The app reports where it is, and
the plugin hands that down as a list of devices to leave out — so a second phone that is *not* being
looked at still receives everything. (It was one global flag first, and an iPad left open on a session
then silenced the iPhone in somebody's pocket — which is precisely the notification that matters.)

### 10.5 Restarts, and why there is no database

Registrations live in memory. A room's tokens are a cache of what the Mac already knows, and the Mac
re-announces all of them every time its tunnel reconnects — which is exactly what happens when this
process restarts. Persisting them here would be a second copy of a fact that has an owner, and a
relay that came back with stale tokens would have nothing to correct them with.

A token Apple reports as retired — `410 Unregistered`, or `BadDeviceToken` — is dropped on the spot.
Retrying it forever turns a misconfiguration into a permanent stream of failed requests.
