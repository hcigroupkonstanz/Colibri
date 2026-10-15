# colibri-server 2.0: detailed changes

Developer notes on every change in colibri-server 2.0.0, with the reasons behind them. The user-facing summary is in
[CHANGELOG.md](../../CHANGELOG.md).

Everything that changed in colibri-server from `1.3.1` to `2.0.0`. To upgrade a project built on
Colibri 1.x, start with [MIGRATION.md](../../../MIGRATION.md), which covers all three components;
this is the server's full detail.

---

## 2.0.0 (unreleased)

**Breaking changes**

- **New TCP framing.** The 1.x FlatBuffer framing is replaced by a fixed binary header (see
  [v3 TCP protocol](#v3-tcp-protocol-breaking-change)). colibri-unity 1.x cannot connect to this
  server; use colibri-unity 2.x.
- **Protocol version check.** Every client has to announce protocol version `2`, and anything
  else is refused. That includes colibri-web 1.x, which announces `1` although its Socket.IO
  envelope still works; use colibri-web 2.x. See
  [Protocol version checking](#protocol-version-checking).
- **Voice packets carry the app.** The voice header has a header version and an app id now, and
  the relay passes a packet on only to the voice clients of the sender's app. It relays voice only
  from the address of a Unity client of that app. Voice packets from colibri-unity 1.x are dropped;
  use colibri-unity 2.x. See [Voice relay](#voice-relay-breaking-change).
- **Default ports.** 9211 (web), 9212 (TCP) and 9213 (voice) instead of 9011, 9012 and 9013, so
  that a 1.x and a 2.0 server can run side by side on one host, and a client of one version does
  not reach a server of the other by its defaults. `WEBSERVER_PORT`, `TCP_PORT` and `VOICE_PORT`
  still set them. The image exposes the new ports, its health check defaults to 9211, and the
  bundled compose file publishes them. To keep the old ports, set the three variables, or with
  Docker publish 9011 to 9013 on the new container ports. See
  [MIGRATION.md](../../../MIGRATION.md#default-ports).
- **REST store media type.** The store takes and answers only `application/vnd.colibri.v2+json`.
  A `PUT` sent as `application/json` or form data gets 415, and an `Accept` that leaves the type
  out gets 406. See [REST store](#rest-store).
- **Node 24 and native ESM** to run from source.
- **Docker image.** The server runs as the non-root `node` user, started through a new
  `colibri-entrypoint.sh` that replaces the node base image's entrypoint; `CMD` is
  `node --enable-source-maps dist/server/main.js` instead of `npm start`. See
  [Docker](#docker).

**Not in this release:** batched `model::request` replies, and security hardening beyond optional
[TLS](#tls); see [Deferred work](#deferred-work).

### Protocol version checking

- **Both transports check the protocol version.** `PROTOCOL_VERSION` in
  [`protocol.ts`](../../src/server/modules/networking/protocol.ts) is the single source of truth
  for the TCP handshake and the Socket.IO query. Until now the version was parsed, stored and
  logged, but compared against nothing, so a client built against the wrong protocol reconnected
  forever against a server that said nothing unusual.

  A mismatched client is refused: it is told why with a `colibri` / `protocol::rejected` message
  (`{ reason, serverVersion, clientVersion }`) and then disconnected, and it never enters the app
  index or `clientConnected$`, so no half-connected ghost reaches the admin UI. The server logs
  every refusal with the client's address and both versions. The admin UI itself is exempt: it
  ships with the server, and a check that can lock you out of your own console is worse than the
  mismatch it detects. Its own query was bumped from the stale `'1'` to `'2'`. `clientVersion`
  is always a string: `''` when a Socket.IO client sent no version, with a reason that says
  `'(none)'`. Documented under [Version checking](protocol.md#version-checking).

- **A refused TCP client is dropped at once.** The refusal frame is queued ahead of the FIN, and
  the client leaves every index straight away. Before, the next heartbeat logged a
  `write after end` warning and error and could cut off the refusal frame, and frames sent behind
  a refused handshake were logged as `Ignoring message ... without app`. A peer that never closes
  its side is disconnected after 5 s. The same goes for a client cut off for an invalid frame.

- **A Colibri 1.x Unity client is named in the log.** The refusal cannot reach it: it cannot
  decode the new framing, and its own handshake fails to parse before its version is read. The
  server now recognises the 1.x framing and logs one warning naming the client's address, the
  protocol version the server speaks and the Unity package to upgrade, at most once a minute per
  address, instead of an anonymous `Invalid frame length: 1744830464` every time it reconnected.

- **The server announces its protocol version on connect**, as `colibri` /
  `protocol::accepted` with `{ serverVersion }`, to every Socket.IO client it accepts. The version
  check runs on the server, so it can only ever catch a stale *client*; this is what lets a client
  catch a stale *server*, which otherwise neither refuses it nor says what it speaks.

  It has to be an explicit message. The obvious alternative (inferring from the 100 ms `latency`
  broadcast, which only a "current" server sends) is wrong: that broadcast was added in
  colibri-server **1.2.0**, so every 1.2.x and 1.3.x server sends it while still speaking the old
  protocol. Checked against the published `hcikn/colibri:1.1.1` and `hcikn/colibri:1.3.1` images
  rather than assumed, after the repo's own `v1.1.2` tag turned out to predate both. Nothing else a
  web client can observe separates them. Written up under
  [Detecting an out-of-date server](protocol.md#detecting-an-out-of-date-server).

  TCP clients are sent no announcement and need none: the framing changed incompatibly in 2.0.0, so
  an old server is already unmistakable to them.

- **Nothing is sent to a TCP client before its handshake is accepted.** The 100 ms heartbeat
  went to every connection, so a client the server was about to refuse could get a heartbeat
  first and count itself connected: colibri-unity reported a connection and then the protocol
  mismatch. Now a refused client's first frame is the refusal.

- **A TCP client that handshakes again leaves its old app properly.** It is reported as
  disconnected from the old app and connected to the new one, the old app's synchronized models
  are cleared if it was the last client there, and the admin UI no longer lists it twice.

- `npm run test:tcpclient` takes an optional version argument (`-- 1`) so the refusal can be
  driven by hand against a live server. It prints the server's reason and exits with code 2 on a
  refusal, instead of blaming missing heartbeats, and with code 1 when the server sends a frame it
  cannot decode, even after a heartbeat.

- `npm run test:vectors`, which CI runs, fails when colibri-web, the Unity package or the admin UI
  announce a protocol version different from the server's.

### TLS

- **Optional TLS.** With `TLS_CERT` and `TLS_KEY` set to PEM files, the Unity TCP port accepts only
  TLS, and the web port serves only HTTPS and WSS, both with the same certificate. RSA and EC
  certificates both work. The v3 framing inside TLS is unchanged, so the protocol version stays the
  same. With both unset, nothing changes. See [TLS](../guide.md#tls) in the guide.
- **The certificate's SHA-256 fingerprint is logged at startup**, for pinning in Unity, and for a
  self-signed certificate the line says how a Unity app and a browser come to accept it. A renewed
  certificate in the same files is used within about 20 s, without a restart; open connections
  keep the certificate they started with. The server warns when the certificate is not valid yet,
  expires soon, or has expired.
- **TLS mismatches are named in the log**, each at most once a minute per address. A Unity client
  without TLS on a TLS port is named with its app, and is sent nothing. A TLS client on an
  unencrypted port is named too; it used to hang silently until the idle timeout. A failed TLS
  handshake is logged at info level, with a hint about the certificate.
- **TLS files the server cannot use stop it at startup**, with a message naming the variable, the
  file and the fix: only one of the two set, a file missing or unreadable, certificate and key
  swapped, a key with a passphrase, or a key that is not the certificate's, including an RSA key
  with an EC certificate or the other way round. A renewal with the same problems is not used: the
  server warns once and keeps the old certificate.

### Reverse proxies

- **Client addresses behind a reverse proxy.** Behind nginx or another proxy, every client was
  logged, refused and listed at the proxy's address. New `TRUSTED_PROXIES` names the proxies trusted
  to report the client's address: IP addresses, CIDR ranges and `loopback`, `linklocal` and
  `uniquelocal`, as in Express's `trust proxy`. Empty, the default, trusts nobody and changes
  nothing. An invalid entry stops the server at startup, naming it. See
  [Behind a reverse proxy](../guide.md#behind-a-reverse-proxy).
- **Web port:** from a trusted peer, a Socket.IO client's address is the right-most
  `X-Forwarded-For` entry that is not itself a trusted proxy, so a client cannot choose it by
  sending the header itself. It names the client in the log and the admin UI, and is its `name` in
  `colibri::clients`, which every client of the app receives. Express's `req.ip` agrees.
- **TLS terminated by proxy:** a proxy that terminates TLS connects unencrypted, so the admin UI
  showed no TLS anywhere and TLS as *Off*. From a trusted peer, a Socket.IO client now counts as TLS
  terminated by proxy when the right-most `X-Forwarded-Proto` entry is `https` or `wss`, in any
  case. The proxy must set the header, replacing the client's. The Clients page shows it as *TLS
  (proxy)*. Without a certificate, and while such a client or admin page is connected, the Server
  page shows the web port as *HTTP and WS, TLS terminated by proxy* and TLS as *Off* with
  *terminated by proxy (HTTPS)*. The admin topics carry it as `tlsAtProxy` ([Admin UI
  channel](protocol.md#admin-ui-channel)). nginx's PROXY protocol header, version 1, does not say
  whether the proxy terminated TLS, and the server skips the TLS details a version 2 header can
  carry, so new `TCP_TLS_AT_PROXY=true` declares that the proxy's TCP port terminates TLS. With it
  and `TCP_PROXY_PROTOCOL`, and without a certificate, a Unity client through a trusted proxy shows
  as *TLS (proxy)* too, and the Server page shows the TCP port as *TLS terminated by proxy*, TLS
  with *terminated by proxy (TCP)*, and the setting as *TCP TLS termination: Proxy*. Without it,
  Unity clients through a proxy show without TLS, the TCP row says *unencrypted, proxy TLS
  undeclared*, and the setting *Not declared*. Set without `TCP_PROXY_PROTOCOL`, it has no effect,
  and the server warns at startup. It takes only `true` or `false`.
- **TCP port:** with new `TCP_PROXY_PROTOCOL=true`, a connection from a trusted peer must start
  with a PROXY protocol header, version 1 (nginx's `proxy_protocol on`) or 2. It is read ahead of a
  TLS handshake, also when it arrives in pieces. The client it names is the one in every log line
  and per-address warning limit. A trusted peer without a valid header within 10 s, and a header
  from any other peer, are refused with a warning at most once a minute per address. The setting
  takes only `true` or `false`, and needs `TRUSTED_PROXIES`. See
  [PROXY protocol](protocol.md#proxy-protocol).
- Voice (UDP) still shows the proxy's address: nginx's PROXY protocol covers TCP only. Voice from
  an address in `TRUSTED_PROXIES` is relayed without the check that its sender is a Unity client's
  address ([Voice relay](#voice-relay-breaking-change)).

### Docker

- The Dockerfile is multi-stage: the builder runs `npm ci` and the full build (admin UI and
  server); the runtime image ships `dist/` and the production `node_modules` only, and has a
  `HEALTHCHECK`. The admin UI's build-only packages (Angular, PrimeNG, d3, zone.js,
  socket.io-client, fonts) are dev dependencies now and stay out of it, which shrinks the image
  from 338 MB to 189 MB.
- The `HEALTHCHECK` asks `/api/store` on the `WEBSERVER_HOST` and `WEBSERVER_PORT` the server is
  configured with, read like the server reads them: from the environment, else from a `.env` in
  `/srv/colibri`. A container with another web port, with `WEBSERVER_HOST=localhost` (which Node
  binds to `::1` there) or with a `BASE_URL` is healthy, where a check of a fixed
  `127.0.0.1:9211/` would leave it unhealthy for good, and restarted over and over by anything
  that acts on health.
- The server runs as the non-root `node` user (uid 1000). The image starts as root only long
  enough to give `/srv/colibri/data` to `node` (when something in it belongs to someone else, and
  never following a symlink), and then runs the server as `node`. So a bind-mounted directory that
  Docker creates, or a root-owned `data/` left by 1.x, works as it is; before, writing
  `store.json` failed with `EACCES` while `PUT /api/store` kept answering 201. Started with
  `--user`, the container cannot do this, and the server's own startup check reports that it
  cannot write there (see [Logging](#logging)). When `chown` fails (on a read-only mount, a file
  system without Unix owners, or without `CAP_CHOWN`), the entrypoint says so and starts the
  server anyway, which then checks whether it can write there. A `DATA_ROOT` outside
  `/srv/colibri/data` is not touched, and `docker exec` opens a root shell by default.
- Only `/srv/colibri/data` belongs to `node`. The server's own code stays root's, so the user the
  server runs as cannot change it, and `node_modules` and `dist` are no longer copied into a
  second layer by a `chown` of the whole directory, which saves about 17 MB.
- `node` itself is PID 1 (`CMD` is `node --enable-source-maps dist/server/main.js`, not
  `npm start`), so `docker stop`'s `SIGTERM` reaches the server and it shuts down cleanly.
- The image sets `NODE_ENV=production`.
- `docker-compose.yml` caps the container log at 5 × 10 MB, since client log lines now reach
  `docker logs` and Docker's default log never rotates.
- `npm run build` records the commit it builds in `dist/server/build-info.json`: from the build
  arguments `COLIBRI_COMMIT` and `COLIBRI_COMMIT_DIRTY`, which `npm run publish` passes, and
  `docker-compose.yml` from the environment, else from git. The image has no `.git`, so a
  `docker build` without them reports the commit as unknown.
- New `npm run test:docker` runs the image against a fresh bind mount, a root-owned 1.x data
  directory, a named volume, as `--user 1000:1000`, with the 1.x data mounted read-only, without
  `CAP_CHOWN`, and with a changed `WEBSERVER_PORT` or `WEBSERVER_HOST`.
- With [TLS](#tls) on, the health check asks over HTTPS without checking the certificate, so a
  container with a self-signed certificate is still reported healthy. `docker-compose.yml` has the
  TLS lines, commented out.

### Logging

- **Service log messages are printed to stdout and stderr**, one line each
  (`<ISO time> <LEVEL> [group/service] message`, errors and warnings on stderr), so they appear
  in `docker logs`: refused clients, `store.json` write failures, TCP worker crashes and restarts,
  and client log lines at their level. Before, they reached only the admin UI's in-memory log. New
  `CONSOLE_LOG_LEVEL` (`error`, `warn`, `info` or `debug`; default `info`, and an invalid value
  stops startup) and `CONSOLE_LOG_BROADCAST_TRAFFIC` (default `false`). Control characters are
  escaped and continuation lines indented, so text from a client cannot pass for a server line,
  and a message over 8 KiB is cut.
- **The server checks at startup that `DATA_ROOT` is writable.** If it is not, it prints a
  banner on stderr naming the path, the error and its uid, with a fix for that error (`chown`
  or a named volume for missing permissions, dropping `:ro` for a read-only mount, moving a file
  that is in the way, freeing space on a full disk), and logs an error in the admin UI. It keeps
  running without persistence, but no longer silently: before, `PUT /api/store` answered 201 and
  the only sign that nothing was saved was an `EACCES` in the admin UI's log.
- **`broadcast::` traffic is logged**, at Debug level and tagged `broadcastTraffic`, so the
  admin UI can show sync traffic between clients when asked to; see [Admin UI](#admin-ui).
- The shutdown and crash lines (`Received SIGTERM, shutting down...`, a shutdown step that
  failed, an uncaught exception, an unhandled rejection, a failed startup) are printed in the same
  format, as `[core/Server]`, and appear in the admin UI's log too.
- The log starts with the version and the commit the server was built from:
  `Colibri 2.0.0, commit 1a2b3c4d5e`, `(with uncommitted changes)` for a dirty build, or
  `commit unknown`.
- dotenv no longer prints its `injected env ... // tip` line on every start.
- The `Web server listening on` startup line is printed once the web server is listening. It used
  to be printed before the server had even tried its port, so it appeared when the port was taken
  too.

### Runtime, build & tooling

- Migrated `src/server` to native ESM (`"type": "module"`, explicit `.js` import extensions,
  `fileURLToPath` in place of `__filename`); the Angular UI build keeps working unaffected.
  `publish.js` → `publish.mjs`.
- `src/server/tsconfig.json` is now self-contained instead of extending the Angular root config:
  `strict`, `noUncheckedIndexedAccess`, `nodenext` module resolution, Node 24 target.
- Runtime bumped from `node:20-alpine` (EOL) to `node:24-alpine`; `@types/node` refreshed;
  `source-map-support/register` replaced with `--enable-source-maps`.
- Dependencies updated: Angular 17 → 22.1, Express 4 → 5, dotenv 16 → 17. engine.io 6.6.11 and
  qs 6.16.0 fix the advisories `npm audit` reported against them (GHSA-2gc4-cqfq-p2gv,
  GHSA-x5fp-wj9c-mxmx, GHSA-4mjr-xmp4-gh2g), and proxy-addr 2.0.8 fixes GHSA-jqcg-44mw-7w3h,
  which concerns trusted proxy addresses.
- proxy-addr is now a direct dependency: `TRUSTED_PROXIES` uses it for `X-Forwarded-For` and for
  the PROXY protocol's trust check.
- `package-lock.json` un-ignored and committed; Docker build uses `npm ci` instead of `npm install`.
- Added Vitest (`test`/`bench` scripts), a `test/` unit suite, and a `bench/` harness
  (`connection-pool.bench.ts`, `data-store.bench.ts`, `framing.bench.ts`). Benchmark results are
  not committed: they depend on the machine and the Node version, so they belong in the pull
  request that claims them.
- Added `.github/workflows/lint-server.yml` (Node 24: build, lint, unit tests, admin UI tests and
  `test:vectors`), path-filtered on `colibri-server/**` and on the files `test:vectors` checks in
  colibri-unity and colibri-web.
- Removed `body-parser` (→ `express.json()`/`express.urlencoded()`), `uuid` (→
  `crypto.randomUUID()`), `source-map-support`, `flatbuffers` (removed once the v3 TCP protocol
  landed) and `lodash` (also from the admin UI, see [Admin UI](#admin-ui)).
- Version bumped `1.3.1` → `2.0.0`; dropped the blanket `eslint-disable no-unused-vars` in `main.ts`
  and cleaned up its unused imports.
- `npm run demo` runs synthetic Unity and web clients in two apps against a server, so the admin UI has
  data to show without headsets ([Development](development.md)).

### Hot-path performance

- **`Payload` abstraction** (`modules/core/payload.ts`): holds whichever representation (string or
  parsed value) arrived and memoizes the other on first access, replacing the double
  `JSON.stringify`/`JSON.parse` round trip on every cross-transport message. Both `FIXME: terrible
  workaround` blocks in `socket-io-server.ts` are gone; web→web and TCP→TCP relaying now does zero
  JSON work.
- **Socket.IO rooms**: clients join a room per app on connect; app-scoped broadcasts go through
  `io.to(app).except(originId).emit(...)`, so Socket.IO encodes each packet once per room instead of
  once per recipient.
- **Client indexing**: `ConnectionPool` and the TCP worker/proxy now resolve recipients from
  `Map`-based indexes (`Map<id, client>`, `Map<app, Set<client>>`) instead of linear `find`/`filter`
  scans.
- **No more UUID arrays across the worker boundary**: the `m:broadcast` message now carries
  `{ msg, app, exclude }`; the worker resolves recipients from its own per-app index instead of
  structured-cloning a full client-id array per broadcast.
- **Apps without recipients cost nothing**: both the TCP and Socket.IO sides check whether an app
  has any client on that transport before touching the payload, instead of paying a full
  parse/stringify and encode for apps with zero clients there.
- **`DataStore` rewritten onto nested `Map`s** (`Map<app, Map<channel, Map<id, SyncModel>>>`),
  replacing the O(n) array `_.find` scan. This also fixes two real bugs structurally: the ambiguous
  `group + channel` string-key collision (app `'ab'` + channel `'c'` vs. app `'a'` + channel `'bc'`),
  and `clearApp` over-matching on a `startsWith` prefix (disconnecting the last client of app `test`
  no longer wipes app `test2`'s store). Regression tests cover both.
- **Single merged message stream**: the RxJS `merge(...)` that used to rebuild on every access via a
  getter is now built once in the `ConnectionPool` constructor and routed through a command lookup
  table instead of seven independent `filter` chains.
- **Ring buffers** replace `Array.shift()`-based eviction for per-client latency samples
  (`measure-latency.ts`) and the in-memory log buffer (`web-log.ts`, cap reduced from 1,000,000 to
  20,000).
- **Log fan-out early-out**: `redirectLogMessage` skips `JSON.stringify` entirely when no `colibri`-app
  client is connected; the log bus is now a shared `Service`-level publish target instead of an
  init-time snapshot of the service list, so coverage no longer depends on construction order.

### v3 TCP protocol (breaking change)

- Replaced the v1 ASCII-length-delimited FlatBuffer framing with a fixed binary header (`u32` length +
  `u8` type + body), removing per-packet `toString('utf8')` and `indexOf('\0', …)` scanning and
  replacing the loose `Number.isFinite` length check with a real bounds check.
- Replaced per-`data`-event `Buffer.concat` with a persistent, growable read buffer with read/write
  cursors, which removes the O(n²) copy cost on fragmented streams. A frame over 5 MiB still ends
  the connection. See [Known limits](#known-limits) for what the buffer does not do.
- TCP payloads relay as raw bytes; `toString('utf8')` only happens where a hook actually needs the
  string, so TCP→TCP `broadcast::` traffic never becomes a JS string.
- A payload crosses between the TCP thread and the main thread, in either direction, in a buffer
  of exactly its own size. A small `Buffer` is usually a view into Node's shared 64 KiB pool, and
  `postMessage` copies the whole pool behind a view, so without this a 30-byte update would cross,
  and be kept alive on the other side, as 64 KiB.
- Egress now writes the header in place into one pre-sized `Buffer`: no separate `TextEncoder`, no
  merged `Uint8Array`, no FlatBuffer builder. The `flatbuffers` dependency and
  `modules/networking/message.ts` were deleted. Egress is bounds-checked like ingress: a message
  whose channel or command exceeds 64 KiB, or whose frame would exceed 5 MiB, is dropped and logged
  instead of throwing inside the TCP worker.
- Backpressure: writes are checked against `socket.writableLength`/a high-water mark, and a stale
  update is dropped rather than buffered without bound for a client that can't keep up. Only the
  start and the end of a dropping spell are logged, with the number dropped. Heartbeats and the
  answers to a client's own requests are not dropped; see
  [Load and lost connections](#load-and-lost-connections).
- Heartbeat and latency ping merged into a single 100 ms frame (the ping timestamp rides in the type
  `0x00` heartbeat), halving idle TCP packet rate. colibri-unity 2.0.0 echoes it, so the admin UI
  shows the latency of Unity clients too.
- A handshake body with more than three `::`-separated fields is rejected rather than silently
  truncated, and so is one with a field that starts or ends with `:`. App `app:` and name `name`
  make the body `2::app:::name`, which split back into app `app` and name `:name`, so the client
  joined another app than the one it announced without an error anywhere.
- Web clients may send messages as large as TCP clients: the Socket.IO server accepts packets of
  about 5.13 MiB (a 5 MiB payload plus channel and command), where engine.io's 1 MB default used to
  disconnect them.

Checked end to end against colibri-unity 2.0.0, with a decoding proxy in front of the TCP port:

- **Framing.** The handshake arrived as the documented `version::app::name` body with client
  version `2`. Message frames carried all 17 payload shapes in both directions, relayed
  **byte-verbatim**: a `broadcast::string` payload arrives as `"hello from unity round 1"`, 26 bytes
  for 24 characters, while the `log` channel's `verification log line 1` stays unquoted at 23 bytes
  for 23 characters. What a client sends is what the other side receives, quoting included, with
  no re-serialization in between. That is what `Payload` was meant to achieve.
- **Heartbeat/latency merge.** The 100 ms server heartbeat was echoed continuously by the Unity
  client; a raw client counted 369 heartbeats in one 40 s session, and the client-side 2 s watchdog
  never fired across many minutes of connected time.
- **Reconnect.** Killing the transport mid-session produced exactly one connection-reset message
  on the client, then a reconnect, a fresh handshake, and queued messages resuming with no gap in
  their numbering. No `FrameException` reached the client console and there was no retry spin, so
  neither side was left mid-frame by the drop.

The C# codec stays pinned to this server's encoder by byte-for-byte vectors in colibri-unity's
EditMode tests, which `npm run test:vectors` checks in CI.

### Voice relay (breaking change)

- **A voice packet reaches only the sender's app.** Every packet used to go to every other voice
  client on the server, whatever its app: every client received all voice traffic, anyone could
  listen to any app, and two apps using the same fixed voice id heard each other.
- The header is 11 bytes: the 7 bytes 1.x had, with a header version (`2`) in the high 4 bits of
  the codec byte, then the app id, the 32-bit FNV-1a hash of the app name. See
  [Voice packets](protocol.md#voice-packets-udp). `voice-packet.ts` holds the format and the hash.
- A packet from a colibri-unity 1.x client, whose codec byte reads as header version 0, is dropped
  and logged as a warning that says to upgrade the Unity package. A packet with another header
  version is dropped as malformed. Each source is reported at most once every 10 s, as for the
  other malformed packets.
- A client whose packets name another app moves to it. The relay finds a packet's peers in a list
  per app, rebuilt only when a client joins, times out or changes app.
- A voice recording (`VOICE_RECORDING=true`) is named
  `rec_<start time>_app_<app id>_ID_<voice id>_port_<source port>.wav` instead of
  `rec_<start time>_ID_<voice id>.wav`. Two recordings with the same voice id that started in the
  same millisecond, as clients of two apps can after a restart, got the same name, and the second
  replaced the first.
- **Voice only from a Unity client's address.** A packet is relayed, and its sender relayed to,
  only if a Unity client of the packet's app is connected on the TCP port from the packet's source
  address, and an address gets at most one voice client of an app per such Unity client. Every
  sender used to be registered: one packet with a forged source address every 2 s had the server
  stream an app's voice to that address, for an app id anyone can compute from the app name, and
  each forged source port at one address was sent its own copy. A new sender over the limit takes
  the place of a voice client quiet for 500 ms, so that a Unity client's voice socket opened again
  on a new port gets in within 0.5 s. The voice clients at an address stop receiving as soon as the
  last Unity client of their app there disconnects; those over the number left after one
  disconnects are dropped within 1.5 s. Other packets are dropped. A Unity client's voice often
  starts a moment before its TCP handshake is in, so a source is reported as a warning only once its
  packets have been dropped for 3 s, at most once every 10 s, and its first dropped packet is a debug
  line. Voice from an address in `TRUSTED_PROXIES` is relayed unchecked and unlimited, also while a
  Unity client is connected from the proxy's machine; the server logs this once per address. See
  [Voice relay](../guide.md#voice-relay).
- An address with n Unity clients of an app can still be sent n copies of the app's voice: a
  forged sender can take the place of one of them that sends no voice.
- The app id keeps apps apart but is not access control: anyone who knows an app's name and can
  reach the TCP port can join the app and send and receive its voice. Voice is not encrypted.
- **Voice on IPv6.** A `VOICE_HOST` that is an IPv6 address gets an IPv6 socket. On `::` it takes
  IPv4 clients as well and relays between the two kinds; on another IPv6 address it takes only
  that address. The voice socket was always IPv4, which cannot bind an IPv6 address:
  `VOICE_HOST=::` failed with `bind EINVAL` and voice stayed off. Any other `VOICE_HOST` keeps the
  IPv4 socket. `TCP_HOST` and `WEBSERVER_HOST` already took an IPv6 address, so `::` on all three
  serves clients that reach the server over IPv6, such as colibri-unity 2.0.0 with a server name
  that has only an AAAA record. With an A record as well, colibri-unity 2.0.0 connects and sends
  voice over IPv4, so TCP and voice come from the same address, as the voice check needs. See
  [Configuration](../guide.md#configuration).

### Load and lost connections

- **An overloaded server no longer queues TCP messages without bound.** The TCP thread passed
  every message to the main thread as fast as clients sent it, so a server taking in more than it
  could process kept a growing queue of them in memory, logged nothing, and relayed state that was
  older and older. Once the main thread is `TCP_INBOUND_BACKLOG_LIMIT` messages behind (default
  2000, `0` turns it off), `model::update` messages are held back per client and merged per
  object, so intermediate states are skipped but the latest value of every field still arrives,
  and `broadcast::` messages are dropped. Nothing else is ever held back or dropped, and a
  client's held updates are passed on before anything else it sends, and before it disconnects.
- **One client can no longer flood the server for everyone.** Each client, Unity or web, may send
  `CLIENT_MESSAGE_RATE_LIMIT` `model::update` and `broadcast::` messages a second (default 1000,
  `0` turns it off), in bursts of up to `CLIENT_MESSAGE_RATE_BURST` (default 2000, at least 1).
  Beyond that its messages are treated as above. A client syncing 10 objects 72 times a second
  sends 720, so this only catches a runaway send loop.
- An episode over either limit that lasts a second is one warning a second in, naming the setting
  (and the client), and one when it is over, with the number of updates held back and messages
  dropped. A shorter one is summed up in one line at debug level, unless it lost model updates:
  one client can have updates for at most 1000 objects held back at once, and an update for a
  further object is lost for good. Then the summary is a warning, however short the burst, and
  says `lost N model::update(s) for good`. See [Inbound limits](protocol.md#inbound-limits).
- **A warning when one app has more clients than a typical app has.** Every message is
  relayed to every other client of the same app, so the server's work grows with the square of an
  app's size, and separate projects that all kept the same app name become one big app with
  nothing saying so.
  The server now logs a warning naming the app each time it grows past
  `APP_CLIENT_WARNING_THRESHOLD` clients (default 8, `0` turns it off), Unity and web together,
  the admin UI not counted.
- **A TCP client that has gone silent is disconnected.** A headset that leaves the Wi-Fi or goes
  to sleep sends no FIN, so its connection stayed open, listed as connected and keeping its app's
  synchronized models alive, until the operating system gave up on it many minutes later. A TCP
  client that has sent nothing at all for `TCP_IDLE_TIMEOUT_SECONDS` (default 10, `0` turns it
  off) is now disconnected as if it had closed the connection, with a warning naming it, and a
  connection that never handshakes is closed after the same time. Echoing the 100 ms heartbeat
  keeps a client connected. Every TCP connection also has keepalive switched on.
- **A client still reading a backlog is not taken for gone.** A TCP client that sends nothing of
  its own can only echo the heartbeats it has read, so one reading a large backlog stayed silent
  long enough to be disconnected by `TCP_IDLE_TIMEOUT_SECONDS`. The server now writes a heartbeat
  after every 64 KiB it sends, and never drops a heartbeat for a client that is behind. It queues
  at most one 100 ms heartbeat at a time for a client that is not reading, so a client that sends
  but never reads does not grow the server's memory.
- **A client reading a large message over a slow link is not taken for gone.** A message larger
  than 64 KiB has no heartbeat inside it, so a Unity client reading one echoes nothing until it is
  through: one reading a 4 MiB `broadcast::json` over a 200 KB/s link was disconnected 10 s in, and
  never got the message. Until such a client echoes a heartbeat sent after the message, it now gets
  one more `TCP_IDLE_TIMEOUT_SECONDS` for every 64 KiB of it, at most 6 more (60 s at the default),
  enough for a 4 MiB message at about 60 KB/s. A client that is gone by the time such a message is
  sent to it, or goes while it is being read, is noticed that much later, within 70 s at the
  default.
- **A late joiner gets the whole store.** The 1 MiB backpressure drop applies to what is relayed
  from other clients, not to the server's answers to a TCP client's own requests: the models a
  `model::request` asks for, the client list, a `model::delete` answer. Those are queued however
  far behind the client is, up to 64 MiB per client, with a warning past that. Without this, a
  client joining on a link slower than loopback got only about the first MiB of a larger store,
  and nothing told it the rest was missing.

### Model synchronization

- **A deleted model stays deleted.** For `MODEL_TOMBSTONE_SECONDS` after a `model::delete`
  (default 600, `0` turns it off) the server keeps a tombstone for the id, per app and channel, at
  most 10,000 per app. An update for that id is meanwhile neither stored nor relayed, so an update
  another client sent just before the delete, or queued while it was offline, cannot create the
  object again for everyone.
- **Three forms of `model::request`.** `{}` asks for every model of the channel, as before. A
  fresh `{ id }`, from a client that has the object in its scene now or is creating it, lifts the
  tombstone and is answered with the bare `{ id }`. So any client can load a scene with placed
  objects of fixed ids again within that time, the client that unloaded it too, and also after a
  reconnect. A re-request after a reconnect, `{ id, again: true }`, is answered with
  `model::delete`, to the requester only, for a model that was deleted while the client was away,
  and the tombstone stays. colibri-unity and colibri-web 2.0.0 send the re-request form. See
  [Deleted models](protocol.md#deleted-models).
- **Answers keep their order.** After their re-requests, colibri-unity and colibri-web 2.0.0 send
  one more, `{ id, again: true }` for a fresh id on the channel `colibri::reconnect`, and take its
  bare answer as the end of the others. colibri-unity sends it after every reconnect and also takes
  it as the point by which the server has read the deletes it sent again. It also sends one when an
  object's first answer arrives outside that round after the object changed members of its own,
  ahead of those members. colibri-web also sends one after each request for a whole channel, each
  time it asks for one of its models once more, and after the first update with fields that follows
  a fresh request for one of its models when it does neither. The server needs no code for this,
  but has to keep handling one client's messages in order and writing its answers to it in that
  order. See [Requests](protocol.md#requests).

### Correctness & robustness

- **Graceful shutdown**: `SIGTERM`/`SIGINT` now close the HTTP/Socket.IO/UDP servers, terminate the TCP
  worker thread, flush the REST store, and exit 0; `startup()` is awaited with a `.catch`, and
  `unhandledRejection`/`uncaughtException` handlers log, flush the REST store and exit non-zero.
- **One bad message costs one message.** A command hook that throws on a malformed message logs an
  error and drops that message; the throw used to shut the whole server down. A Socket.IO event
  without a `payload` key no longer crashes the process on its way to a TCP client, and one
  without a `command` is logged and ignored.
- **The TCP transport recovers.** A TCP worker thread that exits unexpectedly has its clients
  reported as disconnected and is restarted, up to five times; before, HTTP and Socket.IO kept
  serving while every TCP client was silently gone.
- **VoiceServer hardening**:
  - A datagram shorter than the 7-byte voice header, or one from UDP source port 0, used to crash
    the server; both are dropped now.
  - The `throw err` inside the UDP send callback that crashed the whole process on a transient send
    failure is gone, and a peer that cannot be sent to no longer stops the relay to the others.
  - Malformed packets and relay failures are logged at most once per source or peer every 10 s.
  - The client key is computed once per packet instead of up to four times; the peer list is
    precomputed instead of re-scanning the client `Map` per packet; recordings are stored in a
    growable `Int16Array` instead of a boxed-number array, and saved with `fs/promises` and a
    recursive `mkdir`. A recording is no longer saved twice when saving takes longer than the
    disconnect check's 1 s tick.
  - With `VOICE_RECORDING=true`, stopping the server (`docker stop`, a restart, a crash) saves
    every recording still in progress and logs each save. A recording used to be written only
    once its client had been quiet for 2 s, so stopping the server while anyone was talking lost
    their audio without a word. Saves are logged at info level with the client, the length and
    the file path.
  - Saving a recording does not block the server: the `.wav` header is written directly and the
    samples are written asynchronously, so relaying is not held up for seconds when a long
    recording is saved.
- **Admin log**: a malformed `colibri::log` `requestLog` payload (e.g. `{ levels: 1 }`) from any
  client no longer crashes the server; invalid fields fall back to their defaults. The index that
  merges repeated log lines is bounded by the 20,000-entry history instead of growing forever.
- **Latency**: a `latency` message without a timestamp is skipped instead of being recorded as a
  sample of several million milliseconds.
- **TCP disconnect handling**: `'close'` is now subscribed, and `handleSocketDisconnect` is guarded so
  `clientDisconnected$` fires exactly once per client instead of twice.
- **Config validation**: startup now fails fast on `NaN`/out-of-range environment values instead of
  silently coercing to `NaN`. An absolute `DATA_ROOT` or `WEBSERVER_ROOT` is used as given; it used
  to end up nested under `dist/server`.
- **Stack traces**: `Error.stackTraceLimit` is configurable (`STACK_TRACE_LIMIT`, default 30)
  instead of `Infinity`, and `Service.logError` no longer defaults `printStacktrace` to `true` at
  call sites that already carry context.

### REST store

- **Its own media type**, `application/vnd.colibri.v2+json` (`REST_MEDIA_TYPE`, from the protocol
  version), for request and response bodies. A `PUT` with any other `Content-Type`,
  `application/json` and form data included, answers 415 and stores nothing. Every answer under
  `/api`, errors included, is in the media type. A request whose `Accept` leaves it out answers
  406. No `Accept`, `*/*` and `application/*` take it. colibri-unity's `Store` and colibri-web send
  `Accept` and `Content-Type` in the media type. 1.x parsed `application/json` and form data, so
  `curl -X PUT -d '{"x":1}'`, which sends form data, stored `{"{\"x\":1}": ""}`.
- **Any JSON value up to 5 MiB.** `PUT /api/store/:app/:name` takes numbers, strings, booleans and
  `null` as well as objects and arrays, and bodies up to 5 MiB. colibri-unity's
  `Store.Put(name, 42)` and colibri-web's `setRestObject(key, 'text')` used to get HTTP 400, and
  anything over 100 kB got 413.
- **Any name is an ordinary name.** The store is keyed by `Map`s, so app and value names like
  `__proto__`, `constructor` or `toString` are stored like any other. Before,
  `DELETE /api/store/constructor/keys` broke every HTTP route until a restart, and
  `PUT /api/store/__proto__/x` wrote onto `Object.prototype`. The `store.json` format is unchanged.
- **Errors are JSON**, `{ "error": … }`, with no stack trace or file path, and are logged. `400`
  (malformed JSON) and `413` (too large) keep their status, and every response, errors included,
  carries the CORS headers, so a browser client sees the error rather than a network failure.
- Overwriting an existing value answers 200 for a falsy value (`0`, `false`, `''`, `null`) too;
  it used to answer 201.
- **A request under `/api` that no API route handles gets 404**, with a JSON error, instead of 200
  and the admin UI page. A wrong method or path, such as `POST /api/store/app/name`, stored nothing
  and looked successful.
- **A `PUT` without a JSON body is refused.** With no body or an empty one,
  `PUT /api/store/:app/:name` answers 400 and stores nothing. It used to store `undefined` (a name
  listed under its app that `GET` and `DELETE` then answered 404 for) or, for an empty JSON body,
  `{}`. colibri-unity's `Store` and colibri-web's `setRestObject` send a JSON body for every value,
  `null` included, except that `setRestObject(key, undefined)` sends none: it now gets `false` back
  and stores nothing, where it used to store `{}`. Store `null` instead.
- Saving `store.json` is debounced (~250 ms) and atomic (write `store.json.tmp`, then rename), and
  a save waits for the one still in flight, so two quick writes cannot interleave into a partial
  file. The store is flushed on crash paths as well as on a clean shutdown, but only when it holds
  something `store.json` does not, so stopping a server that cannot write its `DATA_ROOT` no
  longer logs an `EACCES` when nothing changed. A save that failed is tried again at the latest
  at shutdown.
- The store is loaded in `Service.init()` via `fs/promises`, so requests can no longer be served
  before it has loaded. A `store.json` whose top level, or one of whose apps, is not a JSON
  object is skipped with an error instead of breaking every request.

The endpoints are documented under [REST store](protocol.md#rest-store).

### Admin UI

- The Log page filters by level (Error, Warn, Info, Debug) as well as by app, and has a separate
  *Sync traffic* switch, off by default, for the `broadcast::` messages. The server applies both
  filters, so the page is only sent what it shows.
- Repeated log lines are merged into one entry with a count however much other traffic arrives in
  between, and a merged entry updates on screen. Lines from or about different clients are no
  longer merged, and an entry records when it first occurred.
- The Log page works at any width, phones included; below 1365px it used to be cut off at the
  right. Each line shows its time, level (ERR, WRN, INF, DBG), app and client or server source, and
  message in columns, a repeat as `×10` after the message. A web client, whose name is its address,
  shows as the start of its id. A click shows a line's details; clicking an app shows only that app.
  The filters are in a toolbar of the page, folded away on a phone, with a search over the loaded
  lines and a count per level.
- Scrolling up in any way pauses the log and keeps the lines still, with a button to jump to the
  new ones. Only the mouse wheel paused it before.
- The history arrives as one message, in the order the lines last occurred, so merged lines no
  longer appear out of time order; until it arrives, the page drops live lines filtered by its
  previous settings. After a lost connection the page asks for the log again, keeps its lines and
  marks the gap. The app bar shows whether the page is connected.
- A web client's refusal, malformed events and rate limit warnings carry its app, so the app filter
  shows them.
- The Statistics page is now the Clients page, and `/statistics` leads there. A table lists every
  connected client with its app, name, address, transport and TLS, protocol version, time connected,
  latency, messages per second in and out, and whether a load limit holds its updates back. It sorts
  by any column and shows one app (`/clients?app=MyApp`). The latency chart is dark like the rest and
  fits its card; a client keeps its colour while others connect and leave, and the chart shows each
  client's median per second over the last 2 minutes. Below it, a throughput chart: the messages per
  second the clients sent (*In*) or were sent (*Out*), stacked per client. Both charts are full as soon
  as the page opens, and after a lost connection, from what the server kept of the last 2 minutes.
- New Models page: the synchronized models of each app and channel, 50 to a page and filtered by id or
  channel, with their size, number of fields and last update; a model's value as JSON, to read or
  download (over 512 KiB, its start, as text); and the ids deleted lately. It reads once, on
  *Refresh*, or every second with *Live*.
- New Server page: versions, the commit the server was built from, uptime, the settings in effect with
  the variables that set them, the TLS certificate's names, issuer, validity and fingerprint (a
  warning 30 days before it expires), and counts of clients, apps, models and REST store values.
- The Log page goes to the previous and next error or warning (keys `p` and `n`, with the focus in
  the log) and to the first error since the page was opened (`e`). It downloads the loaded lines
  that match its filters and search as text or JSON, which works over plain HTTP, unlike the
  clipboard. A *Connections* switch hides the routine connect and disconnect lines. Levels, search
  and switches are in the address along with the app, so a reload or a shared link shows the same.
- An opened log line links to the clients of its app, and each client on the Clients page to its
  lines in the log.
- The server answers the admin UI's read-only requests on the new channel `colibri::admin`: server
  info (versions, uptime, settings in effect, TLS certificate description, counts), every connected
  client with its transport, address, TLS, connection time, latency, messages per second in and out
  and load limit, and the synchronized models with their tombstones, paginated and filtered, plus one
  model's value. A page asks once or subscribes while it is open; subscriptions are sent again once a
  second and end with the page. Sizes are bounded. Without a subscription the server builds no
  snapshot for it and the TCP worker sends no report. A page that stops reading is skipped until it catches
  up. A page's first client list carries each client's message rates of the last 122 s, and the
  request-only topic `latency` its latency samples of that time, as per-second medians past 200,000
  samples. The server keeps both per client whether or not a page is open: 125 s of latency samples
  (1000 samples before) and the last 125 rates. See [Admin UI channel](protocol.md#admin-ui-channel).
- The model store records each model's last update time and counts its updates. Sizes are measured
  only when the admin UI asks, at most 2 MiB a second; a model that changes keeps its last size for
  up to 10 s, from 1 MiB up to a minute. A model's JSON is formatted only as far as the 512 KiB cut,
  once per change.
- The admin log's history carries the server's time, so "New errors" counts by the server's clock.
- Routine connect and disconnect log lines carry `metadata.connection: true`, and `requestLog` takes
  `showConnections` to leave them out.
- The SPA fallback no longer adds a log entry every time an admin UI page is loaded.
- The admin UI keeps its dark theme whatever colour scheme the visitor's system prefers.
- Replaced the dead Karma/Protractor `test`/`server-app-e2e` targets in `angular.json` (both pointed
  at files that never existed) with Angular's first-party `@angular/build:unit-test` builder
  (Vitest runner); specs for the services and the pages run in CI as `npm run gui:test`.
- Replaced `socketio.service.ts`'s `_.throttle` NgZone-batching with RxJS `throttleTime`; `lodash`
  and `@types/lodash` are removed from `package.json`.
- Fixed the services barrel (`src/ui/app/services/index.ts`) to re-export `ClientService`, matching
  `SocketIOService`/`LogService`.
- The tab underline follows browser back/forward navigation; `RootComponent` read
  `location.pathname` once.
- Self-hosted fonts via `@fontsource/roboto` and `@fontsource/fira-mono`, and dropped the Material
  Icons webfont in favor of the already-loaded `primeicons`; the UI no longer loads anything from
  `fonts.googleapis.com`/`fonts.gstatic.com` at runtime.
- Migrated `LogService`/`ClientService`'s materialized state (message list, client list, filter,
  broadcast-traffic toggle) from `BehaviorSubject` to Angular signals/`computed()`, and converted
  `@Input()`/`@ViewChild` to `input()`/`viewChild()` across the log and latency-chart components,
  applying `OnPush` app-wide. Socket.IO's streaming ingestion layer (`SocketIOService`) stayed RxJS
  deliberately: it's a better fit for multiplexed async event streams than for synchronous snapshot
  state. Zoneless change detection was evaluated and deliberately deferred (the D3 latency chart
  renders entirely outside Angular's template bindings, and the zone-throttle mechanism above only
  exists because zone.js CD is expensive on this app's bursty socket traffic). This makes a future
  zoneless flip cheaper and safer, but doesn't attempt it.

### Deprecations (kept, not deleted)

- Added `@deprecated` JSDoc to `modules/core/serializable.ts`, `modules/core/error-handler.ts`,
  `modules/core/redirect-console.ts`, and `DataStore.addModel`/`DataStore.clear`.

### Tests added

- Unit tests (`npm test`) for the v3 frame parser and encoder (byte-by-byte and split
  fragmentation, coalescing, oversized and malformed frames, the 1.x framing), `DataStore`
  (including both original key bugs), `ConnectionPool`, `Payload` (memoization and the
  `undefined`/`null`/empty-string/invalid-JSON edge cases), the TCP worker and its proxy, the
  Socket.IO server against real `socket.io-client` sockets, the REST store and web server, the
  voice server (apps kept apart, a client changing app, 1.x voice packets, senders matched to
  the Unity clients' addresses, one per Unity client, dropped senders reported after 3 s) and the
  voice packet format, `WebLog`, `ClientLogger`, `BroadcastLogger`, the console log, the `DATA_ROOT`
  check, the configuration, the ring buffer, the deprecated serialization helpers, and the inbound
  limits: the backlog count, the rate limit and the merging of held updates, on both transports.
- `npm run test:vectors` checks the cross-implementation protocol vectors in colibri-unity's
  `ProtocolVectorTests.cs`, frames and voice packets, against this server's encoders.
- `test/tcp-client-test.ts` (`npm run test:tcpclient`) speaks the v3 framing, decodes frames and
  echoes heartbeats; a unit test runs it against a stand-in server for each of its exit codes, and
  checks that no script under `test/` hard-codes the protocol version it handshakes with. Manual
  probes for end-to-end runs: `test/tcp-wire-tap.ts` (a proxy that decodes every frame in both
  directions), `test/tcp-crosstalk-check.ts`, `test/model-inject.ts`, `test/broadcast-inject.ts`
  and `test/stress-echo-peer.ts` (`npm run test:stressecho`).
- `npm run test:tcpclient` and `test/tcp-crosstalk-check.ts` take `--tls`, `--insecure` and
  `--host`, and print the fingerprint of the server's certificate. `npm run test:docker` has a TLS
  deployment. The TLS tests make their certificates with `openssl`, which has to be on `PATH`.
- Unit tests for `TRUSTED_PROXIES` matching, `X-Forwarded-For` on Socket.IO and `req.ip`, the
  PROXY protocol reader (both versions, split, malformed and oversized headers), and the TCP worker
  behind a proxy, with and without TLS.
- Unit tests for the voice socket's type for each kind of `VOICE_HOST`, voice relayed over the
  IPv6 loopback and between IPv4 and IPv6 clients on `::`, and the TCP and web listeners on `::`
  taking clients over both. They are skipped on a machine without an IPv6 loopback.
- Unit tests for the admin UI channel: snapshot sizes bounded for large stores and long query names,
  the store left unchanged, nothing sent or asked of the TCP worker without a subscription,
  subscriptions ending with the page, refreshes skipped for a page that stopped reading, the request
  limit, the measuring budget, the JSON formatter's cut, the message counts and load limits on both
  transports, the rate history of a page's first client list and the latency history's bounds.

### Documentation

- Added `docs/protocol.md`: which messages the server relays, the v3 framing, version checking and
  detecting an out-of-date server, the payload shape of every `broadcast::` command, size limits,
  the inbound limits with the warnings as the server prints them, the server's own channels,
  model synchronization, the REST store and the voice packet format. For models it covers the three `model::request` forms
  (`{}`, a fresh `{ id }`, a re-request `{ id, again: true }`), tombstones, and what each client
  does after a reconnect; under backpressure, that answers and heartbeats are not dropped at the
  1 MiB mark, and that the 100 ms heartbeat is skipped while one still waits. Its known limits
  say that a colibri-unity object that changed during an outage reaches a server that forgot it
  with only the changed fields.
- README updated for the Node 24 requirement, the v3 protocol, a Docker setup that works outside a
  checkout, the configuration variables (`MODEL_TOMBSTONE_SECONDS` included), where logs go, the
  load limits, and the npm scripts. Its Docker example does not set `tty: true`, which left
  `docker logs` without stderr, and it says to mount data at `/srv/colibri/data` rather than move
  `DATA_ROOT`.

### Known limits

- The TCP read buffer compacts after every `data` event that leaves a partial frame behind (a copy
  of that partial frame), rather than only past a threshold, and it never shrinks: a connection
  that once received a large frame keeps a buffer of up to 8 MiB until it closes.
- A client that falls more than 1 MB behind on TCP misses messages relayed from other clients
  without being told; see [Backpressure](protocol.md#backpressure).
- A client over an inbound limit is not told either that its updates were held back or its
  broadcasts dropped; only the server's log says so. See
  [Inbound limits](protocol.md#inbound-limits).
- After a reconnect, clients catch up on deletions only within `MODEL_TOMBSTONE_SECONDS` of the
  delete, and colibri-web only for the models it registered itself; see
  [Known limits](protocol.md#known-limits) in the protocol docs.

### Deferred work

Not part of this release:

- **Batched `model::request` reply.** Left as one `model::update` per model (`model-sync.ts` still
  loops `connectionPool.emit(...)`), to avoid a coordinated breaking change with colibri-web's
  `ModelSynchronization.ts` and colibri-unity. The unbatched path is exercised against a Unity
  client: in the end-to-end run a late joiner re-created a model from stored state via
  `model::request` with every synced member applied, as exactly one instance.
- **Security hardening**, by design: Colibri is meant for local networks you trust and
  authenticates nobody. There is no handshake token, the app name `colibri` is what makes a client
  the admin UI, CORS allows any origin, there are no connection caps, and [TLS](#tls) is off
  unless `TLS_CERT` and `TLS_KEY` are set; the per-client message rate limit is there to catch a
  runaway send loop, not a hostile client, which can open as many connections as it likes. Model objects are plain objects, not null-prototype ones. Voice
  is kept within an app by an app id anyone can compute from the app name, is relayed only from the
  address of a Unity client of that app, one voice client per Unity client, and is not encrypted.
  The structural changes that would have come first (Socket.IO rooms, `Map` keying in `DataStore` and
  the REST store, bounds checks on TCP ingress and egress) landed anyway, on performance and
  robustness grounds.
