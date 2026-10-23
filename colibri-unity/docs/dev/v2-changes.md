# colibri-unity 2.0: detailed changes

Developer notes on every change in colibri-unity 2.0.0, with the reasons behind them. The user-facing summary is in
[CHANGELOG.md](../../CHANGELOG.md).

**2.0.0, unreleased.**

**Note:** paths and member names in this document are those of 2.0. In 2.1 the package moved to `Runtime/` and
`Editor/` and several classes were split. The layout is described in
[conventions.md](conventions.md#package-layout), the move in the [CHANGELOG](../../CHANGELOG.md) and in
[MIGRATION.md](../../../MIGRATION.md#unity-package-20-to-21).

Summary of everything that changed in the `1.3.1` → `2.0.0` modernization, closing out the v2
release across all three packages. `colibri-server` 2.0.0 replaced the v1 TCP framing with a fixed
binary v3 protocol (see its [change log](../../../colibri-server/docs/dev/v2-changes.md)); this release is
the Unity client's side of that change. To upgrade a 1.x project, start with
[MIGRATION.md](../../../MIGRATION.md), which covers all three components, then read the [Breaking
changes](#breaking-changes) below as well: among them the per-object send-rate limit, which changes
what other clients receive without failing to compile.

The ease-of-use and sync-loop pass that closes the release is written up in more depth (mechanism,
rationale, migration steps, and what the Editor verification did and did not cover) in
[`docs/v2-ease-of-use-and-performance.md`](v2-ease-of-use-and-performance.md).

---

## Breaking changes

- **Protocol.** colibri-unity 2.0.0 speaks the [v3 binary TCP
  protocol](../../../colibri-server/docs/dev/protocol.md) and **requires colibri-server ≥ 2.0.0**. It cannot
  talk to a 1.x server, and a 1.x client cannot talk to a 2.0.0 server. There is no version
  negotiation: both sides must be upgraded together.
- **Default ports 9211, 9212 and 9213**, colibri-server 2.0's defaults, instead of 9011, 9012 and
  9013, for the web (Store), TCP and voice ports of a new configuration. A configuration saved by
  1.x keeps the ports it saved: set the new ones in *Window → Colibri Configuration*, unless the
  server keeps the old ones. See [MIGRATION.md](../../../MIGRATION.md#default-ports).
- **Voice packets carry an app id.** The voice header has a header version and an app id, the
  32-bit FNV-1a hash of the App Name as the TCP handshake sends it, and colibri-server 2.0.0
  passes a packet on only to the clients with the same app id. Voice ids only have to be unique
  within an app now, and 1.x and 2.0.0 clients do not hear each other. The server relays voice only
  from the address of a client connected with the same App Name, so voice needs
  `WebServerConnection` connected too, and after an App Name change it resumes only once that
  reconnects. See
  [Voice packets](../../../colibri-server/docs/dev/protocol.md#voice-packets-udp).
- **Minimum Unity is 2022.3 LTS** (the package manifest previously claimed 2019.4 while using APIs
  that were never available there).
- **No more third-party runtime dependencies.** UniRx is gone and was not replaced;
  `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()` are now plain
  `static event Action<SyncBehaviour<T>>` instead of observables. Anything that subscribed to them
  as `IObservable<>` has to be rewritten as `+=` / `-=`, and, unlike a UniRx subscription, a static
  event does **not** unsubscribe itself when the component is destroyed.
- **`WebServerConnection.Connected`** is a `Task` gate instead of an `IObservable<bool>`.
  `await connection.Connected` is unchanged; anything that subscribed to it is not. It completes
  once the server has sent its first frame, not when TCP connects, and it is cancelled when the
  server refuses this client's protocol version or the component is disabled. Awaiting it then
  throws `TaskCanceledException`.
- **`Store` converts values with Newtonsoft instead of `JsonUtility`.** `JsonUtility` saved public
  fields and private `[SerializeField]` fields; Newtonsoft saves public fields and properties. A
  private `[SerializeField]` field is therefore neither saved nor loaded any more: make it public
  or add `[JsonProperty]`. A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color` inside the
  saved class goes through `ColibriJson`'s converters and is saved as an array of its components,
  where `JsonUtility` wrote `{"x":…}`. Values 1.x saved that way still load.
- **`ObservableModel<T>`, `ObservableManager<T>` and `Samples/ObservableModel` are deleted.**
- **Vendored `Newtonsoft.Json.dll` is gone**, replaced by the `com.unity.nuget.newtonsoft-json`
  package, which is declared as a real dependency, so installing Colibri is one git URL and nothing
  else.
- **The samples are no longer compiled into your project.** `Samples/` was a live package folder, so
  every consumer built `HCIKonstanz.Colibri.Samples.*` into the Colibri assembly whether it wanted
  them or not. They now live in `Samples~`, which Unity does not compile, so those types exist only
  after the sample is imported from the Package Manager, and then they are yours, in
  `Assets/Samples/`, in `Assembly-CSharp`. Code that referenced a sample type without importing the
  sample no longer compiles. The `Prefabs` folder is unaffected and stays live: `[RemoteLogger]` and
  `[SyncTransformManager]` are still draggable straight out of `Packages/Colibri/Prefabs`.
- **`LockFreeQueue<T>` is deleted**, with `LockFreeLinkPool<T>`, `SingleLinkNode<T>` and
  `SyncMethods`, all public in `HCIKonstanz.Colibri.Networking`. It is only safe with one thread
  enqueueing, and nothing in Colibri uses it any more. Use
  `System.Collections.Concurrent.ConcurrentQueue<T>`, which is safe with any number of producers
  and consumers.
- **`OpusDecoder.Decode` returns only the samples it decoded**, for every channel, at most 120 ms
  per call. It returned *frameSize* samples of one channel, padded with silence. Code that copies a
  fixed length out of it has to use the length of the array it returns. See
  [Correctness](#correctness).
- **Synced objects send at most 30 updates a second** by default, where 1.3.1 sent one in every
  frame in which something changed. The values in between are skipped, so a `[Sync]` setter on
  another client that counts or reacts to every value now sees gaps. A *Max Send Rate* of `0`
  sends every frame's change as before; see [SyncBehaviour and
  SyncTransform](#syncbehaviour-and-synctransform).
- **'Server supports SSL/TLS?' now switches the TCP connection to TLS too**, not only the Store's
  requests. A server whose web port is behind a TLS proxy but whose TCP port is plain needs TLS on
  the TCP port as well: `TLS_CERT` and `TLS_KEY`, or TLS termination for it in the proxy. See
  [TLS](#tls).

## v3 wire protocol

- New `Assets/Colibri/Networking/Protocol/`: `FrameCodec`, `FrameReader`, `DecodedFrame`,
  `FrameType`, `FrameException`. Pure C# with no `UnityEngine` dependency, so it is directly
  unit-testable, and a mirror of `colibri-server/src/server/modules/networking/protocol.ts`:

  ```
  [u32 LE totalLength][u8 type][body]      totalLength = 1 (type) + body.length
    0x00 heartbeat   [u64 LE pingTimestamp]
    0x01 handshake   utf8 "version::app::name"
    0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
  ```

- Encoding is one pre-sized `byte[]` per frame written with `BinaryPrimitives`, replacing the
  FlatBuffer builder plus a separately-encoded ASCII length header. Egress is bounds-checked with
  the same guards the server uses (channel/command ≤ 64 KiB utf8, whole frame ≤ 5 MiB), so this
  client can never emit a frame the server's own parser would reject.
- `FrameReader` is a growable buffer with read/write cursors: both cursors reset when it is fully
  drained (no copy), and only a trailing partial frame is ever compacted. This replaces
  `HasPacketHeader`/`GetPacketHeader` and their `\0`-scanning, which on an unrecognized byte would
  skip forward looking for the next `\0\0\0` and could resynchronize onto payload data.
- **Heartbeat/latency merge.** The server heartbeats every 100 ms and derives TCP latency purely
  from the client echoing that frame back verbatim. The client now does exactly that: the `u64` goes
  in and comes back out, never interpreted. The old `colibri`/`latency` message echo is removed;
  nothing sends that to a TCP client any more (`MeasureLatency`'s message-level ping is
  Socket.IO-only).
- **Handshake** is sent immediately after connect with `version = "2"`, matching colibri-web's
  `query: { app, version: '2' }`. The server checks it and refuses any other version (see below).
  A device or app name containing the `::` field separator, or starting or ending with `:`, is
  sanitized rather than producing a frame the server drops the connection over.
- `Assets/Colibri/FlatBuffers/` (10 files) and `Networking/Message.cs` are deleted, mirroring the
  server dropping its own `flatbuffers` dependency.

## Protocol version mismatches

- **A refused version is reported instead of retried forever.** The server checks the handshake's
  version field and refuses anything it does not speak, telling the client why on the `colibri`
  channel. `WebServerConnection` intercepts that before the message queue (it is Colibri's own
  plumbing, not an application message), logs both versions, and **stops the reconnect loop**, since
  a mismatch cannot resolve itself. New `ConnectionStatus.ProtocolMismatch` is the terminal state;
  `WebServerConnection.ServerVersion` and `.ProtocolMismatchReason` carry the detail, and
  `Window → Colibri Status` shows it in red rather than the usual (here actively wrong) "check that
  colibri-server is running" advice.
- **The refusal is final for user code too.** `Connected` is cancelled, so `await Connected` throws
  instead of waiting forever. Everything still queued is dropped, and every later send is dropped
  as it is made, with a one-time warning, instead of waiting for a connection that will never come.
  `RemoteLogging` discards its buffered lines. Disabling and re-enabling the component retries.
- `ProtocolMismatchException`, thrown internally to unwind a refused session, and public so a test
  or an application can identify it.
- **A suspected mismatch, for the case the refusal cannot reach.** A server on genuinely different
  framing (a 1.x server) cannot decode this client's frames, and this client cannot decode its, so
  no refusal can arrive. After three sessions in a row that get past the handshake and then end
  before a single frame decodes (a clean close, a reset or an undecodable frame; with TLS on, only
  an undecodable frame), the client logs that this usually means a protocol mismatch, and without
  TLS also names the causes that end connections the same way (TLS on the server only, a proxy or
  port forwarding whose backend is down),
  `WebServerConnection.SuspectedProtocolMismatch` says the same, and `Window → Colibri Status`
  shows it as a yellow warning instead of advising you to check that colibri-server is running,
  which is the wrong advice when something is plainly answering on that port. It stays a
  suspicion: the client keeps retrying, `Status` and `ProtocolMismatchReason` remain reserved for a
  refusal actually received, and the first frame a later session decodes clears it at once. A
  session that never got as far as sending the handshake ("connection refused" from a server that is
  simply not running) does not count, so that is still reported as what it is.
- **Silence is not a suspected mismatch, nor is a close over TLS.** A session on which nothing
  arrives before the 2 s heartbeat watchdog drops it does not count towards the suspicion, since
  neither a 1.x server (it heartbeats from the moment it accepts) nor a server with TLS on (it hangs
  up) stays silent. With TLS on, neither does a session closed or reset without a frame: past a
  completed TLS handshake, a 1.x server behind a TLS-terminating proxy heartbeats, which fails to
  decode, and a 2.x server sends a frame, so what closes it is usually a proxy whose backend is
  down. Three such sessions in a row get a warning of their own instead: something accepts
  connections there and then closes them or forwards nothing (a proxy or port forwarding whose
  backend is down, a captive portal, a firewall), or the server does not answer or is not a
  colibri-server.

## TLS

- **TLS on the TCP connection.** With *Server supports SSL/TLS?* (`ColibriConfig.IsSSL`) ticked,
  the connection to colibri-server is now encrypted too, not only the Store's `https`; the server
  needs `TLS_CERT` and `TLS_KEY`. The frames inside are the same v3 frames. The handshake has to
  finish within the 5 s connect timeout, the client sends the server address as SNI and checks the
  certificate against it, and Unity's TLS backend uses TLS 1.2. See [TLS](https://colibri.hci.uni-konstanz.de/unity/configuration#tls) in
  the guide.
- **`ColibriConfig.AllowSelfSignedCertificate`** (*Allow self-signed certificate*) **and
  `ColibriConfig.ServerCertificateSha256`** (*Server certificate SHA-256*, which pins one
  certificate by its fingerprint), shown in the Setup window when TLS is on. By default only
  certificates the device trusts are accepted, and existing configuration assets load with both
  off. A fingerprint that is not 64 hexadecimal digits is an error in the window, and is neither
  saved nor used. The window's label column is as wide as these two labels, which Unity's default
  of 150 px cut off.
- **The Store's `https` requests honour the same two settings**, so a server with a self-signed
  certificate works for the Store as well as for the TCP connection.
- **Clear TLS errors**, each logged as an error once and then retried with backoff. A server that
  does not answer the TLS handshake gets a message naming both fixes. A rejected certificate gets
  its reason (self-signed, expired, not issued for the address, another fingerprint) and the
  fingerprint to pin. A certificate accepted only because self-signed ones are allowed is a warning,
  once per session.
- **The Status window shows TLS** next to the server address, how the certificate was accepted,
  and its SHA-256 fingerprint, selectable for copying. Those two wrap to the window's width rather
  than run past its edge.
- For a client without TLS, the suspected-protocol-mismatch error also suggests ticking 'Server
  supports SSL/TLS', since a server with TLS on hangs up on such a client before a frame.

## Correctness

- **The socket no longer waits for the frame.** `RunConnectionLoop` is started from `OnEnable`, so
  its first `await` captured Unity's `SynchronizationContext`, and with no `ConfigureAwait(false)`
  anywhere in the file, so did every continuation after it. Connect, receive, heartbeat echo and
  send were all posted back to the main thread and pumped once per frame: inbound bytes sat in the
  kernel buffer until the next frame, echoing a heartbeat cost two further frame-pumps *inside* the
  receive loop, and `StampLiveness` (the watchdog's proof of life) only ran when the main thread
  ran. Two editors side by side on one machine showed it plainly: Unity throttles whichever one is
  in the background, so a cube moved in the focused editor arrived in the other visibly late and its
  Status window reported missed heartbeats, all of it over localhost. Every await on the connection
  path now carries `ConfigureAwait(false)`. The `volatile` fields, `Interlocked`, `LockFreeQueue`
  and `_msgQueueLock` this file already had were written for exactly this threading; the missing
  `ConfigureAwait` had quietly been preventing it. (The receive queue has since become a
  `ConcurrentQueue`, and `_msgQueue` the outbox described below.) `_socket`, `_status` and the
  connected gate join them, and the `Status` setter (a read-modify-write over four fields now
  genuinely reachable from the connection loop and `Update`'s watchdog at once) is serialized. The
  main-thread handoff user code depends on is unchanged: received messages still arrive via
  `_queuedCommands` and are delivered from `Update`.
- **"Recent messages" stops counting up forever.** The Status window's traffic log was a static
  buffer with no expiry and no reset, timestamped with `realtimeSinceStartup`, a clock that keeps
  running after Play stops. Entries therefore aged indefinitely on screen, and with domain reload
  disabled the next session opened showing the last one's messages, dated from before it started.
  The log is cleared at `SubsystemRegistration`, entries older than ten seconds are dropped, and the
  window shows "(nothing sent or received yet)" outside Play mode.
- **The second Play session connects again.** With *Enter Play Mode Options* enabled and domain
  reload disabled (which this release recommends, so it is the configuration most projects run),
  ending a Play session destroyed the connection's GameObject but left `SingletonBehaviour<T>`'s
  "already created one" flag latched in a static that the session did not reset. Every later press
  of Play was handed back the *destroyed* connection: no object in the scene, no `Update`, no
  socket, and, because reading a destroyed reference throws nothing, not one line in the console to
  say so. The Colibri Status window's "No Colibri connection in the scene yet" was the only visible
  symptom, and it reads like an explanation rather than a fault. Liveness is now decided by the
  instance itself rather than by a flag, so a destroyed one is replaced; creation is still
  suppressed while the application is quitting, so nothing is resurrected during teardown. Affects
  `WebServerConnection` and `VoiceServerConnection` alike.
- **String payloads now round-trip.** `SendCommandAsync` used to special-case `JTokenType.String`
  and write the string *unquoted*, which is not valid JSON. Against a 2.0 server that reaches web
  clients via `Payload.asValue()`, which threw and fell back to `asString()`, so a Unity
  `Sync.Send(channel, "hello")` and a web client's version of the same message did not arrive
  identically. Payloads now always go out as `ToString(Formatting.None)` and are always parsed back
  with `JToken.Parse`, falling back to a raw `JValue` for a non-JSON body. The `log` channel is the
  documented exception: it keeps sending raw text, because `ClientLogger` reads it with
  `asString()` and quoting would put stray quotes in the admin UI.
- **Interleaved sends.** Concurrent `SendCommandAsync` calls could interleave their bytes on the
  socket and corrupt the framing for everything that followed. All writes are serialized behind a
  `SemaphoreSlim(1, 1)`, and a partial send is now completed instead of silently truncating the
  frame.
- **Send that hung forever.** `_socket.SendAsync(SocketAsyncEventArgs)` returning `false` (completed
  synchronously) never raises `Completed`, so `await signal.WaitAsync()` never returned. Replaced
  with `Socket.SendAsync(ArraySegment<byte>, SocketFlags)`, which also drops a
  `SocketAsyncEventArgs` + `SemaphoreSlim` allocation per send.
- **Messages sent during an outage.** `_msgQueue` was written from the send path and drained from
  the connect path with no synchronization. Every message now goes through one outbox: a FIFO
  written to the socket by a single drainer, so messages leave in the order they were sent, across
  an outage too, and ahead of anything sent after reconnecting. A write that fails stays at the head
  of the queue for the next session. While disconnected it holds at most 256 broadcasts and other
  messages that are not about synced objects, dropping the oldest with one warning per outage: for a
  last-write-wins sync client, an unbounded backlog only preserves updates that are already
  superseded. Log lines wait in `RemoteLogging` instead, which keeps the newest 1000 while
  disconnected (see [Dependencies](#dependencies-and-api-modernization)); only lines already handed
  over when the connection dropped count towards the 256. Model messages are not dropped by that
  bound, because nothing would repair the loss. `model::request` and `model::delete` wait as they
  are, and the `model::update`s for one object during one outage are folded into one, newer fields
  winning, but never past another message about that object, so an older value cannot overtake a
  newer one. Behind both sits a hard cap of 10 000 messages on the whole outbox, during an outage
  and while connected over a link that cannot keep up, since requests, deletes and updates that
  cannot be folded otherwise queued without limit. Past it the oldest broadcasts and log lines go
  first and then the oldest model messages, never the one being written, with one warning per
  connection.
- **`SendCommandAsync` says what happened.** It completes `true` once the message is written to the
  socket, stays pending while disconnected, and completes `false` only when the message will never
  be sent: it could not be encoded, a bound on the queue dropped it, the server refused this client,
  or the component was destroyed. It never returns `false` for a message it is still going to send.
- **Receive loop that died silently.** The `BeginReceive`/`AsyncCallback` machinery ended in
  `catch (Exception) { /* ignore */ }`, so any hiccup killed reception permanently while the client
  still looked connected. Replaced with an `await socket.ReceiveAsync(...)` loop feeding
  `FrameReader`, which logs and reconnects.
- **Static connection state.** `_socket`, `_receiveBuffer`, `_expectedPacketSize` and friends were
  `static`, which breaks under Enter Play Mode Options with domain reload disabled. All instance
  fields now.
- **Reconnect.** A single connection task with exponential backoff (0.5 s → 10 s), cancelled by a
  `CancellationTokenSource` in `OnDisable`, replaces `Update()` re-entering `Connect()` every frame
  while disconnected.
- **A connection attempt nothing answers is given up after 5 s.** The socket has no connect timeout
  of its own, so an address nothing answered on (a mistyped IP, a server on another subnet) held the
  attempt in `Connecting` until the operating system gave up, about two minutes on Android, with no
  retry and nothing in the log to say why (in 1.3.1 too). The attempt is now abandoned after 5 s and
  retried with the usual backoff, and the console says `<host>:<port> did not answer within 5 s.
  Check the server address, and that this device is on the same network as the server.
  Retrying...`. A refusal is still reported at once, as `connection to <host> failed
  (ConnectionRefused)`, also when another of the server name's addresses did not answer. New
  `WebServerConnection.LastConnectFailure` says why the last attempt failed (the timeout, a refusal
  or another socket error) and is `null` once a connection has opened; *Window → Colibri Status*
  shows it under *Not connected* as *Last attempt: …*. None of these counts towards a suspected
  protocol mismatch, since nothing was ever accepted.
- **Servers reached over IPv6.** The TCP socket was IPv4 and connected by name, so a server name
  with only IPv6 addresses (AAAA records), such as a server whose IPv4 address is behind
  carrier-grade NAT, or an IPv6 address could not be reached at all (in 1.3.1 too). The name is now
  looked up at every attempt, within the 5 s connect timeout, and its IPv4 addresses are tried
  first, then its IPv6 addresses, each in the order the device's resolver returns them, with a
  socket of its own family. IPv4 first because voice goes to IPv4 too when the name has an IPv4
  address, and the server relays voice only from the TCP connection's address. A name with only
  IPv6 addresses connects over IPv6, and voice follows. If the IPv4 address does not answer while
  the IPv6 address does, TCP falls back to IPv6 and voice, still on IPv4, is dropped. A refused or
  unreachable address is followed by the next at once, and moving on is logged. One without an
  answer is given up after its share of the time left (at least 1 s, 0.25 s for a loopback address
  followed by others: Windows takes a second or more to report a refusal, e.g. on `127.0.0.1` from
  a server on `::1` only). An address the device has no route to, such as IPv6 on Wi-Fi without
  IPv6, fails at once and takes no share from the addresses before it. When every address fails,
  a refusal is reported over no answer, and no answer over anything else, such as an unreachable
  IPv6 address: `localhost` with no server running reports the refusal from `::1` on Windows, not
  the 0.25 s on `127.0.0.1`. With a host name, the `connected to` line names the address used. An
  IPv6 address may be written with or without brackets, and `Store` URLs put it in brackets. TLS
  still checks the certificate against the server address as entered.
- **Disabling and enabling the connection in one frame** no longer takes 5 s on Mono or leaves sends stuck.
- **Connected means the server has spoken.** A session becomes `Connected` on the first frame the
  server sends, not when the TCP connection opens. Only then is the backoff reset, `OnConnected`
  raised and the queued messages sent, so against something that accepts connections and then
  fails (a 1.x server, a port that is not Colibri), the backoff grows instead of staying at 0.5 s.
  The 2 s heartbeat watchdog covers the time before that first frame too: a server that accepts the
  connection and never says anything is dropped.
- **`OnConnected` and `OnDisconnected` come in pairs.** `OnDisconnected` is raised exactly once for
  every `OnConnected`, when that connection ends, a refusal included, and never for an attempt
  that did not connect. A refusal in the very first frame raises neither. Each handler runs on its
  own, so one that throws is logged and no longer skips the others or the rest of `Update`. The
  two are also raised in the order the transitions happened. They used to be two flags, raised
  connected-first (in 1.3.1 too), so a connection that dropped and came back before the next frame
  raised `OnConnected` and then `OnDisconnected`, and left code that follows them believing it was
  offline while it was connected.
- **Models are requested again after a reconnect.** `model::request` was sent once, when a model
  listener registered, so after a Wi-Fi blip a client kept showing old state until each object
  happened to change again. On every reconnect `Sync` now repeats the requests for every model
  channel it listens on (by id for each `SyncBehaviour`, for the whole channel for a
  `SyncBehaviourManager`) behind the messages queued during the outage, so the server answers with
  this client's own offline changes already applied. The manager updates the objects it already
  has rather than spawning duplicates. A request sent again for an object carries `"again": true`,
  so the server can tell an object this client held before the outage from one being created now,
  and answers `model::delete` for one another client deleted meanwhile (model tombstones, see the
  server's [protocol docs](../../../colibri-server/docs/dev/protocol.md#deleted-models)).
- **A change made as the Wi-Fi drops is no longer undone after the reconnect.** It went into a
  connection that was already dead, which the client noticed only 2 s later. The server's answer
  then held the old value, and applying it put the object back on the client that had changed it,
  while every other client kept the old value until the member changed again. Each `[Sync]` member
  now remembers the values it sent around the time the client last heard from the server: the
  latest 8 up to then, the first 8 after it, and the newest, so an object moved through the drop is
  covered however many moves were lost. Those stay as they are until the answers are in, even if the
  object moves on as soon as the connection is back. It also remembers the value it held before
  those: the last one dropped, or the one the server last showed it. If what arrives after the
  reconnect holds a value the member held from 10 s before the outage was noticed, other than the
  one it sent last, the member keeps its value and sends it again, once, as an ordinary update. That
  includes the value it held at that point, so an object switched off at the drop after a minute
  switched on stays off. The value sent last means nothing to do, and any other value is another
  client's change during the outage, which is applied, unless the member changed after the requests
  went out: the server reads that change after all of the answers, so the member keeps its value and
  sends it again. If the connection drops again before the answers are in, the next reconnect still
  counts from the first outage, and a value sent again and lost in that second drop is recognised by
  the answer's value. After every reconnect, `Sync` sends one more `model::request` after the
  others, on the channel `colibri::reconnect`, whose answer tells when the answers are over; the
  server needs no change. Objects that never sent anything are not affected. See
  [Connection and outages](https://colibri.hci.uni-konstanz.de/unity/messages#connection-and-outages).
- **An object destroyed as the Wi-Fi drops is now deleted for everyone after the reconnect.** Its
  `model::delete` went into the dead connection, and nothing sent it again, so the server and every
  other client kept the object. When the outage is noticed, the deletes made since the client last
  heard from the server, or in the second before, now go out again on the next connection, ahead of
  the requests made again, unless 60 s old or more. If the connection drops again before the answers
  to those are in, they go out once more, however old, with the deletes made since the outage was
  noticed. When the server was last heard from is taken from the system clock that times the
  heartbeats, but kept between the frame that sees it and the one before, on Unity's clock: the
  system clock may be set, or run on while a headset sleeps, and a frame may take seconds.
- **A large message on a slow link no longer gets a healthy connection dropped.** The heartbeat
  echo waited for the socket while a long write held it, so the receive loop stopped and the 2 s
  heartbeat watchdog dropped the connection, again and again, since the message stayed first in
  line for the next session. The echo no longer waits for the socket, so the message goes out
  instead of being retried forever.
- **Strings that look like timestamps arrive exactly as sent.** `"2026-10-08T12:00:00Z"` was turned
  into a date on the way in, and came out reformatted or moved into the device's time zone (in
  1.3.1 too). `ColibriJson.CreateSettings`, and with it the `Store`, keeps them as strings as well.
- **Received messages no longer queue without limit while `Update` does not run** (the app paused,
  the Editor in the background). Past 1000 waiting messages, an object's model updates are folded
  into its newest state, and past 10 000 the oldest broadcasts are dropped first, with one warning
  (in 1.3.1 the queue had no bound either).
- **One bad message no longer takes the rest of the frame with it.** A payload that cannot be read
  as the type its command names (a malformed `bool`, `int`, `float` or `string`, or an array command
  whose payload is not a JSON array) is reported once, naming the channel, the command and the
  payload, and is not delivered. A listener or `OnMessageReceived` handler that throws is logged,
  and the other listeners and the messages queued behind it are still delivered. Both used to throw
  out of `WebServerConnection.Update`.
- **A receive-only client keeps working in the next Play session.** With domain reload disabled, a
  channel registered in an earlier Play session kept its entry in `Sync` after its listeners'
  objects were gone, and registering on it again never asked for the connection, so a client that
  only listened had none. Every registration now does.
- **A colon at either end of the App Name.** It merged with the handshake's `::` separator, so app
  `app:` silently joined app `app` with the colon moved onto the client name. Such a colon is now
  replaced with `_`, with a warning for the App Name, and `FrameCodec` rejects such handshake
  fields. The voice app id is the hash of the name the handshake sends: it was the hash of the App
  Name as configured, so the server, which relays voice only from a Unity client of the packet's
  app, dropped all voice of such an App Name.
- **Main-thread config reads.** `ColibriConfig.Load()` goes through `Resources.Load`; the connection
  path used to call it from a worker thread. It is now snapshotted on the main thread.
- **Voice chat.** `udpThread.Abort()` (unsupported on .NET Core / IL2CPP) is replaced with a
  `CancellationToken` plus `udpClient.Close()`, which is what actually unblocks the blocking
  `Receive()`. `OnDisable` no longer NREs when `Connect()` bailed out. The receive socket binds to
  port **0** instead of the hardcoded 9014: the server replies to the datagram's source port
  (`voice-server.ts`), so the fixed port bought nothing and capped a machine at one Unity client.
  Voice now goes to an IPv4 address of the server when it has one, since the server's voice socket
  is IPv4 by default: on Windows `localhost` resolved to `::1` first and every send failed. A server
  address with only IPv6 addresses gets voice over IPv6, from an IPv6 socket, if the device has an
  IPv6 route to it, and the log says once that the server needs `VOICE_HOST=::` for it. An IP
  address is no longer reverse-resolved (`Dns.GetHostEntry` threw for a LAN address without a DNS
  name), and an address that cannot be resolved, or has no address voice can be sent to (an IPv6
  address without a route included, as on Wi-Fi with IPv4 only), turns voice off with a clear error
  instead of throwing from `OnEnable`. A send the device refuses, e.g. after a network change, drops
  the packet with one warning until a send works again. It used to throw out of `VoiceBroadcast`
  on every frame, before the frame was taken off the recording buffer, which grew without end.
  Received packets now reach the main thread through a per-instance `ConcurrentQueue`. They went
  through a static `LockFreeQueue`, which is only safe with one thread
  enqueueing (and after a quick disable and enable the old receive thread may still be handing over
  a packet while the new one starts), and which, being static, could hand one connection's packets
  to the next. `VoicePacketCodec` encodes and decodes the packets, and a received one is played only
  if it carries this client's app id. A datagram shorter than the header used to throw on the
  receive thread and log the exception, once per datagram; it is dropped now. Without an App Name
  no voice is sent, and an error says so once: the TCP connection does not connect without one,
  but voice went out regardless.
- **Voice frames.** `VoiceBroadcast` froze the app when Opus failed to encode a frame: the send loop
  kept the frame and tried it again, forever. Opus failed on every frame from a 44.1 kHz
  microphone, as frames were cut at the microphone's rate and resampled one by one to 958 samples,
  which is no Opus frame size. On macOS and iOS, where the Opus functions are stubs, it failed on
  every frame too, and a *Frame Size Milliseconds* of 0 froze the app even with PCM. The recorded
  audio is now resampled to the *Voice Sampling Rate* as one stream and cut there, into frames of
  exactly *Frame Size Milliseconds* (960 samples for 20 ms at 48 kHz). Each frame is sent once; one
  that Opus fails on goes out as PCM, with one warning per broadcast. Opus is used only at 8, 12,
  16, 24 or 48 kHz with frames of 5, 10, 20, 40 or 60 ms, and only where its library loads;
  otherwise `VoiceBroadcast` warns once and sends PCM. In the macOS Editor with Android as the
  build target, it threw `DllNotFoundException` and never started. `Resampler`, which
  `VoiceReceiver` uses too, no longer drifts: it rounded each chunk's output up and kept a float
  position, which at 44.1 to 48 kHz ran a sixth of a sample further ahead every 20 ms. A
  microphone that reports 0 to 0 Hz, which means any rate, records at the *Voice Sampling Rate*
  instead of at 0 Hz.
- **Voice playback.** `VoiceReceiver` decoded Opus only with its own *Use Opus Codec* on, and played
  Opus packets as PCM otherwise, which is noise. It now decodes each packet by its codec, and its
  *Use Opus Codec* has no effect. Where Opus does not run, it logged two errors per Opus packet on
  macOS and iOS, and in the macOS Editor with Android as the build target it threw
  `DllNotFoundException` in `Start`, then a `NullReferenceException` for every Opus packet and on
  quit. It now drops the Opus packets it cannot decode, with one warning per receiver, and still
  plays PCM. A voice listener that throws is logged and no longer drops the other packets delivered
  in that frame. A receiver destroyed without `StopPlayback`, as the VoiceChat sample does, stops
  receiving and frees its Opus decoder; its buffer used to grow with every packet. A packet that
  arrives before the receiver's `Start` is dropped; with an output rate other than 48 kHz it threw.
  The playback buffer was a List that the main thread and the audio thread changed unguarded, which
  now and then threw; it is a lock-free ring now, and the audio thread no longer allocates. The
  buffer held stereo samples whatever the output's channel count, which played voice wrong on a
  mono or surround output; each sample now goes to every channel. An exception on the audio thread
  plays silence and is logged once per receiver.
  Fast-forward threw on a frame longer than its latency, and at 48 kHz acted at half the *Fast
  Forward Latency Milliseconds* set; the latency now counts at the output rate. `StartPlayback`
  twice with one voice id played every packet twice. The second call now only restarts the
  `AudioSource` if Unity stopped it, as it does when the GameObject is deactivated. Another id
  replaces the one playing, and `StopPlayback` when nothing plays does nothing.
  `OpusDecoder.Decode` returns only the samples it decoded, for every channel, at most 120 ms per
  call. It returned *frameSize* samples of one channel, padded with silence, and a stereo decoder
  wrote past that buffer. A decoder that was not created or is destroyed logs an error and returns
  null instead of calling Opus, and a second `Destroy` does nothing; it freed the decoder twice.
  `OpusEncoder` does the same: `Encode` on an encoder that was not created or is destroyed logs an
  error and returns null, and a second `Destroy` does nothing.
- **`Store`** serializes with Newtonsoft instead of `JsonUtility`, which cannot handle dictionaries,
  properties, or top-level arrays and so silently disagreed with what `Sync` can carry. What that
  costs a 1.x project is under Breaking changes. A value that cannot be converted, or a saved
  value that does not fit the type asked for, makes `Put` return `false` and `Get` return
  `default`, with the reason in the console.
- **`Store` escapes the app name and the key in its URLs** the way colibri-web does
  (`encodeURIComponent`), so keys with `/`, `#`, `?`, `%` or spaces address the same entries from
  Unity and the web client.
- **`Store` sends the REST store's media type**, `application/vnd.colibri.v2+json`: as `Accept` on
  every request, and as the `Content-Type` of `Put`. colibri-server 2.0 takes and answers only
  this type, and refuses a value sent as `application/json` with 415. `Delete` sent a
  `Content-Type` without a body and now sends only `Accept`.

## SyncBehaviour and SyncTransform

- **A send-rate limit, per object.** A headset renders 72 to 120 frames a second, and every moving
  synced object sent an update in each of them: dozens of headsets, each moving a few objects,
  produced more traffic than one server and one Wi-Fi network can keep up with. Each object now
  sends at most `SyncSettings.MaxSendRate` updates a second, 30 unless configured otherwise, without
  losing what a last-write-wins client needs. A change after a quiet spell goes out in the same
  frame. Changes within the next interval are merged, and their latest values go out as soon as it
  is up, even if nothing changes afterwards, because `SyncTicker` flushes every object in every
  frame. The next slot is counted from the previous one rather than from the frame that sent, so
  72 fps still gives 30 updates a second, not 24. Switching an object off or on skips the limit and
  sends what is waiting at once, and destroying it still sends `model::delete` at once, dropping
  what was held. The setting is `ColibriConfig.MaxSendRate`, shown as *Max Send Rate (Hz)* under
  *Optional Config* in *Window → Colibri Configuration*, which warns when it is `0` (no limit) and
  refuses a negative value; a configuration saved before the field existed gets 30 without being
  saved again. `SyncSettings.MaxSendRate` changes it while the app runs, for that run only, and
  throws on a negative value.
- **What the limit holds is sent when the app stops.** `SyncTicker` sends everything waiting, past
  the limit, when the app pauses or loses focus (on Android and so on Quest the usual way out, where
  Unity may never call `OnApplicationQuit`) and from `OnApplicationQuit`. It polls every object
  first, so a change made late in the last frame is included. The send on quit or at the end of Play
  mode is best effort: the connection closes its socket in the same teardown. Losing focus while the
  app goes on running, as with a Quest's system menu, skips the limit once.
- **A value from another client replaces a local change still waiting.** A member applied from the
  server is removed from this object's update that has not gone out yet: one polled earlier in the
  frame, or held by the limit. Sent afterwards, the older local value overwrote the newer one on the
  server and on every other client while this client showed the server's, and the copies disagreed
  for good.
- **A deleted object stays deleted.** A delete from another client now drops what this client's copy
  holds and takes it off the ticker at once, rather than at its `OnDestroy` a moment later. An
  update it sent in between reached the server after the delete, and since the server creates a
  model on its first update, the object came back, on every other client too, with nobody left to
  delete it.
- **An object built from another client's update does not undo a delete.** An object a
  `SyncBehaviourManager` builds from a remote `model::update` sends no `model::request { id }` when
  it registers. That request told the server the object was being created here, which lifted its
  tombstone of a model deleted meanwhile, and the deleted object came back on every client. The
  object is still asked for again after a reconnect.
- **A client that deletes an object does not build it again** from an update another client sent
  before the server had the delete. The deletes this client sends are remembered for 60 seconds,
  and creating an object with that id on this client ends that at once.
- **A manager also finds the objects a script switched off before its `Start` ran** (1.3.1 missed
  them too). They now send their state, and are not built a second time when the server already
  holds them.
- **Showing and hiding.** Deactivating a `SyncTransform`'s GameObject hides its copies on the other
  clients, and reactivating it shows them again, as in 1.3.1: its `Active` member reads
  `activeSelf`, and the poll keeps running while the object is inactive, since being inactive is
  the state to sync. Received values are applied through `SetActive` and not echoed back.
  Disabling only the component (`enabled = false`) pauses its syncing, and deactivating a parent
  changes nothing elsewhere.
- **Leaving Play mode or quitting deletes nothing.** `OnDestroy` sends `model::delete` unless the
  application is quitting, and it learned that only from `OnApplicationQuit`, which Unity does not
  send to inactive GameObjects. So an object that was hidden, by this client or by another one,
  when Play mode ended or the app quit was deleted on the server, and with it every other client's
  copy (in 1.3.1 too). `OnDestroy` now also checks `Application.quitting`, which Unity raises
  whatever the object's state. Destroying an object and unloading its scene still delete it for
  everyone.
- **A value from another client no longer swallows the next local change.** Echo suppression was a
  per-member "skip the next change" flag (in 1.3.1 too). It went stale whenever the poll saw no
  change afterwards (two updates between polls that ended where they started, or any update while
  the component was disabled) and then silently dropped the next genuine local change. Received
  values are now latched as the known state instead, and `TriggerSync` sends the full state in one
  message.
- **A change made before the server's state arrives is no longer undone.** An object asks the
  server for its state when it registers, in `Awake`, and the answer arrives a round trip later, or
  once the connection is up. A member changed in between, in `Start`, in an `OnConnected` handler or
  right after entering Play mode, was latched without being sent, and the answer then put the
  server's value over it: the change was undone on this client and never reached another (in 1.3.1
  too). The answer now compares each member with the value it had when the object registered. A
  member that differs keeps its value and goes out as an ordinary update; every other member takes
  the server's value, so values from the scene or the prefab do not go out over it, as long as each
  `[Sync]` getter can read its value in `base.Awake()`: a model's own setup, such as a cached
  component, goes before that call (the guide's example and the SyncBehaviour sample now do so, and
  the sample applies its Inspector color only once it is edited). The answer to a
  manager's request for its whole channel, and an update another client sent before the server read
  the change, hold the older value too: `Sync` sends one more `model::request` on
  `colibri::reconnect` ahead of the change, and until its answer the member takes nothing from them.
  In the round after a reconnect, the member is kept until that round ends instead. An object a
  manager builds from another client's update takes that update as it is. A placed `SyncTransform`
  with a `Rigidbody` stays kinematic until its first answer, whatever `PhysicsAuthority` says, so
  that a client that joins later does not send where its own simulation took the object meanwhile
  as a change of its own. One instantiated with an empty `Id` is simulated at once. Without a
  connection for 5 s (the connect timeout), the object stops waiting as soon as no connect attempt
  is under way, and a warning says so once per session; when a server answers later, the position
  it reached replaces the shared one. See [SyncTransform](https://colibri.hci.uni-konstanz.de/unity/synctransform).
- **Objects built from a disabled `Template` come to life.** A copy starts out as its template is,
  and a manager's template is often kept switched off in the scene. A copy that is switched off
  never runs `Awake`, so it never registered for its own updates or with the ticker: it stayed as
  its first update left it, never sent a change, and a `SyncTransform` hidden elsewhere could never
  be shown again (in 1.3.1 too). The manager now switches the copy on before applying the state,
  so `Awake` runs, and the state decides whether it stays visible. The member table is also built
  when the first update arrives, not only in `Awake`, so an update that reaches a model before any
  object of its type has woken is applied instead of being dropped with `Unable to sync attribute`.
- **A manager without a `Template` no longer warns at every Play.** A manager without one is how
  objects placed in the scene are synced (the `SyncTransform` sample has one), yet `Start` warned
  regardless, with a gap in the message where a model ID would have gone. It now warns once, naming
  the model, when a model arrives that is not in the scene and that it has no template to build.
- **Wire names are lowercased the same way on every machine.** Model channels and `[Sync]` member
  names used `ToLower()`, which on Turkish and Azerbaijani systems turns `I` into a dotless `ı`:
  `PhysicsId` went out under a name no other client uses, and stopped syncing. They now use
  `ToLowerInvariant()`, matching colibri-web.
- A dead prefab check in `SyncBehaviour.Awake` that compared a struct with `null` (compiler warning
  CS0472) is gone; behaviour is unchanged.

## Meta Quest and Android

- **The package compiles for Android on Unity 2022.3.** `VoiceBroadcast` subscribed to
  `PermissionCallbacks.PermissionRequestDismissed`, which only exists from Unity 2023.1 on, so every
  2022.3 project with the Android target active failed to compile (1.3.1 included). The
  subscription is now limited to 2023.1 and newer; a refused microphone permission is still logged
  on 2022.3.
- **Build settings check.** Colibri warns about two player settings that break a build without a
  word, and *Window → Colibri Configuration* offers a one-click fix for each: *Internet Access* left
  at *Auto* (Android only), which may leave the INTERNET permission out of the build, and *Allow
  downloads over HTTP* blocking plain HTTP to a server that is not `localhost` while SSL is off,
  which fails every `Store` call in the built app on every player platform, Windows and Linux
  players included. The warnings appear at the first editor update after a domain reload, so also
  while the editor is in the background (Unity holds `EditorApplication.delayCall` until the editor
  has focus), and an `IPreprocessBuildWithReport` logs them again at the start of every build.
  Neither stops a build. The Setup window's body now scrolls.
- **No expression trees on IL2CPP.** The `[Sync]` accessors were built with
  `Expression.Compile()` (in 1.3.1 too), which IL2CPP does not compile but interprets: slowly, and
  for value types through generic code IL2CPP may not have generated. Under `ENABLE_IL2CPP` a
  property now gets open-instance delegates bound to its get and set methods, which allocate
  nothing, and a field goes through `FieldInfo.GetValue`/`SetValue`, which boxes a value type on
  every poll. Mono (the Editor and Mono players) keeps the compiled expressions. An accessor that
  cannot be built is reported per member instead of escaping from `Awake`.
- **`[Sync]` members survive managed code stripping.** Nothing references them except through
  reflection, which is exactly what stripping removes above the *Minimal* level. `SyncAttribute`
  derives from `UnityEngine.Scripting.PreserveAttribute`, which keeps the members (on a property,
  its getter and setter too), and carries `[RequireAttributeUsages]`: the linker treats Preserve
  attributes as its own markers and leaves them out of what it writes, so from *Medium* up the
  members survived without their `[Sync]` and nothing synced. Checked in stripped IL2CPP players at
  Low, Medium and High.

## Getting started

Many Colibri users know some C# and little Unity. Every silent failure costs them time they would
otherwise spend on their prototype, so:

- **Installing is one git URL.** No UniRx, no R3, no UniTask, no NuGetForUnity: the only dependency
  is `com.unity.nuget.newtonsoft-json`, resolved automatically from `package.json`.
- **`Sync.Receive<float>("ch", MyHandler)`.** `Receive` is overloaded once per supported type,
  which made `Sync.Receive("ch", MyHandler)` ambiguous and forced a cast onto every call site. The
  generic version dispatches by pattern-matching the delegate (no reflection), and the existing
  overloads still work. Same for `Unregister<T>`. There is deliberately no `Send<T>`:
  `Sync.Send("ch", value)` already resolves, and a generic version would demote today's compile
  error on an unsupported type to a runtime message.
- **Listeners clean themselves up.** `Sync.Receive` had to be paired with a `Sync.Unregister` in
  `OnDestroy`, and forgetting it was the most expensive mistake in the API: the delegate keeps
  calling into a destroyed `MonoBehaviour`, the first line touching `transform` throws
  `MissingReferenceException`, and that exception surfaces out of `WebServerConnection.Update`,
  discarding every message still queued behind it that frame. Colibri now records which Unity object
  each listener belongs to and drops the listener once that object is destroyed. It works for a
  method group (the delegate's target *is* the component) and for a lambda written inside one (the
  component is a field of the compiler-generated closure), resolved once at registration, never per
  message. `Unregister` is unchanged and still needed to stop listening while the object lives on,
  or for a `static` listener, which has no Unity lifetime to follow.
- **Type mismatches are reported.** Colibri routes on (channel, type), so a `float` sent to a
  `string` listener used to be dropped without a word (`Sync.cs`, the missing-listener branch). The
  new `ChannelListenerRegistry` tracks which types each channel has listeners for, and the warning
  names the channel, both types, and the fix. It stays quiet for a channel with *no* listeners,
  which is normal traffic, and reports each `(channel, type)` mistake once rather than per message.
- **A missing configuration says so.** `ColibriConfig.Load()` returned `null` without
  `Resources/ColibriConfig.asset`, so `GetWebUrl` threw an NRE and the connection loop polled
  forever in silence. It now returns the defaults and reports the missing config once, pointing at
  the menu item that fixes it. The "connected" log names the host, port and **app name**, because a
  typo there produces a healthy connection on which no other client is ever seen.
- **The setup window warns about an App Name others use too**: `myAppName`, which the web client's
  samples use, and names such as `test`, `demo`, `app` or `colibri`, ignoring case and surrounding
  spaces. Everyone on a server with the same App Name is in one app, so projects that keep such a
  name see each other's objects and messages, and since every update goes to every other client
  in the app, the server's work grows with the square of the number of clients in it. The Unity
  client does not say so at runtime; colibri-server's log does, naming the app, once it has more
  than 8 clients (by default; `APP_CLIENT_WARNING_THRESHOLD`), except for `colibri`, the admin UI's
  own app. The window also no longer accepts an App Name of only spaces, and its title no longer
  forces a horizontal scrollbar.
- **The setup window applies only what it would save.** It wrote every field straight into the
  configuration, and *Save Config* only saved it. So a value the window marked as an error, such
  as port 0 or a malformed *Server certificate SHA-256*, was used in Play mode all the same, though
  *Save Config* was disabled, and written to disk by the next save of the project's assets. The
  fields now edit a copy: a valid change still takes effect at once, without saving, even while
  another setting shows an error. A value with an error stays in the window, entering Play mode
  included, until it is corrected or the window closes, and its setting keeps its last valid
  value. Changes made elsewhere, such as in the asset's Inspector, still show in the window and
  are kept.
- **`Window → Colibri Status`**: connection state, server, app name, protocol version, time since
  the last server heartbeat (not a latency: the heartbeat carries the *server's* clock), the
  channels with listeners and the type each expects, and the last 20 messages in and out. It uses
  `FindAnyObjectByType`, never `WebServerConnection.Instance`, which *creates* a GameObject. Long
  values wrap to the window's width, and the label column of the channel and message lists widens
  to fit the longest channel name, so nothing is cut off at the window's default width.
- **Status reports the delivery rate, not just the connection.** With the socket off the main
  thread, what is left between a message arriving and user code seeing it is one frame of *this*
  client's. So the window states it: the rate `Update` is running at, the delay that implies per
  message, and below 20 fps a warning naming the usual cause: an Editor in the background, which
  Unity throttles. Without it, a client delivering at 4 fps is indistinguishable from a slow server,
  and the search goes looking on the wrong side of the wire.
- **A `Network Stress` sample, for the question the Status window cannot answer.** Status says
  whether messages are flowing; it says nothing about how many this scene can carry before it stops
  keeping up. The sample spawns up to 500 synchronized objects, moves as many of them per frame as
  you ask it to, and reports throughput, round-trip latency percentiles, dropped messages, frame
  cost and reconnects, on screen, live, with sliders. Run it in two editors side by side and turn
  the count up until the numbers stop being acceptable. Until a probe comes back, the panel says to
  start a second client with the scene.

  It carries two separate instruments on purpose. The **load** is synchronized objects, which is how
  a real scene generates traffic, but state sync is last-write-wins and coalesces per frame, so a
  value that never went out is the design working and cannot be counted as loss. The panel calls
  that figure *coalesced*, not *lost*. With the send-rate limit an object's changes are coalesced
  per interval too, so *Coalesced* rises by design. The panel shows the changes the sample drives
  as *Changed* and the most messages they can become as *Sent*; set *Max Send Rate* to `0` to
  measure the raw per-frame load. **Latency and loss** ride on a separate low-rate probe
  channel where every message is meant to arrive exactly once, measured as a round trip so no clock
  is shared between the two ends. That channel is the only thing here that can honestly report a
  dropped message, and it is what makes the server's own limits visible from inside Unity: the
  server drops broadcasts from a client over `CLIENT_MESSAGE_RATE_LIMIT` (1000 a second by default)
  or while it is `TCP_INBOUND_BACKLOG_LIMIT` messages behind, and writes to a client whose socket
  falls more than 1 MB behind, without telling the client. The scene's defaults, 100 moving objects
  at the default *Max Send Rate* of 30, come to about 3000 updates a second, three times the rate
  limit, so at those settings the server drops nearly every probe; with *Objects* at 30 or fewer
  the probes measure the round trip. `colibri-server`'s `npm run test:stressecho` is a raw v3 client
  that answers probes, so the round trip can be measured with one editor instead of two.
- **`[Sync]` members are validated at startup**: an unsupported type, a property missing an
  accessor, or two members whose lowercased names collide are reported when the model type is first
  initialized instead of failing on the first message.
- Samples and README lead with the cast-free form.
- The README's Remote Store limitations match the `Store`: Unity types go through `ColibriJson`,
  failures return `false` or `default` instead of throwing, and names are URL-encoded. Its outage
  section describes the three answers to a re-request and says that an object changed during the
  outage is not sent in full again. It also covers the bound on received messages waiting for
  `Update`, and that loading a scene again does not rebuild placed objects on clients that kept it
  open.
- **The samples are no longer magenta under URP.** Their objects used Unity's built-in
  `Default-Material`, whose shader belongs to the built-in render pipeline. They share
  `Materials/ColibriSample.mat` now, whose shader `Colibri/Sample Lit` draws in the built-in pipeline
  and URP alike (with the stereo-instancing macros a headset needs), without making the package
  depend on URP.

## Performance

- **The sync tick allocates nothing while idle.** `Observable.EveryValueChanged` registered one
  frame-provider work item per synced attribute per object (five for every `SyncTransform`) and
  polled through a `Func<T, object>` getter, boxing four values per object per frame. On 100 idle
  synced objects at 60 fps that is roughly 24,000 allocations and 575 KB of garbage per second
  before anything moves.
- `SyncTicker` replaces it with **one `Update` and one `LateUpdate` for the whole application**,
  iterating an index loop over its registrations. `SyncedAttribute` became a typed hierarchy whose
  per-instance tracker compares with `EqualityComparer<TValue>.Default` (the `IEquatable<>` path for
  `Vector3`/`Quaternion`), so an unchanged attribute costs a comparison and nothing else. A value is
  boxed only on the frame it actually changes, to hand it to `AddUpdate`. The one exception is a
  value-type `[Sync]` *field* on IL2CPP, which is read through reflection and boxes on every poll
  (see *Meta Quest and Android*); properties, and every `SyncTransform` member, are unaffected.
- Poll (`Update`) and flush (`LateUpdate`) are separate phases, which keeps the existing
  one-message-per-frame coalescing while removing the `async void` + `UniTask.Yield(PostLateUpdate)`
  state machine that used to allocate once per change. The flush is also where the send-rate limit
  applies (see [SyncBehaviour and SyncTransform](#syncbehaviour-and-synctransform)), so an object
  that changes in every frame sends at most 30 messages a second by default, not one per frame.
- Neither library was ever on the network path: `WebServerConnection` used raw `Socket`, `Task`,
  `SemaphoreSlim` and `FrameCodec` throughout, so removing them changed nothing there. What did
  change latency is the `ConfigureAwait(false)` work above: the socket no longer waits for the
  player loop, which is worth far more than anything on this list to a client that is not running
  at full frame rate.

## Dependencies and API modernization

- **UniRx removed, not replaced.** `IObservable<T>` subscriptions became plain methods and static
  events; `this.ObserveEveryValueChanged(f)` became the typed change tracking above;
  `RemoteLogging`'s `Observable.Start` + `WhenAll` + `ObserveOnMainThread` + `Sample()` became a
  `ConcurrentQueue` filled from Unity's threaded log callback (several threads may log at once) and
  drained by a one-second timer in `Update`. Each line is handed to the connection exactly once, and
  the connection's outbox keeps it across an outage, so nothing is retried here and no line is sent
  twice. It keeps at most the newest 1000 lines between two sends (a second's worth while connected,
  which also bounds what a runaway log loop costs the server, and the whole outage while not), and
  the next send starts with one line saying how many were dropped (`Colibri: N log lines are missing
  here …`), so a gap in the server's log no longer goes unnoticed. After a protocol refusal it
  discards them.
- **UniTask removed.** `UniTaskCompletionSource` → `TaskCompletionSource` (which also tolerates
  several pending awaiters); `await request.SendWebRequest()` → a three-line `TaskCompletionSource`
  wrapper over `UnityWebRequestAsyncOperation.completed`, completing inline so the caller stays on
  the main thread. The plain awaiter never throws, so `Store` now checks `request.result` and
  reports what failed, at which URL, with the HTTP status.
- **Legacy observable API deleted.** `ObservableModel<T>`/`ObservableManager<T>` speak
  `channel::register`/`deregister` plus bare `add`, `update`, `request` and `remove`. A 2.0 server
  registers only `broadcast::*`, `model::request`, `model::update`, `model::delete`,
  `client::request` and `latency`, so none of those commands are handled: the API was provably dead
  against the server it targets. `SyncBehaviour`/`SyncBehaviourManager` cover the same use case.
- **Deprecated Unity APIs**: `FindObjectOfType` → `FindAnyObjectByType`, `FindObjectsOfType` →
  `FindObjectsByType`, without a sort order from Unity 6000.4 on (which deprecates the overloads
  taking one) and with `FindObjectsSortMode.None` before that, so neither end of the supported
  range warns. `SyncBehaviour.Awake` also scanned the whole scene twice per `Awake` and threw one
  of the results away.
- Vendored `Newtonsoft.Json.dll` replaced by `com.unity.nuget.newtonsoft-json`, declared as a real
  `dependencies` entry in `package.json` (which previously declared none at all).

## Tests

- New EditMode assembly `HCIKonstanz.Colibri.Tests` (`Assets/Colibri/Tests/Editor/`). The frame
  codec has no Unity dependency, so this is plain NUnit.
- `FrameReaderTests`/`FrameCodecTests` port `colibri-server/test/unit/protocol.test.ts`
  case-for-case: round trips for all three frame types, byte-by-byte fragmentation, a frame split
  across two segments, multiple frames coalesced into one segment, a complete frame plus a trailing
  partial, growth and compaction, and the malformed variants (`totalLength <= 0`, oversized, unknown
  type, channel/command length overrunning the body, handshake field-count violations).
- `ProtocolVectorTests` asserts frames and voice packets hex-dumped from the server's own encoders
  byte-for-byte against `FrameCodec` and `VoicePacketCodec`. This is what catches an endianness or
  off-by-one drift between the two implementations; the round-trip tests alone would pass just as
  happily with both C# sides wrong in the same direction.
- `ChannelListenerRegistryTests` covers the type-mismatch diagnostics, including the cases where a
  message must *not* be reported. Registering a listener with `Sync` reaches
  `WebServerConnection.Instance`, which spawns a GameObject, so the registry was split out as plain
  C# to be testable without one. `MessageDispatchTests` drives `Sync`'s own dispatch, accepting the
  inert connection object that registering creates in edit mode.
- `ListenerOwnerTests` covers which Unity object a listener is judged to belong to, since that is
  what automatic unregistration hangs on: a method group, a lambda written in a component, a lambda
  nested two closures deep, and the cases that must resolve to *nothing* (a static method, a plain
  C# object, a lambda over locals) because pruning one of those would be a new bug in place of the
  old one.
- `JsonExtensionsTests` covers the conversions every inbound message passes through: both wire forms
  of a colour, integer tokens where a float is expected, and every malformed shape, each of which
  has to fall back and warn exactly once rather than throw. This is the file the colour bug lived
  in, and it had no tests at all.
- `MessageDispatchTests` covers malformed payloads of every broadcast type and a listener that
  throws; `OutboxTests` the outage queue's folding rules and that queued messages arrive in order
  over a real loopback socket; `RemoteLoggingTests` logging from many threads at once and the
  1000-line bound; `SyncAccessorTests` the IL2CPP accessor path, run in the Editor;
  `SyncStrippingTests` that `[Sync]` is a `PreserveAttribute` and carries `[RequireAttributeUsages]`; `WireNameTests` the wire names under
  a Turkish culture; `AndroidSettingsCheckTests` the Android build check;
  `VoiceServerAddressTests` the choice of the server's address, IPv4 first, an IPv6 address
  without a route, a refused send, and voice over IPv6 on the loopback; `VoicePacketCodecTests` the
  voice header and the app id, with `VoicePacketQueueTests` which received packets are played; and
  `VoiceFramerTests` with `StreamingResamplerTests` how recorded audio becomes voice frames: only
  960-sample frames and no lost audio from a 44.1 kHz microphone, an encoder that always fails, and
  resampling without drift however the stream is cut. `VoiceDecoderTests` cover received packets:
  PCM plays, and an Opus decoder that cannot be created or fails drops only Opus, with one report.
  `VoicePlaybackBufferTests` and `VoicePlaybackTests` cover the hand-over to the audio thread: a
  writer and a reader on two threads, frames longer than the fast-forward latency, and starting and
  stopping twice.
  `FrameCodecTests` also covers the colon at either end of a handshake field.
- New PlayMode assembly `HCIKonstanz.Colibri.E2E` (`Assets/Tests/`, in the development project
  rather than the shipped package). A real Unity client, a real colibri-server and a raw v3 peer as
  the second endpoint: the server excludes the sender from its own broadcasts, so one client can
  never observe anything it sends. It covers the handshake and heartbeat, all 17 payload shapes in
  both directions asserting the exact bytes outbound, per-member `SyncBehaviour` updates, a model
  from another client being instantiated exactly once, `SyncTransform`'s per-field switches, the
  once-only mismatch warning, the Store over REST, and the ticker invariants behind the "one
  `Update` for the whole application" claim. Without a reachable server it skips with instructions
  rather than failing.
- `LifecycleTests` additionally pins what a singleton does once the previous Play session's instance
  has been destroyed: it must be rebuilt, not handed back. The bug this replaces produced no
  exception and no log line of any kind, so nothing short of asserting the invariant directly would
  have caught it. The assertions run against a singleton declared for the test rather than against
  `WebServerConnection`, since the statics are per-type and destroying the real connection would
  pull it out from under the rest of the suite.
- `ConnectionTests` pins the threading. The one that matters blocks the main thread outright for a
  second and then asserts the last heartbeat is still under half a second old, proof the socket is
  being serviced by something other than the player loop. It is deliberately the symptom the bug
  report described rather than a check for `ConfigureAwait` in the source, so it stays honest if the
  mechanism ever changes; a companion asserts the receive loop's thread is not the main one, which
  is the same fact stated the other way round. A third covers traffic entries ageing out of the
  Status window's log.
- `ReconnectTests` cut the Unity client's connection mid-session through a `TcpProxy`, while the raw
  peer stays connected, and pin the outage queue end to end: messages arriving in order ahead of
  newer ones, the bound with its single warning, every object's latest state with its requests and
  deletes, the models requested again after reconnecting, and `RemoteLogging` delivering each line
  once. `TcpProxy.Unplug` drops a link silently instead, as a Wi-Fi drop does: with it,
  `ReconnectTests` check that a change lost at the drop reaches the server and the other clients
  after the reconnect, also for an object shown for a while and hidden at the drop and for one moved
  every frame across it, that an object destroyed at the drop is deleted for the other clients,
  that another client's change made during the outage still wins, also when it goes back to a value
  this client sent long before, and that updates another client keeps sending through the reconnect
  are not taken for answers. `SentValuesTests` cover which values are kept and which count,
  including the one a member held 10 s before the outage, and how they are compared as JSON on the
  wire, and `ModelResyncTests` what an object does with them, also when the connection drops again
  before the answers or before the value sent again arrives, and when the object changes right
  after the reconnect. `ModelResyncTests` also cover a change made before an object's first answer,
  kept over that answer and the ones still on their way, also in the round after a reconnect, the
  members left as they were, which take the answer, and a placed body with `PhysicsAuthority`
  ticked, which waits for it, unless the client has had no connection for the connect timeout and
  no connect attempt is under way;
  `ReconnectTests` an object placed during
  the outage and changed as the client reconnects. `ProtocolMismatchDetectionTests` walk the
  client through scripted sessions against a `FakeColibriServer` that hangs up, stays silent, heartbeats or refuses: the
  growing backoff, the suspected mismatch and what clears it, the watchdog before the first frame,
  a refusal in the first frame, and the pairing of `OnConnected` and `OnDisconnected`.
  `SyncTransformTests` cover hiding, showing and deleting, including an object hidden when this
  client quits and one hidden as the client connects, before the server's answer;
  `SyncModelTests` a value from another client followed by a local change;
  `LifecycleTests` a listener registered after the connection was rebuilt.
- The send-rate limit, the connect timeout and the outbox cap have tests of their own. In EditMode,
  `SendRateTests` drive the limit on a clock of their own: the leading edge, a burst, the held
  update going out when its interval is up, 30 a second at 72, 90 and 120 fps, a limit of `0`,
  showing and hiding, a server value replacing a held change, a delete from another client dropping
  it, and where the limit comes from. `ModelUpdateTests` cover an update reaching a model before any
  object of its type has woken; `AppNameCheckTests` the shared-app-name warning; `SetupWindowTests`
  that a value the Setup window marks as an error stays out of the configuration without holding
  back a valid change or undoing one made elsewhere; `ConnectTimeoutTests` an attempt nothing
  answers, cancelling one, and a refusal reported at once; `ServerAddressTests` IP addresses with
  and without brackets, the order a name's addresses are tried in (IPv4 first), their shares of
  the connect timeout and none for an address without a route, moving on from an address that
  refuses or does not answer, IPv4 then IPv6 on the loopback, and a refusal not hidden by an
  unreachable address after it or by an address given up before it; `StorePathTests`
  the escaping of the app name and the key in Store URLs, and the
  brackets around an IPv6 server address there; `VoicePacketQueueTests` voice packets from several receive threads at once, a listener
  that throws, and the app id of an App Name the handshake changes; `OutboxTests` the 10 000-message
  cap, connected and not; `RemoteLoggingTests` the missing-lines note. In PlayMode, `SyncModelTests`
  and `SyncTransformTests` run the limit end to end (a burst, a limit of `0`, what is held going out
  on quit, pause and focus loss, a destroy and a delete from another client, hiding a moving object)
  and objects built from a disabled template, visible and hidden; `ReconnectTests` a drop and
  reconnect within one frame and the missing-lines note; `ProtocolMismatchDetectionTests` an attempt
  nothing answers, given up after 5 s and retried. `FakeColibriServer` now stays silent until it has
  read the handshake, as colibri-server does; its old behaviour, heartbeating before it has read the
  handshake and refusing after, is kept as `HeartbeatThenRefuse`.
- The tests that need a port that never answers are skipped on Windows, which refuses a
  connection to a full listen backlog instead of leaving it unanswered:
  `ConnectTimeoutTests.AnAttemptNothingAnswersIsGivenUpAfterTheTimeout` and
  `.CancellingGivesUpTheAttemptAtOnce`, and
  `ProtocolMismatchDetectionTests.AnAttemptNothingAnswersIsGivenUpAfterFiveSecondsAndRetried`.
  There, check the timeout by hand: with an unreachable server address, the client should leave
  *Connecting* after 5 s.
- `node colibri-unity/run-tests.mjs` runs both suites, starting and stopping a server with
  `docker compose`, unless one is already listening, which it uses as it stands. See
  [README.md](development.md#running-the-tests).
- The cross-implementation protocol vectors are checked automatically: `npm run test:vectors` in
  colibri-server re-encodes each one and fails if `ProtocolVectorTests.cs` no longer expects the
  same bytes. It also fails when `WebServerConnection`'s `CLIENT_VERSION` differs from the server's
  protocol version, so bumping one side alone cannot go unnoticed. It runs in the server's CI
  workflow, which also triggers on changes to the C# vectors and to
  `colibri-unity/Assets/Colibri/Networking/`.
- Still no GameCI workflow: the Unity suites run locally, since a Unity container in CI needs a
  licence secret. Voice chat has no end-to-end coverage (it needs a microphone); only the choice of
  the server's address, failed sends, the socket and its receive thread over the IPv6 loopback, the
  packet format, the queue that hands received packets to the main thread, how recorded audio is
  resampled and cut into frames, and how received packets are decoded and handed to the audio
  thread are unit-tested.
- `run-tests.mjs --stripping` builds a Release IL2CPP player with *Managed Stripping Level* High and
  checks inside it that every `[Sync]` member survived with its `[Sync]` and still syncs. Off by
  default; skipped with a notice without the platform's IL2CPP module.
- `TlsTests` and `StoreOverTlsTests` run against a second colibri-server with TLS on, which
  `run-tests.mjs` starts from `tls-test-server/compose.yml` (ports 9111 and 9112, with a test-only
  self-signed certificate). `run-tests.mjs --tls` runs the whole PlayMode suite a second time with
  every connection over TLS, the tests' own fake server and proxy included.

## End-to-end verification, and what it fixed

The Editor acceptance criteria for the release were run on 2026-08-05: Unity 6000.5.7f1, a
URP-template project with Colibri as a `file:` UPM package, against `colibri-server` 2.0.0 built and
run locally. The EditMode suite came back **52 passed, 0 failed**, and the server's own suite was
green at 102. The other end of every message-level exchange was a Socket.IO peer written against
colibri-web or a raw v3 TCP client, with a pass-through proxy in front of the TCP port decoding every
frame in both directions, because that is what makes the bytes quotable. A development Windows 64-bit
player was also built from the same project (`result=Succeeded errors=0 warnings=13 time=00:01:59`)
and run alongside the Editor with both clients connected to the same app at once and no
`FrameException` in the player log: the configuration the old hardcoded voice port and the old
`static` socket fields would have broken. The visual half of that is still unconfirmed: nobody
watched an object in one client follow an object in the other, since the player's scene state is not
observable from outside its process. The type-mismatch warning fires once for 60 offending
messages rather than once each, and the `SyncBehaviour` sample propagates private `[Sync,
SerializeField]` fields, public fields and properties alike, instantiates its template for a
remote-created model, and recovers that model from server state as a late joiner: one instance, not
a duplicate. The leak check is the one that found a defect rather than confirming a claim; it is the
last fix below. The headline performance claim was measured rather than argued: 100 idle
`SyncTransform`s with Deep Profile off gave a median frame of **0 bytes** of GC allocation over a
231-frame window, and exactly one `SyncTicker.Update()` on the main thread attributed to the single
`[Colibri SyncTicker]` object (0.335 ms of a 0.786 ms `PlayerLoop`), so the idle poll allocates
nothing but is not free of time. All ten criteria are addressed; what the pass did not touch is voice
chat and the visual half of Unity ↔ Unity. Item-by-item results are in §8 of
[`docs/v2-ease-of-use-and-performance.md`](v2-ease-of-use-and-performance.md).

The fixes it produced:

- **The `SendData` sample never round-tripped its JSON.** `SendMessages` sent its `JObject` on the
  literal channel `"myJson"` while listening on `Channel`, so the one payload type that most needs
  demonstrating was the one that appeared not to work. It sends on `Channel` now.
- **Samples moved to `Samples~`, and `Prefabs` left `samples[]`.** As live package folders they were
  compiled into every consumer *and* offered for import, so Package Manager → Import produced a
  second copy of everything: importing `SendData` the way the README says logged a GUID conflict
  against `Packages/de.uni.kn.colibri/Samples/SendMessages/SendMessages.cs`, left two definitions of
  `HCIKonstanz.Colibri.Samples.SendMessages` (one in `Assembly-CSharp`, one in
  `HCIKonstanz.Colibri`) and two copies of every scene. Not a hard compile error, but any user code
  naming the type was ambiguous. After the move: zero sample types in the package assembly, and a
  re-import yields exactly one `SendMessages.unity` with no GUID warnings. See the breaking-change
  note above. The tradeoff, as expected, is that the `colibri-unity` dev project can no longer open
  the sample scenes in place; they are opened from a consuming project now.
- **Stale `SyncTransform` sample assets.** `SyncTransformSample.unity` carried a dead
  `propertyPath: Channel` override (`synctransform_CUBE`) that no longer corresponds to anything, and
  `CubeModelTemplate`/`SphereModelTemplate` predate the `SyncActive` and `UseLocalTransform` fields.
  Both are updated, so the scene demonstrates the component as it currently exists.
- **Colour did not round-trip, and took the frame down with it.** Unity writes a colour as the HTML
  string `#RRGGBBAA` (which is what colibri-web's `receiveColor` is typed for), but colibri-web's
  `sendColor` puts an `[r,g,b,a]` array on the wire. A colour from a web client arrived as
  `InvalidCastException: Cannot cast JObject to JToken` out of `JsonExtensions.ToColor`, and because
  that escaped `WebServerConnection.Update` unhandled it also dropped every message queued behind it
  that frame. `ToColor` accepts either form now, and all of the vector, quaternion and colour
  conversions report a wrong-shaped payload as a warning naming the type and the expected shape
  instead of throwing. A web client's `[1, 0.5, 0.25, 1]` now arrives as
  `RGBA(1.000, 0.500, 0.250, 1.000)`. colibri-web's own `sendColor`/`receiveColor` asymmetry is left
  as it is on purpose: changing the wire format would move behaviour under existing web-only users,
  and Unity copes with both forms.
- **Integers sent from Unity were dropped by web clients.** `Sync.Send(channel, 5)` goes out tagged
  `broadcast::int`, but colibri-web's `receiveNumber` only listened for `broadcast::float`.
  JavaScript has a single number type, so there was nothing to distinguish and every integer a Unity
  client sent vanished without a trace. Fixed in colibri-web: `receiveNumber` and
  `receiveNumberArray` listen for both commands, with its 108 tests still passing.
- **The status window's heartbeat readout counted down.** `MillisSinceLastHeartbeat()` is a 0-100 ms
  sawtooth and the window repaints at 10 Hz, so the raw sample beat against the server's heartbeat
  and read like a timer running out. It now peak-holds the worst gap over a one-second window, which
  is steady and is the number that actually indicates trouble.
- **`Store` waited forever.** `UnityWebRequest.timeout` defaults to no timeout, so on an unconfigured
  project (where `ServerAddress` still points at the public `colibri.hci.uni-konstanz.de`),
  `Store.Get` neither threw nor logged, and was still outstanding after a minute. The detailed
  failure log added in this release only runs when the request finishes, so `Get`/`Put`/`Delete` now
  set a ten-second timeout: long enough for a slow link, short enough that the failure is reported
  while the developer is still looking at the console.
- **`SyncTicker` leaked one GameObject per Play session, and they all ticked.** With *Enter Play Mode
  Options → Disable Domain Reload* on, three enter/exit cycles left one extra `[Colibri SyncTicker]`
  behind each time; measured outside Play mode the Editor had collected seven, all still enabled:

  ```
  live SyncTicker components (outside Play mode): 7
    go='[Colibri SyncTicker]' hideFlags=DontSave activeSelf=True enabled=True scene='' valid=False
    ... x7
  ```

  `HideFlags.DontSave` exempts an object from Play-mode teardown as well as from being saved, and
  `DontDestroyOnLoad` was already covering the saving half by itself. The stale object is not the
  real cost: every ticker drives the same static `_tickables` list, so the n-th Play session ran
  `PollChanges` and `FlushUpdate` n times per frame, with duplicate `model::update` messages on the
  wire and a sync cost that grew each time someone pressed Play, which is the direct contradiction
  of the one-`Update`-for-the-whole-application claim above. The flag is gone and `ResetState`
  destroys strays first, so an Editor that already accumulated them recovers on the next Play.
  Afterwards: zero tickers alive outside Play mode, three cycles holding steady, and the 52 EditMode
  tests still green.

  ```
  LEAK syncedBehaviours=4 connections=1 tickerObjects=1 tickables=4
  LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
  LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
  ```

  (The first cycle counts four because the late-joined remote model had already arrived when the
  probe ran.) `ColibriTest` was left with *Disable Domain Reload* enabled, since that is the
  configuration this check requires.

## Known residuals

- Disabling a `SyncBehaviour` component (`enabled = false`) pauses its syncing: it neither polls
  nor sends, and changes made while it was disabled go out as ordinary changes the frame it comes
  back. Deactivating its GameObject does not pause it, since for a `SyncTransform` the active state
  is itself synced. In 1.3.1, whose change observation ran until the object was destroyed
  (`TakeUntilDestroy`), a disabled component kept syncing.
- After a reconnect, an object deleted elsewhere during the outage is deleted on this client too
  only when the server still remembers the delete (`MODEL_TOMBSTONE_SECONDS`, 10 minutes by
  default). After that, the re-request is answered as for an unknown object, this client sends it
  again, and it is back for everyone as if it had just been created.
- The server forgets an app's models when the app's last client disconnects (a single client whose
  connection drops is that last client) and when it restarts. An object that did not change during
  the outage sends its full state again when the server answers its re-request with nothing. One
  that changed is not sent in full: its merged update reaches the server first, so the server has
  only the members that changed, and learns the others only when they change.
- A change lost at the drop is told from another client's by its value alone. Another client that
  sets a member back during the outage, to a value this client held in the 10 s before the outage
  was noticed, is undone. A member changed more than 8 times within about 100 ms of the last
  heartbeat before the link died, which needs a send-rate limit above about 80 a second, may not be
  recognised, and takes the answer after the reconnect. A member changed more than once between a
  reconnect and a second drop, before all the answers are in, may not be recognised either. A member
  whose very first value was lost held nothing before it, and is not sent again. A delete sent again
  after an outage also removes an object another client has created under the same id in the
  meantime.
- A placed `SyncTransform` with `PhysicsAuthority` ticked stops waiting for the server's state once
  the client has had no connection for 5 s (the connect timeout) and no connect attempt is under
  way. A client that started without a server, or lost it for that long, and connects later sends
  the position its own simulation reached over the shared one.
- `SyncBehaviourManager` must unsubscribe from `SyncBehaviour<T>.ModelCreated` / `ModelDestroyed` in
  `OnDestroy`, since static events do not do it themselves. It does; anything else subscribing to
  them has to as well, or it leaks across Play sessions when domain reload is disabled.
- A `static` listener, or one owned by a plain C# object, stays registered into the next Play session
  when domain reload is disabled: `Sync`'s listener dictionaries are statics, and neither of those
  has a Unity lifetime to be dropped by. Listeners belonging to a Unity object clean themselves up,
  which covers the ordinary case. Clearing the dictionaries at startup would fix it and break a
  listener registered from a `[RuntimeInitializeOnLoadMethod]` hook, so it is left as it is.
- A `[Sync]` array changed **in place** is not detected: the comparison is by reference, as it was
  in 1.3.1. Assign a new array to sync it.
- On IL2CPP, a value-type `[Sync]` field is read through `FieldInfo.GetValue`, which boxes on every
  poll; there is no allocation-free way to read a field through reflection without a JIT. A
  property is read through a delegate and allocates nothing, so a frequently synced value-type
  member is cheaper as a property. Attribute construction dispatches through an explicit per-type
  `if` chain rather than `MakeGenericMethod`, which keeps every instantiation visible to the AOT
  compiler.
- Every `SyncBehaviour<T>` registers its own listener on its type's channel, so each inbound
  `model::update` is offered to every instance of that type. With every object changing, the cost
  of applying a frame's updates therefore grows with the square of the number of objects. The
  `Network Stress` sample is there to measure where that starts to matter.
- What the send-rate limit still holds when the app quits, or Play mode ends, is handed to the
  connection during the same teardown that closes its socket, so it may not arrive. Pausing and
  losing focus, which is how an Android or Quest app is usually left, send it while the connection
  is still open.
