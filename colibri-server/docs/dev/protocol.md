# Colibri wire protocol

Colibri relays real-time object synchronization between two kinds of clients:

- **Unity clients** connect over raw **TCP** with the [v3 framing](#v3-tcp-framing).
- **Web clients** connect over **Socket.IO** with the [envelope](#socketio-envelope-web-clients). The
  framing sections do not apply to them. Version checking, channels, commands and payloads do.

Both transports feed the same `{ channel, command, payload }` message into the transport-independent
`ConnectionPool`, so a relayed message reaches the app's clients on both. Only the hooks
`ModelSynchronization`, `MeasureLatency`, `WebLog` and `ClientLogger`, and the admin UI's `AdminData`,
read payloads, through `Payload` (`src/server/modules/protocol/payload.ts`).

`Payload` keeps the form a message arrived in: a JSON string (TCP, or Socket.IO sent as a string), a
parsed value (Socket.IO) or raw bytes (TCP). It converts to another form on first use and caches the
result. Same-transport relays do no JSON or UTF-8 work. A cross-transport relay, or a hook that reads
the payload, converts it once.

Unity clients send voice separately, over UDP to the voice port ([Voice packets](#voice-packets-udp)).

## Relayed messages

The server relays two kinds of client messages to the other clients of the sender's app, Unity and
web:

- messages whose `command` starts with `broadcast::`, unchanged
  ([`broadcast::` commands](#broadcast-commands))
- `model::update` and `model::delete`, which also change the server's copy of the model
  ([Model synchronization](#model-synchronization))

It also answers `model::request` and handles messages on the channels it reserves
([Server messages](#server-messages)). Any other message reaches no other client. A command such as
`myCommand`, sent with colibri-web's `SendMessage(channel, 'myCommand', …)` or colibri-unity's
`WebServerConnection.SendCommand`, is dropped, with a warning once per app, channel and command:
`Client '<name>' (<id>, app '<app>') sent 'myCommand' on channel '<channel>', which the server does not handle: it reached no other client. ...`.
For your own messages, use a command starting with `broadcast::`, e.g. `broadcast::myCommand`, and
receive it with colibri-web's `RegisterChannel` or colibri-unity's `OnMessageReceived`.

Under overload, or from a client that sends too fast, the server holds back and merges
`model::update` messages and drops `broadcast::` messages ([Inbound limits](#inbound-limits)).

## v3 TCP framing

> **Breaking change.** colibri-unity clients built for the v1 flatbuffer framing and v2.0.0+ servers
> cannot connect to each other. Upgrade both sides together ([Version checking](#version-checking)).

Clients announce the v3 framing as protocol version `2`.

Each frame is a fixed-size header followed by a type-specific body:

```
[u32 LE totalLength][u8 type][body]
```

- `totalLength` counts the bytes **after the length field**: `1 (type) + body.length`. A full frame is
  available once `4 + totalLength` bytes are buffered.
- `type` is one of:

| Type | Name | Body |
| --- | --- | --- |
| `0x00` | heartbeat | `[u64 LE pingTimestamp]` |
| `0x01` | handshake | utf8 `"version::app::name"` |
| `0x02` | message | `[u16 LE channelLen][channel utf8][u16 LE commandLen][command utf8][payload bytes]` |

All integers are little-endian. Strings in a body are length-prefixed, not null-terminated, so the
parser never scans for delimiters.

### Handshake

A client must send a `handshake` frame right after connecting, before anything else. The body is
`version`, `app` and `name`, joined with `::`, as UTF-8 text.

- No field may contain `::`, or start or end with `:`, because a body like `"2::app:::name"` cannot be
  split back into the intended fields. A `:` inside a field is fine.
- A body that breaks this rule, or does not split into exactly three fields, is a frame error
  ([Frame parsing](#frame-parsing)). The server logs
  `Invalid frame from client <id>, discarding buffer and terminating connection: Malformed handshake frame: "<body>"`
  and closes the connection.
- colibri-unity replaces `::`, and a `:` at either end, in its app and device name with `_`, and warns
  when this changes the app name.

The server assigns the connection to `app` and includes it in that app's broadcasts. A `message` frame
received before the handshake is ignored and logged.

A client may handshake again on the same connection to move to another app. The old app receives
`client::disconnected` and loses its models if that was its last client. The new app receives
`client::connected`. A second handshake into the same app shows as a disconnect and a connect, and the
app keeps its models.

### Version checking

The server compares `version` with `PROTOCOL_VERSION` in
[`protocol.ts`](../../src/server/modules/protocol/protocol.ts), currently `2`. It supports one version
at a time and **refuses** every other one. There is no negotiation or downgrade, since v1 and v3 share
no subset.

A refused client never joins its app's broadcast set or `clientConnected$`, so it does not appear in
the admin UI. The server logs an error naming the client, its address and both versions, e.g.
`Refusing client '<name>' (<id>, <address>): Unsupported protocol version '1'. This server speaks v2.`
It then sends the client this message frame and closes the connection:

| Field | Value |
| --- | --- |
| channel | `colibri` |
| command | `protocol::rejected` |
| payload | `{ "reason": string, "serverVersion": string, "clientVersion": string }` |

On TCP the refusal is queued ahead of the server's FIN. The server sends nothing before accepting a
handshake, so the refusal is the first frame the client receives. Everything the client sends after
that is ignored, including frames behind the refused handshake in the same packet. A peer that has not
closed its side 5 s later is disconnected.

Socket.IO clients announce their version in the handshake query (`?app=…&version=…`) and receive the
same `colibri` / `protocol::rejected` event before being disconnected. A client without a version is
refused with `clientVersion: ""` and a reason containing `'(none)'`. The admin UI (`app === 'colibri'`)
ships with the server and is only warned about, so a mismatch cannot lock you out of it.

Known gaps (all deliberate):

- **A client with other framing cannot read the refusal.** The first packet of a Colibri 1.x Unity
  client, its handshake, does not parse as a v3 frame ([Frame parsing](#frame-parsing)), and the client
  could not decode a refusal anyway. The server detects the 1.x framing, closes the connection and
  logs this warning at most once a minute per address (repeats at debug level):
  `Refusing a connection from <address>: it looks like a Colibri 1.x client (it speaks the 1.x wire format), but this server speaks protocol v2. Upgrade the Colibri Unity package (de.uni.kn.colibri) in that app to 2.x. ...`.
  This is the only diagnostic. The 1.x client keeps reconnecting.
- **colibri-web 1.x does not handle `protocol::rejected`.** It receives the refusal as an ordinary
  message, logs nothing, and stays disconnected, since Socket.IO does not reconnect after a
  server-side `disconnect()`. The server log is the only diagnostic ([MIGRATION.md](../../../MIGRATION.md)).
  It is refused because it announces `1`, although the Socket.IO envelope did not change and its
  messages would still work. Upgrade it together with the server.
- **The admin UI exemption goes by app name.** Any Socket.IO client with the app name `colibri` skips
  the check. The name is reserved for the admin UI and collides with the `colibri` control channel.
- **The check cannot detect an out-of-date server**, since it runs on the server. Clients can only
  suspect one ([Detecting an out-of-date server](#detecting-an-out-of-date-server)).

Clients must announce `PROTOCOL_VERSION`: `CLIENT_VERSION` in colibri-unity's `WebServerConnection.cs`,
`PROTOCOL_VERSION` in colibri-web's `Colibri.ts`, and the `version` query in the admin UI's
`socketio.service.ts`. `npm run test:vectors`, which CI runs, fails if one of them differs or cannot be
found.

**The protocol version is not the release version.** It names the wire format, and nothing derives it
from a `package.json`. Every 2.x client works with every 2.x server. Only a different announced
protocol version is refused:

| Change | `PROTOCOL_VERSION` | Effect |
| --- | --- | --- |
| 2.0.0 → 2.0.1, bugfix | `2` | none, interoperable |
| 2.0.0 → 2.1.0, new features, same wire format | `2` | none, interoperable |
| a frame layout, field or encoding changes | `2` → `3` | **every deployed client is refused at once** |

Bump it only when existing clients would otherwise misread the bytes on the wire, not to signal
additions. A new `command` is not a wire-format change, since no client breaks on an unknown command:
colibri-unity's `Sync` and colibri-web's `Sync.receive*` listeners ignore it, and a colibri-web
`RegisterModelSync` channel logs `Unknown model command` to the console and otherwise ignores it. Code
that handles raw messages (colibri-web's `RegisterChannel`, colibri-unity's `OnMessageReceived`)
receives every command and must skip unknown ones.

### Detecting an out-of-date server

A server older than the version check refuses nobody and never states its version. A current server
therefore announces itself right after accepting a Socket.IO client, before any application traffic:

| Field | Value |
| --- | --- |
| channel | `colibri` |
| command | `protocol::accepted` |
| payload | `{ "serverVersion": string }` |

| Client | Signal | Detection time | Reaction |
| --- | --- | --- | --- |
| colibri-web | no `colibri`/`protocol::accepted` within 5 s of connecting | 5 s | warns, emits a **non-fatal** `ProtocolMismatchError` (`fatal: false`, `serverVersion: '1'`), **stays connected** |
| colibri-unity | 3 sessions in a row that got past the handshake and ended before a frame decoded, other than by its 2 s heartbeat watchdog or, with TLS on, by a close or reset | about 1.5 s against a 1.x server: three sessions, 500 ms and then 1000 ms apart | logs an error, sets `SuspectedProtocolMismatch`, keeps retrying |

colibri-web reports the suspicion and a refusal (`fatal: true`) at most once each per `Colibri`
instance on `Colibri.protocolMismatch`. A refusal can follow a suspicion, not the reverse.

colibri-unity counts a session as connected only after the server's first frame, so these sessions do
not reset the reconnect backoff (0.5 s, 1 s, 2 s, ... up to 10 s). A session past the handshake that
ends without a frame counts if it ends in a clean close, a reset or an undecodable frame. With TLS on,
only an undecodable frame counts. A session ended by the 2 s heartbeat watchdog never counts. The
first frame a session decodes clears the count and the suspicion.

A 1.x server sends heartbeats from the moment it accepts, also through a TLS-terminating proxy, and
the first one fails to decode at once. A 2.x server with TLS on closes the connection of a client
without TLS and sends a frame to one with TLS. Sessions that do not count therefore point at something
that accepts connections and then closes them or forwards nothing, such as a proxy whose backend is
down. After 3 of them in a row, colibri-unity logs a warning saying so.

TCP clients get no announcement. The framing changed incompatibly in 2.0.0, so a pre-2.0.0 server is
unmistakable.

In `protocol::accepted`, `protocol::rejected`, `ProtocolMismatchError` and
`ProtocolMismatchException`, `serverVersion` is always a **protocol** version, never a release version
such as `1.3.1`. It compares directly with the client version beside it. For a suspected old server it
is `'1'`, since every 2.0.0+ server sends the announcement and every earlier release uses v1.
`'unknown'` appears only when a server refused a client without stating its version.

The 100 ms `latency` broadcast is no substitute for the announcement, because colibri-server 1.2.0
added it and 1.2.x and 1.3.x servers send it too. Verified against the published images:
`hcikn/colibri:1.1.1` sends none, `hcikn/colibri:1.3.1` sends it with the old `\0\0\0` framing. These
servers also match 2.x in the Socket.IO envelope, the `colibri::clients` payloads and the relay
behaviour, so a web client has no other signal.

The detection is heuristic:

- **No client disconnects on a suspicion.** colibri-web stays connected, because a current web client
  works with a 1.x server. The Socket.IO envelope did not change (tested against both images, traffic
  relayed both ways). A current Unity client cannot work with a 1.x server. colibri-unity logs the
  cause, keeps retrying and leaves `Status` unchanged. `ConnectionStatus.ProtocolMismatch` and
  `ProtocolMismatchReason` are reserved for a refusal that was received and decoded.
- **False positives are possible.** For colibri-unity, a TCP port that is not Colibri looks the same,
  so only sessions past the handshake count. "Connection refused" means the server is switched off and
  is never reported as a version problem. colibri-web's signal can also come from a server whose event
  loop stalls for 5 s. While the browser tab is hidden, colibri-web re-arms the timer instead of
  reporting, since a frozen tab is the likeliest cause of such a delay.

### Heartbeat / latency

Every 100 ms, the server sends a `heartbeat` frame with `process.hrtime.bigint()` as ping timestamp to
each TCP client whose handshake it accepted, until the connection closes. A client whose previous
heartbeat has not gone out yet is skipped ([Backpressure](#backpressure)). The client echoes the frame
unchanged, the only `heartbeat` frame sent from client to server. The server feeds the echo into the
message pipeline as a synthetic `colibri`/`latency` message, so `MeasureLatency` computes the round
trip as for a web client's latency ping. Using one frame for heartbeat and latency ping halves the
idle packet rate per client, compared with two 100 ms timers.

The server is never silent for long, so a client can treat silence as a dead connection. colibri-unity
drops a session after 2 s without a frame, also while waiting for the first one, and reconnects.

The server does the same. A TCP client that sends nothing, neither heartbeat echo nor message, for
`TCP_IDLE_TIMEOUT_SECONDS` (default 10 s, `0` disables it) counts as gone, e.g. a headset that left the
Wi-Fi without closing its connection. The server logs a warning naming it, closes the connection and
handles it like any disconnect: the app's other clients receive `client::disconnected`, and the app
loses its models if it was the last client. Echoing every heartbeat keeps a client connected, if the
echo comes from a thread that keeps running while the application is busy. colibri-unity echoes from
its receive loop, off Unity's main thread. A connection without a handshake within the same time is
closed too. All connections have TCP keepalive enabled. Socket.IO clients are not covered. Socket.IO's
own ping detects a lost one, by default within 45 s.

A message over 64 KiB contains no heartbeat, so a client reading it cannot echo until it is through.
The server cannot observe the reading, since the kernel's send buffer, and those of a proxy such as
Docker's port forwarding, take megabytes at once.

Until a client echoes a heartbeat sent after the latest such message, its idle timeout is extended by
`TCP_IDLE_TIMEOUT_SECONDS * min(size / 64 KiB, 6)`, where `size` is the largest such message sent
since its last echo. This assumes the client reads at least 64 KiB per timeout (about 6.4 KiB/s at the
default). At the default the total is at most 70 s, enough for a 4 MiB message at about 60 KB/s or
faster. A slower client is disconnected, and the warning names the message size. A client that is gone
when such a message is sent, or goes while reading it, is detected that much later. A client that
never echoes heartbeats keeps the extra time from its first such message on.

Socket.IO clients get no heartbeat frame but a `colibri`/`latency` event every 100 ms from
`MeasureLatency`. It is not a version signal, because colibri-server 1.2.0 and later send it
([Detecting an out-of-date server](#detecting-an-out-of-date-server)).

### Message

A `message` frame carries an application message. `channel` and `command` identify it, e.g. channel
`myApp::position`, command `model::update`. `payload` is an opaque byte range, passed to other TCP
clients byte for byte and decoded (`Payload.fromBytes(...).asValue()`) only when a hook inspects it or
when relaying to a Socket.IO client. Exception: a `model::update` that was held back and merged
([Inbound limits](#inbound-limits)) is passed on re-encoded.

### `broadcast::` commands

The `broadcast::` prefix of `command` makes the server relay the message
([Relayed messages](#relayed-messages)). Nothing else on the wire marks it. colibri-unity's `Sync.Send`
and colibri-web's `Sync.send*` use the commands in [Payload shapes](#payload-shapes) for state, position
and other continuous updates.

`BroadcastLogger` (`src/server/modules/hooks/broadcast-logger.ts`) logs each one at debug level
with `metadata.broadcastTraffic = true`. The admin UI's *Sync traffic* toggle filters on that tag,
independent of the level filter, because this continuous traffic would drown out everything else.
See `WebLog.isVisibleToClient` (`src/server/modules/admin/web-log.ts`).

#### Payload shapes

The server never inspects a `broadcast::` payload, so the shape is a convention between the clients:

| Command | JSON payload | colibri-unity | colibri-web |
| --- | --- | --- | --- |
| `broadcast::bool` | `true` | `Send(ch, bool)` | `sendBool` |
| `broadcast::int` | `5` | `Send(ch, int)` | none |
| `broadcast::float` | `1.5` | `Send(ch, float)` | `sendNumber` / `sendFloat` / `sendInt` |
| `broadcast::string` | `"text"` | `Send(ch, string)` | `sendString` |
| `broadcast::vector2` | `[x, y]` | `Send(ch, Vector2)` | `sendVector2` |
| `broadcast::vector3` | `[x, y, z]` | `Send(ch, Vector3)` | `sendVector3` |
| `broadcast::quaternion` | `[x, y, z, w]` | `Send(ch, Quaternion)` | `sendQuaternion` |
| `broadcast::color` | `"#RRGGBBAA"` **or** `[r, g, b, a]` | `Send(ch, Color)` → string | `sendColor` → array |
| `broadcast::json` | any JSON value (colibri-web sends an object) | `Send(ch, JToken)` | `sendJson` |

Every command except `broadcast::json` has an array form: append `[]`, and the payload is an array of
the values above, e.g. `broadcast::vector3[]` carries `[[x,y,z], …]`.

**Receivers must accept both colour forms.** Unity writes the HTML string from
`ColorUtility.ToHtmlStringRGBA`. colibri-web writes `[r, g, b, a]` with components from 0 to 1.
Changing either would break peers already sending it, so both clients accept both forms:
`JsonExtensions.ToColor` in colibri-unity, `ColorValue` and the exported `toHexColor`/`toRgbaColor` in
colibri-web. A wrong-shaped payload logs a warning and falls back to opaque black instead of throwing.
A `[Sync] Color` model field uses the same conversions and has the same two forms.

**Only Unity sends `broadcast::int`.** JavaScript has one number type, so colibri-web cannot tell `5`
from `5.0` and always sends `broadcast::float`. `sendInt` is an alias kept for symmetry with the Unity
API. Unity routes the two commands to separate listener lists, so a Unity client must receive numbers
from web clients with `Sync.Receive<float>`. colibri-web's `receiveNumber` listens for both commands.

**The `log` channel is not JSON.** `ClientLogger` treats its payload as text, so colibri-unity sends it
as raw UTF-8 (`PayloadCodec.EncodePayload`). The server unwraps a JSON string value before
logging it, so a web client's log line reaches the admin UI without JSON quotes.

### Frame parsing

`FrameReader` (`src/server/modules/protocol/protocol.ts`) is a growable buffer with read and write
cursors that TCP data is appended to. It returns every complete frame buffered. When compacting, it
copies only the trailing partial frame, which avoids an O(streamLength²) `Buffer.concat` cost on a
long-lived, often fragmented connection. A malformed or oversized frame (declared length `<= 0` or above
the reader's maximum) throws `FrameError`, which is fatal for the connection. The server logs
`Invalid frame from client <id>, discarding buffer and terminating connection: <reason>` and closes it.

If the failing bytes are the Colibri 1.x framing (three NUL bytes, then `h` or an ASCII digit), it
throws the subclass `V1FramingError`, which is how the server detects a 1.x client
([Version checking](#version-checking)). No v3 frame can start that way, because these four bytes read
as a length of at least 16 MiB. The 1.x handshake starts with `\0\0\0h`, which reads as
`Invalid frame length: 1744830464` (`0x68000000`, `'h' << 24`).

### TLS

With `TLS_CERT` and `TLS_KEY` set ([TLS](https://colibri.hci.uni-konstanz.de/server/configuration#tls) in the guide), the TCP port accepts only TLS.
TLS wraps the v3 framing unchanged. The protocol version stays `2`.

On the TLS port, the server reads the first 2 bytes of each connection. `0x16 0x03` starts a TLS
handshake record. As a v3 length field, these bytes would mean a frame of at least 790 bytes
(`0x0316`), longer than any client handshake frame, so an unencrypted client is never mistaken for a
TLS client. An unencrypted client on the TLS port is closed with nothing sent, with a warning naming
it. On a port without TLS, a client whose first bytes are a TLS handshake is refused with a warning
instead of waiting for a frame that never completes. Both warnings are logged at most once a minute
per address.

For web clients only the transport changes. With TLS on, the web port serves only HTTPS and WSS. The
[Socket.IO envelope](#socketio-envelope-web-clients) is unchanged.

### PROXY protocol

With `TCP_PROXY_PROTOCOL=true` ([Behind a reverse proxy](https://colibri.hci.uni-konstanz.de/server/configuration#running-behind-a-reverse-proxy)), a
connection from an address in `TRUSTED_PROXIES` starts with a
[PROXY protocol](https://github.com/haproxy/haproxy/blob/master/doc/proxy-protocol.txt) header, sent
by the proxy, never by a Unity client: version 1, a line of text of at most 107 bytes ending in CRLF,
or version 2, binary, with at most 4 KiB after its fixed 16 bytes. Its source address replaces the
connection's address as the client's. Version 1 `UNKNOWN`, version 2 `LOCAL`, and anything but TCP
over IPv4 or IPv6 keep the connection's address. A version 2 header's TLVs, such as the TLS details
of HAProxy's `send-proxy-v2-ssl`, are skipped. Whether the proxy terminated TLS comes from
`TCP_TLS_AT_PROXY` instead, and only the admin UI uses it. The connection goes on after the header as without
one: the TLS handshake on a TLS port, then the handshake frame. A connection without a header is told
apart by its 4th byte at the latest: read as a v3 length field, the first 4 bytes of either header
exceed 5 MiB, and a TLS handshake starts with `0x16`. A trusted peer without a valid header within
10 s is closed, and so is a connection from any other address that starts with a header, or sends
nothing within 10 s.

### Backpressure

Before writing a relayed frame to a TCP client, the server compares the relayed traffic waiting in the
client's write buffer with a 1 MiB high-water mark. Above it, the frame is dropped, not queued, whatever
it carries: `broadcast::`, `model::update`, `model::delete` or `client::connected`. The server warns when
a client starts falling behind, and again with the number of dropped frames once it has caught up.
This bounds memory. The client is not told which frames it missed. A continuous `broadcast::` stream
recovers with the next message. A one-off broadcast is lost. A dropped `model::update`, usually
carrying only the changed fields, can leave a field out of date on that client until it changes again.
A dropped `model::delete` leaves the object in place. A client that reconnects requests the current
models again ([After a reconnect](#after-a-reconnect)).

Two kinds of frames are exempt:

- **Answers to the client's own requests:** the `model::update` and `model::delete` frames answering its
  `model::request`, and the `client::connected` frames answering its `client::request`. Nothing would
  send them again, and a whole-channel answer is one frame per model written at once, which a late
  joiner on a slow link would otherwise get only in part. They are queued outside the high-water mark,
  so a client still reading its answer also receives the updates made meanwhile. Only above 64 MiB of
  answers waiting for one client are further answers dropped, with a warning naming the client, and
  another when it accepts answers again.
- **Heartbeats.** One goes out ahead of the next message once 64 KiB have been written since the last
  one, so a client reading a long answer can keep echoing and is not disconnected as idle. A single
  message over 64 KiB contains none ([Heartbeat / latency](#heartbeat--latency)). The 100 ms heartbeat is
  not queued behind one still waiting, so a client that keeps sending but never reads is not sent ten a
  second.

For incoming traffic, see [Inbound limits](#inbound-limits).

## Socket.IO envelope (web clients)

A web client connects with the handshake query `?app=<app>&version=2`. A connection without `app` is
logged and disconnected. A message is a Socket.IO event named after the `channel`, with a
`{ command, payload }` envelope as data. An event without a string `command` is logged and ignored.
`payload` is a plain JSON value, not a byte buffer. Socket.IO handles message boundaries, so no framing
is needed. The envelope is unchanged from 1.x. `ConnectionPool.broadcast()` uses one Socket.IO **room
per app**, so a message to N web clients of an app is encoded once, not N times.

## Size limits

Every inbound path accepts messages of up to about 5 MiB, so the limits match across transports:

| Path | Limit | Beyond the limit |
| --- | --- | --- |
| TCP frame | 5 MiB (5,242,880 bytes) for type and body. A payload gets that minus its channel, its command and 5 bytes. | `FrameError`: the server closes the connection |
| Socket.IO packet | 5 MiB plus room for the largest channel and command, about 5.13 MiB | engine.io drops the connection and the message |
| REST request body | 5 MiB | `413` |

On TCP, channel and command are each at most 65,535 bytes of UTF-8 (a `u16` length). A web client's
message that does not fit into a TCP frame is not relayed to TCP clients. The server logs
`Dropping unencodable message` instead.

## Inbound limits

Two limits keep a server that receives more than it can process responsive and its memory bounded:

| Limit | Counts | Setting, default |
| --- | --- | --- |
| backlog | messages from all TCP clients that the server's main thread has not processed yet | `TCP_INBOUND_BACKLOG_LIMIT`, `2000` |
| rate | messages per second from one client, TCP or Socket.IO, with bursts | `CLIENT_MESSAGE_RATE_LIMIT`, `1000`, and `CLIENT_MESSAGE_RATE_BURST`, `2000` |

`0` disables either. Socket.IO clients have only the rate limit, because the server handles their
messages as it reads them, without a queue.

Both limits apply only to `model::update` and `broadcast::` messages, the bulk of sync traffic, and
never to messages on the `colibri` or `log` channel. Everything else passes at once: handshakes,
heartbeats, `model::request`, `model::delete`, log lines and anything on the `colibri` channel. Above
a limit:

- **`model::update` is held back and merged per object** (channel and `id`). A field in a later update
  replaces the held one, and fields not sent again are kept. When there is room, checked with the
  client's next message and every 100 ms, the held updates go on, oldest object first, one
  `model::update` per object. Since the server and every client merge updates field by field, the other
  clients and the server's copy skip intermediate states but still get the latest value of every field.
  A held update is re-encoded as JSON, so it is not byte-identical to what the client sent.
- **`broadcast::` messages are dropped**, as there is nothing to merge them into.
- An update the server could not apply anyway, one that is not a JSON object with a string `id`, is
  dropped.
- **With updates for 1000 objects held for a client, an update for another object is lost**
  (`MAX_HELD_OBJECTS`). Unlike a broadcast, this is state nothing sends again. The object reaches the
  server's copy and the other clients only when it changes again. A client creating a few thousand
  objects at once, e.g. a scene with many synced objects loading, can hit this.

Nothing a client sends overtakes its held updates. They go on before its next message that is not
limited, before a second handshake, and on disconnect before its app receives `client::disconnected`.
As a result, a `model::delete` cannot arrive ahead of an update to the same object and have that
update bring it back.

Clients are not notified. The app's other clients receive fewer, later updates, each possibly carrying
the changes of several. Synced objects move less smoothly, and `broadcast::` streams have gaps.

An episode runs from the first message held back or dropped until nothing has been over the limit for a
second. One lasting a second or longer logs a warning a second in, and another at its end with the
numbers of updates held back and messages dropped. A shorter one, e.g. the main thread pausing for a
long garbage collection, logs a summary at debug level, which the default `CONSOLE_LOG_LEVEL` does not
print. If it lost updates, the summary is a warning however short the episode, and states how many were
lost. With the default settings:

| Warning | Meaning |
| --- | --- |
| `The main thread has kept falling 2000 TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) for a second now: ...` | the server as a whole receives more than it can process. Every Unity client is limited. |
| `The main thread has caught up with TCP messages again; ...` | that episode is over |
| `Unity client '<name>' (<id>, app '<app>', <address>) has been sending more than 1000 model::update and broadcast::* messages a second (CLIENT_MESSAGE_RATE_LIMIT, bursts up to CLIENT_MESSAGE_RATE_BURST=2000) for a second now. ...`, and the same starting `Web client <id> (app '<app>', <address>)` | one client is over its rate limit |
| `... is back under the message rate limit; ...`, `... disconnected while over the message rate limit; ...` | that client's episode is over |
| `The main thread was briefly 2000 TCP messages behind (TCP_INBOUND_BACKLOG_LIMIT) and has caught up; ...`, `... was briefly over the message rate limit; ...` | a short episode. A warning only if it lost updates, a debug line otherwise. |

An episode summary reads, e.g., `held back 1475 model::update(s), merged per object and dropped 12 message(s) over 2.5 s`.
If updates were lost, it adds `lost 450 model::update(s) for good` and a sentence on what that means.

The rate limit is far above normal use. Syncing 10 objects 72 times a second is 720 updates a second. It
catches runaway loops, typically code that sends every frame without a rate cap. The backlog limit is
reached when the server as a whole is overloaded. Fewer synced objects, a lower sync rate or fewer
clients per app reduce the load. Every message is relayed to every other client of the app, so the
server's work grows with the square of an app's size. Each time an app grows past
`APP_CLIENT_WARNING_THRESHOLD` clients (default 8, Unity and web together), the server logs a warning
starting with `App '<app>' now has`.

## Server messages

Besides relaying, the server uses a few channels of its own. Applications must not use these channel
names, or the app name `colibri`.

| Channel | Command | Sent | Payload |
| --- | --- | --- | --- |
| `colibri` | `protocol::accepted` | to a Socket.IO client, once it is accepted | `{ serverVersion }` |
| `colibri` | `protocol::rejected` | to a refused client, before it is disconnected | `{ reason, serverVersion, clientVersion }` |
| `colibri` | `latency` | to every Socket.IO client every 100 ms. The client sends it back unchanged. | a number to echo |
| `colibri::latency` | `update` | to every Socket.IO client, of every app, every second | `{ [clientId]: [time, ms][] }`, the round trips measured in that second |
| `colibri::clients` | `client::connected`, `client::disconnected` | to every client of the app, and the admin UI, when a client joins or leaves | `{ id, name, app }` |
| `colibri::clients` | `client::request` | by a client, to ask who is connected | the server answers with one `client::connected` per client of the requester's app, with `version` added |
| `log` | `debug`, `info`, `warn` / `warning`, `error` | by a client, to write to the server log at that level (any other command: debug) | text |

`name` is the handshake name for a TCP client and the IP address for a Socket.IO client, taken from
`X-Forwarded-For` behind a trusted proxy ([Behind a reverse proxy](https://colibri.hci.uni-konstanz.de/server/configuration#running-behind-a-reverse-proxy)).
The admin UI also uses `colibri::log` and `colibri::admin` ([Admin UI channel](#admin-ui-channel)),
and draws its latency chart from `colibri::latency`.

## Admin UI channel

The admin UI reads server data over Socket.IO on the channel `colibri::admin`, as a client of the app
`colibri`. Clients of other apps are ignored. Everything on this channel is read only. There is no
authentication, so anyone who can reach the web port can read it ([Security](https://colibri.hci.uni-konstanz.de/server/installation)).

A page sends one of three commands, each with a `topic`:

| Command | Payload | Server action |
| --- | --- | --- |
| `request` | `{ topic, request?, ...query }` | Answers once. |
| `subscribe` | `{ topic, request?, ...query }` | Answers now and then every second, until `unsubscribe` or disconnect. One subscription per topic and page: subscribing again replaces the query. Ignored for `latency`. |
| `unsubscribe` | `{ topic }`, or `{}` for every topic | Stops the answers. |

The answer comes on `colibri::admin` with the topic as its command. Its payload is the snapshot plus
`request`, the number from the request or subscribe that asked for it (`null` without one), and `at`,
the server's `Date.now()`. Times are `Date.now()` milliseconds, rates are per second over the last
second. A page may send 10 `request` and `subscribe` messages a second, bursts of 20; the server
ignores the rest. With no subscription the server builds no snapshot, and the TCP worker sends no
report. Either way, it keeps each client's latency samples of the last 125 s and its last 125 message
rates, one a second, for the histories below. A refresh skips a page whose connection is still
sending the previous one; the next replaces it.

| Topic | Query | Snapshot |
| --- | --- | --- |
| `server` | none | `{ version, build, protocolVersion, node, startedAt, uptime, settings, tls, proxyTls, tlsAtProxy, voice, counts }` |
| `clients` | none | `{ clients: ClientRow[], total, adminPages }`, at most 1000 rows |
| `models` | `{ app?, channel?, filter?, offset?, limit? }` | `{ query, channels, channelsTotal, models: ModelRow[], total, deleted, deletedTotal, tombstoneSeconds }` |
| `model` | `{ app, channel, id }` | `{ app, channel, id, found, deletedAt?, fields?, bytes?, updatedAt?, json?, truncated? }` |
| `latency` | none | `{ clients: { id, samples }[], total, medians }`, at most 1000 clients |

- **`server`:** `settings` maps the configuration variables in effect to their values: ports and hosts,
  `BASE_URL`, `VOICE_SAMPLING_RATE`, `VOICE_RECORDING`, `TCP_IDLE_TIMEOUT_SECONDS`, the load limits,
  `APP_CLIENT_WARNING_THRESHOLD`, `MODEL_TOMBSTONE_SECONDS`, `TRUSTED_PROXIES`,
  `TCP_PROXY_PROTOCOL`, `TCP_TLS_AT_PROXY` and `PROXY_TLS_ADDRESSES` (as `host:port` strings). `tls`
  is `null` without TLS, otherwise `{ names, issuer, selfSigned, validFrom, validTo, fingerprint256 }`
  of the certificate served now; never paths, key material or file contents. `proxyTls` is `null`
  without `PROXY_TLS_ADDRESSES`, empty until the first check has finished, and otherwise one
  `{ addresses, checkedAt, certificate, error }` per certificate the proxy presented, with the
  addresses that presented it, and one per address that could not be checked (`certificate`
  `null`, `error` the reason). `certificate` is the fields of `tls` plus `trusted` and `trustError`
  (OpenSSL's or Node's reason, `null` when trusted). `tlsAtProxy` is `{ web, tcp }`: `web` is `true` while a
  web client or admin page connected now, the asking page included, reached a trusted proxy over
  TLS, as `tlsAtProxy` in `clients`; `tcp` is `true` when `TCP_TLS_AT_PROXY` and `TCP_PROXY_PROTOCOL`
  are on, so the proxy terminates TLS for every `tcp` client through it, whether or not one is
  connected. `voice` is `{ listening, recording, samplingRate, clients }`.
  `counts` is `{ tcpClients, webClients, adminPages, apps, models, modelApps, modelChannels,
  deletedModels, storeApps, storeKeys }`. `uptime` is in seconds. `build` is `{ commit, dirty, builtAt }`:
  the full hash of the git commit the server was built from, whether `colibri-server` had uncommitted
  changes then, and the build time. `commit` is `null` for a build without git information, `builtAt`
  for a build that did not record it (`tsc` alone).
- **`clients`:** every client except admin UI pages. A row is
  `{ id, app, name, transport, version, tls, tlsAtProxy, address, connectedAt, latency, in, out, limit, held }`:
  `transport` is `tcp` or `web`, `address` the client's own address (from the PROXY protocol header or
  `X-Forwarded-For` behind a trusted proxy), `tls` whether its connection to this server is encrypted,
  `tlsAtProxy` whether a trusted proxy terminated its TLS: for `web`, the proxy's right-most
  `X-Forwarded-Proto` entry is `https` or `wss`, in any case; for `tcp`, its connection started with
  a PROXY protocol header from a trusted proxy and `TCP_TLS_AT_PROXY` is on (nginx's PROXY protocol
  header, version 1, does not say, and the server skips the TLS details a version 2 header can carry),
  `latency` the median round trip of the last second in ms, `in` and `out` the messages it sent and
  was sent per second (heartbeats and `colibri` latency pings not counted; `colibri::latency` is, so
  an idle web client shows about 1 out), `null` in its first second, and for every TCP client when
  the TCP worker did not answer within 1 s, `limit` the load limit holding its updates back now
  (`rate`, `backlog` or `null`) and `held` the number of objects with updates held back
  ([Inbound limits](#inbound-limits)). In the answer to a
  `request` and the first answer to a `subscribe`, each row also has `history`: `[in, out]` for each of
  the 122 s before `at`, oldest first, the rates a subscribed page would have been sent then. It is
  shorter for a client connected for less, and empty for a TCP client if the TCP worker was slow to
  answer.
- **`models`:** the synchronized models of every app, in store order (app, channel, creation).
  `app` and `channel` match exactly, `filter` is part of an id or channel name in any case. `limit` is
  1 to 200 (default 50), `total` counts all matches. A `ModelRow` is
  `{ app, channel, id, fields, bytes, updatedAt }`: `fields` is the number of top-level fields besides
  `id`, `bytes` the compact JSON size. The server measures at most 2 MiB of models a second, for all
  pages together, and a model that changed keeps its last size for up to 10 s, one of 1 MiB or more
  for up to a minute. `bytes` is `null` until a model is first measured.
  `channels` lists `{ app, channel, models, deleted }` for every app and channel, at most 500.
  `deleted` lists the newest 100 matching ids deleted within `MODEL_TOMBSTONE_SECONDS`, as
  `{ app, channel, id, deletedAt }`.
- **`model`:** one model's value as JSON indented by two spaces, cut to 512 KiB with `truncated: true`.
  `bytes` is as in a `ModelRow`. A model the server does not hold has `found: false`, and `deletedAt`
  if it was deleted within `MODEL_TOMBSTONE_SECONDS`.
- **`latency`:** request only. Each client's round trips of the 122 s before `at`, as in the
  `colibri::latency` updates: `samples` is `[time, ms]` pairs, oldest first, `time` the server's
  `Date.now()` and `ms` rounded to 0.01. Samples taken at `at` itself are left out. They come with the
  next `colibri::latency` update, like all newer ones, so a page drops an update's samples from before
  `at` and has each sample once. Clients and order as in `clients`, the first 1000 of `total`. Over
  200,000 samples in all, `medians` is `true`: a client has one pair per second instead, the median of
  that second's samples at their mean time, at most 123.

Names longer than 512 characters are cut, and their row has `truncated: true`; such a model cannot be
looked up with `model`. The `app`, `channel` and `id` of a query are cut to 513 characters, so a
longer one matches nothing.

The admin log's `requestLog` (`colibri::log`) takes `showConnections`, default `true`. With `false`, the
server leaves out the routine connect and disconnect lines, which carry `metadata.connection: true`.
Warnings and errors about connections are not tagged. The `history` answer carries `at`, the server's
`Date.now()`, the clock that stamps the lines.

## Model synchronization

colibri-unity's `SyncBehaviour` and colibri-web's `RegisterModelSync` keep shared objects (models) in
sync with three commands on the model's channel, named after the model type:

- colibri-unity: the class name in lower case, plus `_<ModelId>` if the `ModelId` field is set.
- colibri-web: the registration's `name`, or else the class name in lower case. A minifying build
  changes class names, so pass `name`.

A Unity and a web client sync with each other only if the channel names match.

| Command | Payload | Server action |
| --- | --- | --- |
| `model::update` | an object with a string `id`, plus the changed fields (or all of them) | Merges it into its copy: each field sent replaces the stored one, fields not sent are kept. Relays the message unchanged to every other client of the app. Past an [inbound limit](#inbound-limits), first merges it with the sender's later updates. Without a string `id`, logs an error and drops it. For an id deleted a moment ago, does neither ([Deleted models](#deleted-models)). |
| `model::delete` | `{ "id": "…" }` | Removes its copy, remembers for a while that the id was deleted ([Deleted models](#deleted-models)), and relays the message to every other client of the app. Without an `id`, logs a warning and drops it. |
| `model::request` | `{ "id": "…" }` for one model, optionally with `"again": true`. Anything without a string `id` (`null`, `{}`) for all of them. | Answers the requester only ([Requests](#requests)). |

The merge is shallow: a nested object in an update replaces the stored one as a whole.

The server keeps the models per app and channel, in memory only. It clears an app's models when the
app's last client disconnects, and has none after a restart. Only the [REST store](#rest-store)
persists.

### Requests

A `model::request` has three forms. Fields other than `id` and `again` are ignored.

| Payload | Meaning | Answer, to the requester only |
| --- | --- | --- |
| none, `null`, `{}`, or anything else without a string `id` | send every model of this channel | one `model::update` per model on that channel |
| `{ "id": "…" }`, a **fresh request** | the sender has this object in its scene now, or is creating it | one `model::update` with the model, or with the bare `{ "id": "…" }` if the server has no model for the id. For an id deleted a moment ago, the server first forgets the delete: the id is in use again. |
| `{ "id": "…", "again": true }`, a **re-request** | the sender held this object before an outage and asks again after reconnecting | as for a fresh request, except for an id deleted a moment ago: `model::delete` `{ "id": "…" }`, and the delete stays remembered |

`again` must be the JSON value `true`. Any other value makes the request a fresh one.

A **bare `{ "id": "…" }`** means the server has no model for that id. The requester then sends its
full state as a `model::update`, which creates the model on the server and reaches the other clients.
If the server has the model, its values win. colibri-web then sends on top of them the changes made
while it waited for that answer, since `registerModel` or since the connection dropped. colibri-unity
does the same with the members a `SyncBehaviour` changed since `Awake`.

How the clients use the three forms:

- **colibri-unity.** A `SyncBehaviourManager`, and a `Sync.AddModelUpdateListener` without an id,
  request the whole channel. A `SyncBehaviour` placed in a scene or created on this client sends a fresh
  request for its id in `Awake`. A copy that a `SyncBehaviourManager` builds because another client
  created the object sends none. It is not this client's object, and a fresh request would bring back
  one deleted a moment ago. After a reconnect, every object is re-requested by id and every channel a
  manager listens on is requested again, followed by an [end marker](#end-marker). An object whose
  first answer arrives after it changed its own members also sends an end marker, ahead of those
  members, unless that answer comes in the round after a reconnect.
- **colibri-web.**
  - `registerModel` sends a fresh request. `RegisterModelSync` requests the whole channel once the
    models registered by then have their answers.
  - After a reconnect, each registered model the server had answered for is re-requested by id,
    followed by an [end marker](#end-marker). A model registered while the connection was down gets a
    fresh request.
  - A registered model is requested once more, with `again: true`, followed by an end marker, when the
    changes made while it waited replaced values the server had. When that answer is in, the last value
    an update showed for a sent field is the server's:
    - The sent value: nothing happens.
    - Another client's value: applied.
    - The replaced value: the update has not arrived yet, because the server holds back updates of a
      client over its rate limit, never a request. The field is sent again.

    Changes made meanwhile go out without another request.
  - The whole channel is requested once all of these answers are in, followed by an end marker.
  - An end marker also follows the first update with fields after a fresh request for a registered
    model, unless the model or the whole channel is requested next. That update may be another
    client's, or the answer for the whole channel, with the model's own answer still to come.
  - A field sent while one of these requests is unanswered is kept out of every incoming update until
    the answer to the last request sent before it. Whatever arrives before then predates the server
    having that field.

#### End marker

On the wire, an answer is an ordinary `model::update`, like an update relayed from another client
meanwhile. After a reconnect, and in the other cases listed per client, a client therefore sends one
more request after the others, `{ "id": "<fresh id>", "again": true }` on the channel
`colibri::reconnect`, where Colibri never stores a model. The server answers with the bare id, like any
other, and the client takes that answer as the end of the answers to its earlier requests.

- colibri-unity sends one after every reconnect, with a GUID as the id, and another when an object's
  first answer arrives outside that round after the object changed its own members. That one goes out
  ahead of those members, and until its answer the object keeps them over whatever arrives, including
  the answer to a manager's request for the whole channel, since all of that predates the server
  reading them. colibri-unity also takes the marker after a reconnect as the point by which the server
  has read everything it queued before, including the deletes it sent again
  ([After a reconnect](#after-a-reconnect)). It passes nothing on that channel to application listeners.
- colibri-web sends one per `RegisterModelSync` that re-requested a model, one after each request for
  the whole channel, one each time it requests a model once more, and one after the first update with
  fields that follows a fresh request when it does neither (see above).

The server has no code for this. The marker relies on the server handling one client's messages in
arrival order and writing its answers to that client in the same order. Server changes must keep both
properties. The bare id then follows the answers to all earlier requests. A server that answered one
client's requests out of order would mark the end too early.

### Deleted models

Each `model::delete` leaves a tombstone. For `MODEL_TOMBSTONE_SECONDS` (default 600 s), the server
remembers per app and channel that the id was deleted. Meanwhile:

- **Updates for it are ignored:** neither stored nor relayed, with a debug line. Otherwise an update
  another client sent before the delete reached it, one held back under an
  [inbound limit](#inbound-limits), or one a client queued while offline would create the object again,
  on the server and on every client.
- **A re-request is answered with `model::delete`**, to the requester only, and the tombstone stays. A
  client that missed the relayed delete removes its copy, instead of keeping one nobody else has, or
  sending it to everyone again.
- **A fresh request lifts the tombstone** and is answered with the bare id. The requester has the object
  in its scene again, e.g. a scene with placed objects of fixed ids, unloaded and loaded again by the
  same client or another one. The full state it sends next is stored and relayed as usual.

A tombstone also expires after `MODEL_TOMBSTONE_SECONDS`, and is cleared with the app's models once
the app's last client has left. An app keeps at most 10,000, the oldest going first. With
`MODEL_TOMBSTONE_SECONDS=0` the server keeps none. A re-request for a deleted id is then answered with
the bare id, the requester sends the object again, and it comes back for everyone.

A tombstone cannot stop an update the server relayed before the delete arrived, e.g. one another client
sent a moment earlier, still on its way to the client that deleted the object. That client must ignore
`model::update` for a deleted id for a while itself, as colibri-unity does for a minute. Otherwise the
update builds the object again on that client, and from there it can come back for everyone.

### After a reconnect

Both clients request the models again after every reconnect ([Requests](#requests)) and handle each
answer for an object they hold:

- **The model:** applied, so changes other clients made during the outage arrive, unless the answer
  shows that the client's own last change was lost.
- **The bare id:** the server has no model any more, after a restart or because the app's last client
  had left, as happens when an app's only client loses its connection. The client sends its full state
  again, so the model is back on the server for clients that join later.
- **`model::delete`:** another client deleted the object during the outage. The client removes its
  copy.

colibri-unity sends these requests at once, behind the messages it queued during the outage, so an object
changed meanwhile may not be sent in full ([Known limits](#known-limits)). colibri-web holds such changes
back until the model's answer has arrived. It requests the whole channel only once all of its own models
have their answers, so that this answer includes what it sent in between.

**Changes lost at the drop.** A connection that dies without closing, e.g. when the Wi-Fi drops out, is
detected only later: by colibri-unity after 2 s without a heartbeat, by Socket.IO after its ping
timeout, within 45 s with the server's defaults. What a client sends until then is lost, and the answer
has the old value. Applying it would undo a change no other client ever saw. Both clients therefore
compare the answer with what they sent.

- **colibri-unity**
  - For each `[Sync]` member, it keeps the latest 8 values sent up to the last frame it received from
    the server, the first 8 sent after, and the newest. The server sends a heartbeat every 100 ms, so
    the link died shortly after that frame, and the server's value was sent around then. What the next
    connection receives before the re-requests go out does not count.
  - From its re-request until the end of the answers, these stay fixed. Of what the member sends
    meanwhile, only the newest is kept as well, since no answer can hold it.
  - It also keeps the member's value before those. That is the last value dropped from this list, or
    the last value received from the server, in another client's update or in an answer.
  - Everything received for an object from its re-request until the end of the answers
    ([End marker](#end-marker)), other clients' updates included, is compared member by member with
    the values the member held from 10 s before the client noticed the outage: those sent since, and
    the one held at that point.
    - The value sent last: nothing happens.
    - An earlier one: the last change was lost. The member keeps its value, sends it again once in an
      ordinary update, and takes nothing more until the answers end. A member changed after the
      re-requests does the same whatever arrives, because the server reads that change after
      everything that arrives before the end of the answers.
    - Any other value: applied, as is everything for a member that sent nothing in those 10 s.

    A member missing from an update is left alone. An object that has never sent anything applies
    everything.
  - On noticing the outage, it sends again every `model::delete` sent after the last frame it received
    from the server or in the second before, unless the delete is 60 s old or older. The connection
    holds them for the next session, ahead of the re-requests. If the connection drops again before
    the end of the answers, it sends them once more, however old, with every `model::delete` sent
    since it noticed the outage, except for ids it has requested afresh since.
- **colibri-web** compares everything received for a registered model from its re-request until the
  end of the answers, other clients' updates included, field by field with the last value received
  from the server and the values sent since. Of these it keeps the latest 8 up to the last message it
  received from the server, the first 8 after, and the newest. The server's latency message arrives
  every 100 ms, so the connection failed shortly after that message, and the server's value was sent
  around then.
  - An earlier value that the field still had in the 10 s before that message means the last change
    was lost. The field keeps its value and takes nothing more until the answers end. Its local value
    then goes out again in one `model::update` with the changes held back since the outage, followed
    by another request with `again: true`.
  - Any other value is applied. A field missing from an update is left alone.

Both clients keep the answer's value for a lost member or field as the server's. If the connection drops
again before the answers to a reconnect are in, they judge from the earlier outage, so a value sent again
and lost in a second drop soon after is still recognised.

## REST store

A key-value store over HTTP on the web port, separate from the model store. Values are kept per app in
`store.db`, an SQLite database in the data directory (`DATA_ROOT`), and survive restarts. A value not
written for `STORE_EXPIRY_DAYS` (30) is deleted. colibri-unity's `Store` and
colibri-web's `getRestObject` / `setRestObject` use it.

Values travel as JSON in the media type `application/vnd.colibri.v2+json` (`REST_MEDIA_TYPE` in
[`protocol.ts`](../../src/server/modules/protocol/protocol.ts)), which names the protocol version like the
handshake's `version`:

- **Request bodies:** a `PUT` must send its value with `Content-Type: application/vnd.colibri.v2+json`.
  Any other `Content-Type`, `application/json` and form data included, gets `415` and stores nothing.
- **Responses:** every answer under `/api`, errors included, is `application/vnd.colibri.v2+json`
  (Express adds `; charset=utf-8`).
- **`Accept`:** a request whose `Accept` leaves that type out, e.g. `Accept: application/json`, gets
  `406`. No `Accept`, `*/*` and `application/*` take it, so curl and a browser can read the store. Both
  clients send `Accept: application/vnd.colibri.v2+json`.

```sh
curl -X PUT -H 'Content-Type: application/vnd.colibri.v2+json' -d '{"x":1}' http://localhost:9211/api/store/app/name
curl http://localhost:9211/api/store/app/name
```

| Request | Response |
| --- | --- |
| `GET /api/store` | `200` with the app names, `["app1", …]`, sorted |
| `GET /api/store/:app` | `200` with the value names of that app, sorted. `404` if the app has no value. |
| `GET /api/store/:app/:name` | `200` with the stored JSON value. `404` if there is none. |
| `PUT /api/store/:app/:name` | Stores the request body, any JSON value (object, array, number, string, `true`, `null`), sent as `Content-Type: application/vnd.colibri.v2+json`, up to 5 MiB. `201` if new, `200` if it replaced a value, each with `{ "result": "…", "data": <the value> }`. `400`, storing nothing, for malformed JSON, no body or an empty one. `415` for any other `Content-Type`. `413` for a body over 5 MiB. `507` when the store would go above `STORE_MAX_MB`. |
| `DELETE /api/store/:app` | `200`, and every value of the app is gone. `404` if the app has no value. |
| `DELETE /api/store/:app/:name` | `200`. `404` if there is no such value. |

Any other request under `/api`, e.g. a `POST`, or a `PUT` without a value name, returns `404`. Errors
are `{ "error": "…" }`, never with a stack trace. Any app or value name is allowed, `__proto__`
and `constructor` included. Each name is one path segment, so a name with `/`, `#`, `?`, `%` or a space
must be percent-encoded, as `encodeURIComponent` does. colibri-web and colibri-unity's `Store` encode
both names, so the two address the same values. Only `.` and `..` cannot be reached, since a URL
resolves them as a path step, encoded or not. Every response allows any origin (CORS), so a page served
from elsewhere can use the store too.

Each write is committed to `store.db` before it is answered. Names are sorted by their UTF-8 bytes
(SQLite's `BINARY` order), so upper case comes before lower case.

## Voice packets (UDP)

colibri-unity's voice chat sends each audio frame to the voice port (`VOICE_PORT`, UDP 9213) as one
datagram: an 11-byte header, then the audio. All integers are little-endian.

The voice port takes IPv6 and IPv4 with `VOICE_HOST=::`, the default, and IPv4 only with
`VOICE_HOST=0.0.0.0`. The log names an IPv4 client by its IPv4 address on either. Another IPv6
`VOICE_HOST` takes only that address.
colibri-unity sends to an IPv4 address of the server when the server address has one, and to an
IPv6 address only when it has none.

```
[i16 userId][i16 sequence][i16 frameSize][u8 version and codec][u32 appId][data]
```

| Offset | Size | Field |
| --- | --- | --- |
| 0 | 2 | `userId`: the sender's voice id. Receivers do not play `0`. |
| 2 | 2 | `sequence`: colibri-unity sends `0` |
| 4 | 2 | `frameSize`: samples in the frame, at the voice sampling rate (`VOICE_SAMPLING_RATE`, default 48000) |
| 6 | 1 | version and codec: header version `2` in the high 4 bits, codec in the low 4 bits, `0` for PCM and `1` for Opus |
| 7 | 4 | `appId`: the app id of the sender's app |
| 11 | rest | PCM: mono `i16` samples. Opus: one Opus packet. |

The codec is per packet. colibri-unity sends a frame that Opus fails to encode as PCM, so one
client's packets can mix both.

`appId` is the 32-bit FNV-1a hash of the app name's UTF-8 bytes: start with `0x811c9dc5`, then for each
byte XOR it in and multiply by `0x01000193`, modulo 2^32. The empty name hashes to `0x811c9dc5`, `a` to
`0xe40c292c`. colibri-unity hashes the app name its TCP handshake sends: the *App Name* of its Colibri
configuration, with `::` and a `:` at either end replaced by `_` (`VoicePacketCodec.AppId`). The
server's implementation is `voiceAppId` in `src/server/modules/voice/voice-packet.ts`.

The server accepts a valid packet only from the address of a Unity client of its app, connected on
the TCP port. An IPv4-mapped IPv6 address (`::ffff:192.0.2.1`) counts as the IPv4 address it maps.
It registers at most as many voice clients of an app from one address as there are Unity clients of
that app connected from it. A new sender beyond that takes the place of the voice client that has
gone the longest without a packet, if that is 500 ms or more, and is dropped otherwise. From an
address in `TRUSTED_PROXIES` it accepts every valid packet, without that limit: through a proxy, all
of them come from the proxy's address ([guide](https://colibri.hci.uni-konstanz.de/server/configuration#voice-chat)).

The server registers the sender of an accepted packet as a voice client, by address and port, and
passes the packet on unchanged to every other voice client with the same `appId`. A client sending
another `appId` from the same address and port moves to that app, if a packet for it is accepted. A
client is dropped after 2 to 3 s without a packet, so it hears voice only while it sends voice itself,
as colibri-unity's `VoiceBroadcast` does while broadcasting. It is dropped at once when the last Unity
client of its app at its address disconnects, unless it came from a trusted proxy. When one of
several disconnects, the voice clients at that address over the number left are dropped 0.5 to 1.5 s
later, the one that has gone the longest without a packet first. With `VOICE_RECORDING=true`, the
server also saves the samples of each client's PCM packets as a `.wav` file in the data directory,
named after the time of the client's first packet (UTC), its app id, its voice id and its source
port: `rec_2026-10-09T11_07_58.502Z_app_0xe40c292c_ID_1_port_52114.wav`.

The server drops these packets, reporting at most one per source address and port every 10 s:

| Packet | Log |
| --- | --- |
| header version `0`: a Colibri 1.x client, whose 7-byte header has no `appId` and has the codec, `0` or `1`, at offset 6 | warning `Ignoring voice packet from <address>:<port>: it looks like a Colibri 1.x client ...`, which says to upgrade the Unity package to 2.x |
| a header version other than `0` and `2` | error `Ignoring malformed voice packet from <address>:<port>: its header version is <n>, not 2` |
| shorter than the 11-byte header | error `Ignoring malformed voice packet from <address>:<port>: <n> bytes is shorter than the 11-byte header` |
| from source port 0 | error `Ignoring malformed voice packet from <address>:<port>: its source port is 0, ...` |
| from an address without a Unity client of its app | warning `Ignoring voice packet from <address>:<port> for app <app id>: no Unity client of that app is connected from <address>`, once the source's packets have been dropped for 3 s; a debug line for its first one |
| from a new sender at an address with as many voice clients of its app as Unity clients, none of them quiet for 500 ms | warning `Ignoring voice packet from <address>:<port> for app <app id>: <address> has <n> Unity client(s) of that app, and as many voice clients already`, once the source's packets have been dropped for 3 s; a debug line for its first one |

The app id keeps the voice of different apps apart, as the app name does on TCP. It is not access
control. Anyone who knows an app's name and can reach the TCP port can join the app, and send voice to
its clients and receive theirs. Two app names can have the same app id, by chance about 1 in 4 billion
for any two, and their voice clients then hear each other. Voice is never encrypted. [TLS](#tls)
covers only the TCP and web ports.

## Known limits

**A reconnect catches up on deletions only for a while.** A model deleted while a client was away is
removed from it if its re-request ([After a reconnect](#after-a-reconnect)) reaches the server within
`MODEL_TOMBSTONE_SECONDS` of the delete. Later, the re-request is answered with the bare id, the client
sends the model again, and it comes back for everyone. colibri-web re-requests only the models it
registered itself. A model it got from another client, deleted while it was away, stays in its list,
since the answer for the whole channel lists only the models that exist.

**A forgotten model comes back in full only from a client that sends it again after reconnecting.**
colibri-web sends the models it registered, colibri-unity each synced object the server answers with
the bare id. Until then, a change to the model creates it with only the changed fields. This includes a
colibri-unity object that changed while the client was offline. The update with only the changed members
goes out ahead of the request, so the server has those members when it answers, answers with them
instead of the bare id, and the full state is not sent. The other fields reach the server only when
they change. A client joining meanwhile has its own starting values for them: the template's, or for an
object placed in the scene, the scene's.

**Lost changes are detected by value only** ([After a reconnect](#after-a-reconnect)):

- Another client that sets a member or field back during the outage, to a value the reconnecting client
  had in the 10 s before the outage, looks like a lost change, and the reconnecting client sends its
  own value over it. Both clients judge every update arriving before the end of the answers this way,
  even one another client made after the reconnect.
- Both clients may miss a member or field that changed more than about 8 times within 100 ms of the
  last frame or message they received from the server. For colibri-unity, that takes a send-rate limit
  above about 80 updates a second.
- colibri-unity may miss a member that changed more than once between a reconnect and a second drop
  before the end of the answers. It does not send again a member whose very first value was lost,
  since it held nothing before it.
- colibri-web checks only the models it registered. It sends again a field it sent on top of an answer
  when the answer to the repeated request still holds the replaced value ([Requests](#requests)), even
  if another client set it back in that round trip.
- A value sent again can cross a change another client makes right after the answers, like any two
  simultaneous changes.
- A `model::delete` colibri-unity sends again after an outage also removes an object another client has
  created under the same id since, as a delete sent during the outage does.

**No authentication.** Any client that can reach the server can join any app under any name, read and
change its models and its REST store, and send and receive its voice. The version check is not access
control. Run Colibri on a trusted local network.
