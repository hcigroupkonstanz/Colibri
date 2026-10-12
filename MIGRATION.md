# Upgrading to Colibri 2.0

Changelogs with full details: [server](colibri-server/docs/v2-changelog.md),
[web](colibri-web/CHANGELOG.md), [Unity](colibri-unity/CHANGELOG.md).

## Checklist

**Upgrade the server first, then Unity, then the web clients** ([upgrade order](#upgrade-order)).
No 1.x client, Unity or web, works with a 2.0 server.

- [ ] [New default ports 9211, 9212 and 9213](#default-ports): update the server's firewall, proxy
      and port mappings, the ports in each Unity project and the web clients' server URLs, or keep
      9011 to 9013 on the server

**Server**

- [ ] [Node 24, native ESM](#breaking)
- [ ] [Port your own TCP clients to the new protocol](#breaking)
- [ ] [Port your own voice code to the new packet format](#breaking)
- [ ] [Voice through a UDP proxy: add the proxy to `TRUSTED_PROXIES`, or publish 9213/udp
      directly](#breaking)
- [ ] [Docker: pin the image version](#other-changes)
- [ ] [Docker: remove `tty: true` from a compose file based on the 1.x README](#other-changes)
- [ ] [Docker with `--user` (or `user:` in compose): give the data directory to that
      user](#other-changes)

**Web**

- [ ] [`npm install @hcikn/colibri@^2`](#upgrade-order). A 2.0 server refuses 1.x web clients,
      which show no error.
- [ ] [TypeScript 5.0 or newer](#breaking-typescript-and-rxjs). Plain JavaScript:
      [unsupported workaround](colibri-web/docs/js-workaround/README.md)
- [ ] [Add `rxjs` to your dependencies](#breaking-typescript-and-rxjs)
- [ ] [`@Synced() private x = 0` becomes `@Synced() accessor x = 0`, without
      `experimentalDecorators`](#breaking-synced-needs-standard-decorators)
- [ ] [Colour callbacks get a `ColorValue`, not a
      `string`](#breaking-colour-callbacks-get-a-colorvalue)
- [ ] [Pass `name` to `RegisterModelSync` in bundled code](#fixed)

**Unity**

- [ ] [Unity 2022.3 LTS or newer](#breaking-unity-20223-lts)
- [ ] [Delete your vendored `Newtonsoft.Json.dll`](#breaking-newtonsoftjson-is-a-package-dependency)
- [ ] [Replace `IObservable` subscriptions with `+=` and `-=`, and unsubscribe
      yourself](#breaking-unirx-removed)
- [ ] [Replace `Connected.Subscribe(...)` with `OnConnected` and
      `OnDisconnected`](#breaking-webserverconnectionconnected-is-a-task)
- [ ] [Port `ObservableModel<T>` and `ObservableManager<T>` to `SyncBehaviour<T>` and
      `SyncBehaviourManager<T>`](#breaking-observablemodelt-and-observablemanagert-removed)
- [ ] [Import the samples your code uses](#breaking-samples-are-not-compiled-into-your-project)
- [ ] [Replace `LockFreeQueue<T>` with `ConcurrentQueue<T>`](#breaking-lockfreequeue-removed)
- [ ] [With *Server supports SSL/TLS?* ticked, enable TLS on the server's TCP port too](#tls)

**All components**

- [ ] Read [Behaviour changes that still compile](#behaviour-changes-that-still-compile)
- [ ] Do the [post-upgrade checks](#post-upgrade-checks)

---

## Default ports

2.0 moves the default ports from 9011 (web: admin UI, web clients, REST store), 9012 (Unity TCP) and
9013 (voice, UDP) to 9211, 9212 and 9213. A 1.x and a 2.0 server can then run side by side, and a
client does not reach a server of the other version by its defaults. `WEBSERVER_PORT`, `TCP_PORT`
and `VOICE_PORT` still set them.

- **Server:** update firewall rules, reverse proxy configuration and compose port mappings. To keep
  the old ports, set `WEBSERVER_PORT=9011`, `TCP_PORT=9012` and `VOICE_PORT=9013`, or with Docker
  publish 9011 to 9013 on the new container ports
  ([settings and ports](colibri-server/docs/guide.md#settings-and-ports)).
- **Unity:** a project keeps the ports saved in its Colibri configuration, 9011 to 9013 from 1.x.
  Set 9211, 9212 and 9213 in *Window → Colibri Configuration*, unless the server keeps the old
  ports.
- **Web:** update the server URL. Without a port in the address or as the third argument,
  colibri-web 2.0 connects to 9211.

---

## Upgrade order

Upgrade the server first, then Unity, then the web clients.

colibri-unity 2.0.0 uses a [new binary TCP protocol](colibri-server/docs/protocol.md) and **requires
colibri-server 2.0.0 or newer**. There is no version negotiation, so upgrade both together.

From then on, the server log names every client still on 1.x. The log is on the admin UI's log page
and, since 2.0, in the console output (`docker logs` for a container).

| Client | Server behaviour | Client symptom |
| --- | --- | --- |
| Unity 1.x | Cannot read the handshake, so it cannot check the version or reply. Recognizes the 1.x wire format. Logs a warning with the client's address and the fix (upgrade the Colibri Unity package `de.uni.kn.colibri` to 2.x), at most once a minute per address. | No reason given. A 1.3.1 client typically shows no error. |
| Readable handshake, other protocol version | Refuses the client, logs it with both versions, and sends the reason on the `colibri` channel. | A 2.0.0 Unity client logs the reason, shows it in `Window → Colibri Status` and stops reconnecting. |
| colibri-web 1.x | Refuses it, since it announces `version: '1'` in the handshake query. Logs the client, its address and both versions. | No 1.x release (the last is 1.3.2) handles `protocol::rejected`. The rejection arrives as an ordinary message on `colibri.messages`, which nothing listens to. Socket.IO does not reconnect after a server-side disconnect. **The client connects once and stops, with no error.** |

This refusal is the only protocol break for web clients. The Socket.IO envelope did not change.
colibri-web 2.0.0 logs a refusal and reports it on `colibri.protocolMismatch`. See
[Version checking](colibri-server/docs/protocol.md#version-checking).

**Clients upgraded first** can only suspect an old server, since a 1.x server has no version check.
A 2.0.0 or newer server announces itself to web clients on connect.

- A 2.0 web client warns if that announcement is missing after 5 seconds, and **stays
  connected**. The connection works, since the Socket.IO envelope did not change (verified against
  real 1.1.1 and 1.3.1 servers, with traffic in both directions).
- A 2.0 Unity client cannot connect to a 1.x server. After three connections in a row that were
  accepted and ended before a frame could be read, it reports a likely protocol mismatch and keeps
  retrying.

Details:
[Detecting an out-of-date server](colibri-server/docs/protocol.md#detecting-an-out-of-date-server).

---

## colibri-server

### Breaking

**Node 24.** The runtime moved from `node:20-alpine` (end of life) to `node:24-alpine`. `src/server`
is native ESM: `"type": "module"`, explicit `.js` import extensions, no `__filename`. In a fork or
patched server, this touches every file.

**v3 TCP protocol.** A fixed binary format replaces the FlatBuffers framing with its ASCII length
header:

```
[u32 LE totalLength][u8 type][body]        totalLength = 1 (type) + body.length
  0x00 heartbeat   [u64 LE pingTimestamp]
  0x01 handshake   utf8 "version::app::name"
  0x02 message     [u16 LE channelLen][channel][u16 LE commandLen][command][payload bytes]
```

Port your own TCP clients using [`docs/protocol.md`](colibri-server/docs/protocol.md). Socket.IO
clients are not affected. For TCP clients:

- The server sends nothing, not even a heartbeat, before it accepts the handshake. Send the
  handshake first. A refused client receives only the refusal.
- The server disconnects a TCP client that sends nothing for 10 seconds
  (`TCP_IDLE_TIMEOUT_SECONDS`), including one that never sends a handshake. Echoing every heartbeat,
  as colibri-unity does, stays well within this.

**Voice packet format.** The header grew to 11 bytes: the 7 bytes of 1.x, with a header version in
the high 4 bits of the codec byte, then an app id, the 32-bit FNV-1a hash of the app name. The
server forwards a packet only to voice clients with the same app id, and accepts one only from the
address of a TCP client connected with that app, one voice sender (source port) per such TCP client.
It drops 1.x voice packets, which have no app id, and logs a warning with the client's address.
Colibri 1.x voice clients therefore work neither with a 2.0 server nor with 2.0 clients. Port your
own voice code to
[Voice packets](colibri-server/docs/protocol.md#voice-packets-udp).

**Voice from another address than the TCP connection.** In 1.x the server relayed voice from any
address. Voice that reaches it through a UDP proxy, or from another address than the client's TCP
connection, is now dropped. Once that has gone on for 3 s, the server logs `Ignoring voice packet
from <address>:<port> for app <app id>: no Unity client of that app is connected from <address>`.
Add the proxy to `TRUSTED_PROXIES`, or publish 9213/udp directly
([Voice relay](colibri-server/docs/guide.md#voice-relay)). colibri-unity 2.0 connects over IPv4 when
the server name has an IPv4 address, as 1.x did, and sends voice there too. If that address does not
answer on the TCP port while the name's IPv6 address does, TCP falls back to IPv6 and the voice is
dropped.

**Removed dependencies:** `flatbuffers`, `body-parser`, `uuid` and `source-map-support`.

### Other changes

**Pin the image version.** Untagged, `hcikn/colibri` means `latest`. The next pull can move a 1.x
server to 2.x and cut off every 1.x client. Change the pinned version when you upgrade the clients.

**Multi-stage image.** The image ships only `dist/` and production dependencies, sets
`NODE_ENV=production` and has a `HEALTHCHECK` on the web port. It starts `node` directly instead of
`npm start`, so the server is PID 1 and shuts down cleanly on `docker stop`.

**Non-root server.** The container starts as root only to hand `/srv/colibri/data` to the image's
`node` user (uid 1000), then runs the server as `node`. A `./data` created by Docker, or the
root-owned one from 1.x, works without manual steps, but on the host it now belongs to uid 1000.
Only this directory is handed over, so mount your data there rather than pointing `DATA_ROOT`
elsewhere.

- With `docker run --user …` (or `user:` in compose), the container cannot change ownership. Give
  the data directory to that user first, for example `sudo chown -R 1001:1001 ./data` for
  `--user 1001:1001`. A new named volume belongs to uid 1000, so it works unchanged only with
  `--user 1000:1000`.
- If the server cannot write its data directory, it prints the problem and the fix on stderr at
  startup and keeps running without saving anything.

**Console log.** In 1.x, the server log appeared only on the admin UI's log page. It now also goes
to stdout, with errors and warnings on stderr, and so to `docker logs`. This includes the refusals,
the 1.x client warning, and the lines clients send through Unity's `[RemoteLogger]` prefab or
colibri-web's `RemoteLogger`.

- The bundled `docker-compose.yml` caps the container log at five files of 10 MB.
- Remove `tty: true` from a compose file based on the 1.x README. With a TTY, `docker logs` has no
  stderr, and warnings and errors are mixed into stdout with CRLF line endings.

**New settings**, described in [`.env.example`](colibri-server/.env.example):

| Variable | Default | Description |
| --- | --- | --- |
| `CONSOLE_LOG_LEVEL` | `info` | Least severe level printed: `error`, `warn`, `info` or `debug`. |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | Print broadcast traffic. |
| `CLIENT_MESSAGE_RATE_LIMIT` | `1000` | Broadcasts and model updates a second per client, Unity or web. Above it, broadcasts are dropped, and model updates are held back and merged per object, so the latest value of every field still arrives. `0`: no limit. |
| `CLIENT_MESSAGE_RATE_BURST` | `2000` | Burst size of the rate limit. |
| `TCP_INBOUND_BACKLOG_LIMIT` | `2000` | Messages from Unity clients that may wait for the server's main thread. Beyond it, their broadcasts are dropped and model updates held back, as with the rate limit. `0`: no limit. |
| `TCP_IDLE_TIMEOUT_SECONDS` | `10` | Disconnect a Unity client that sends nothing for this long. `0`: never. |
| `APP_CLIENT_WARNING_THRESHOLD` | `8` | Log a warning when an app has more clients than this. `0`: never. |
| `MODEL_TOMBSTONE_SECONDS` | `600` | How long the server remembers a deleted model. `0`: not at all. |
| `TRUSTED_PROXIES` | empty | Reverse proxies trusted to report the client's address, from `X-Forwarded-For` or a PROXY protocol header, and whether a web client used HTTPS, from `X-Forwarded-Proto`. Voice from them is relayed without the address check. |
| `TCP_PROXY_PROTOCOL` | `false` | `true`: a TCP connection from a trusted proxy must start with a PROXY protocol header. |
| `TCP_TLS_AT_PROXY` | `false` | `true`: the proxy's TCP port terminates TLS, so without a certificate the admin UI shows TLS terminated by proxy for Unity clients through it. Needs `TCP_PROXY_PROTOCOL`. |
| `TLS_CERT`, `TLS_KEY` | empty | Certificate and key for [TLS](#tls) on the TCP and web ports. |

- A headset that leaves the Wi-Fi or goes to sleep does not close its connection. In 1.x, without
  the idle timeout, it counted as connected and kept its app's synced objects alive until the
  operating system dropped the connection many minutes later.
- The server's work grows with the square of an app's size, since every message goes to each of the
  app's other clients. A large app usually means that several projects on one server use the same
  app name, such as `test` or one from an example.
- Dropping or holding back that lasts a second logs one warning at that point and one summary with
  the counts when it ends. For the rate limit, the warning names the client. A shorter stretch logs
  only a debug line, unless it lost model updates.
- One client can have updates held back for at most 1000 objects. An update for one more is lost and
  logged as a warning, however short the stretch.
- The default rate limit is far above typical traffic. Ten objects sending in every frame at 72 Hz
  make 720 updates a second.

**Deleted models.** For `MODEL_TOMBSTONE_SECONDS`, the server ignores updates for a deleted id, so
an update another client sent before it received the delete no longer brings the object back for
everyone. A client that asks for the object again after a reconnect is told to delete its copy.
colibri-unity and colibri-web 2.x handle this. A custom protocol client must send:

- `model::request { id }` for an object it has in its scene or is creating. This lifts the
  tombstone. Without it, updates for an id deleted a moment ago are ignored.
- `{ id, again: true }` when it asks again after a reconnect for an object it held before.

See [Deleted models](colibri-server/docs/protocol.md#deleted-models).

**Voice recording file name** (`VOICE_RECORDING=true`):
`rec_<start time>_app_<app id>_ID_<voice id>_port_<source port>.wav` instead of
`rec_<start time>_ID_<voice id>.wav`. Update anything that finds recordings by name. See
[Voice packets](colibri-server/docs/protocol.md#voice-packets-udp).

---

## colibri-web

### Breaking: `@Synced()` needs standard decorators

`@Synced()` uses TypeScript's standard TC39 `accessor` decorators instead of the legacy
`experimentalDecorators` ones. Remove `experimentalDecorators` from `tsconfig.json`, and make every
synced member an `accessor`:

```ts
// 1.x
class Player extends SyncModel<Player> {
    @Synced() private age = 0;
}

// 2.0
class Player extends SyncModel<Player> {
    @Synced() accessor age = 0;
}
```

This also fixes field synchronization in frameworks that re-create instances, such as React. It
never worked correctly with the legacy decorator.

### Breaking: TypeScript and `rxjs`

Colibri targets TypeScript 5.0 or newer. The plain JavaScript sample ports were removed. Plain
JavaScript: [unsupported workaround](colibri-web/docs/js-workaround/README.md).

`rxjs` is now a **peer dependency**, because its types are part of the public API (`SyncModel`,
`RegisterModelSync`, `Colibri.messages`):

```sh
npm install rxjs
```

### Breaking: colour callbacks get a `ColorValue`

A colour arrives from Unity as the string `"#RRGGBBAA"` and from another web client as an
`[r, g, b, a]` array. 1.x typed the `receiveColor` callback as `string` in both cases. Callbacks of
`receiveColor` and `receiveColorArray` now get a `ColorValue`, which is either form. The new
`toHexColor()` and `toRgbaColor()` convert it:

```ts
// 1.x
Sync.receiveColor('tint', (hex: string) => setTint(hex));

// 2.0
import { toHexColor } from '@hcikn/colibri';
Sync.receiveColor('tint', colour => setTint(toHexColor(colour)));
```

- With `strict`, a callback typed `string` no longer compiles. Without `strict`, it compiles and
  still receives arrays from web clients.
- For a value that is not a colour, both functions warn and return opaque black instead of throwing.
- `sendColor` accepts either form. The wire format is unchanged.

### Fixed

- `import { ColibriError } from '@hcikn/colibri'` works. As a default export, which `export *` does
  not re-export, it used to import as `undefined`.
- `require()` consumers get their own `.d.cts` declarations.
- The `console.log` on every model registration is gone. With `RemoteLogger`, it also caused
  needless network traffic.
- The server address can be written as a browser shows it, such as `'http://192.168.0.10:9211'`.
  `https://`, `ws://`, `wss://`, a port in the address and a trailing slash work too. Port
  precedence: the port in the address, then the third argument, then 9211, also for `https://`.
- An address that 1.x turned into a URL that could never connect now throws a `ColibriError`: a path
  after the host (such as the admin UI's `…/log`), an unknown scheme, a port that is not a whole
  number, or a port in the address that differs from the port argument.
- `Sync.receive*`, `RegisterChannel`, `RegisterModelSync` and `new RemoteLogger()` may come before
  `new Colibri()`. They take effect once it exists.
- Without `name`, `RegisterModelSync` names its channel after the class. A minifier renames classes,
  so a minified build could end up on a different channel than Unity and other builds, without an
  error. Colibri now warns when the class name looks minified. Pass `name` in bundled code:
  `RegisterModelSync({ name: 'player', type: Player })`.

---

## colibri-unity

### Breaking: Unity 2022.3 LTS

The manifest declared 2019.4 but used APIs that were never available there. It now declares 2022.3
LTS.

### Breaking: UniRx removed

There is no replacement. `SyncBehaviour<T>.ModelCreated()` and `ModelDestroyed()` returned
`IObservable<>`. They are now static events:

```csharp
// 1.x
SyncBehaviour<Player>.ModelCreated()
    .Subscribe(model => Register(model))
    .AddTo(this);

// 2.0
private void OnEnable() => SyncBehaviour<Player>.ModelCreated += Register;
private void OnDisable() => SyncBehaviour<Player>.ModelCreated -= Register;
```

**Unsubscribe yourself.** A UniRx subscription with `AddTo(this)` ended with the component. A static
event subscription does not. A missing `-=` leaks the handler and the destroyed object behind it.
With *Enter Play Mode Options → Disable Domain Reload* on, the leak survives into the next Play
session and everything fires twice.

`this.ObserveEveryValueChanged(...)` has no replacement either. Colibri's own change detection runs
in one `Update` for the whole application. For your own polling with UniRx, add UniRx as your own
dependency.

### Breaking: `WebServerConnection.Connected` is a `Task`

```csharp
// unchanged
await WebServerConnection.Instance.Connected;

// 1.x only
WebServerConnection.Instance.Connected.Subscribe(isConnected => ...);
```

Replace the subscription with the `OnConnected` and `OnDisconnected` events. `OnDisconnected` is
raised exactly once for every `OnConnected`, and never for an attempt that did not connect.

The task completes, and `OnConnected` fires, when the first frame from the server arrives, not when
the TCP connection is accepted. While disconnected, `Connected` is a new task that waits for the
next connection. It is cancelled when the component is disabled and when the server refuses this
client's protocol version, so an `await` on it can throw `TaskCanceledException`.

### Breaking: `ObservableModel<T>` and `ObservableManager<T>` removed

They used commands a 2.0 server does not register: `channel::register`, `channel::deregister` and
the bare `add`, `update`, `request` and `remove`. Port to `SyncBehaviour<T>` and
`SyncBehaviourManager<T>`, which cover the same ground:

```csharp
public class Player : SyncBehaviour<Player>
{
    [Sync] public string Name = "";
    [Sync] public int Score;
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Put `PlayerManager` in the scene with a prefab in its `Template` field. A `Player` created by any
client then appears on all clients.

### Breaking: Newtonsoft.Json is a package dependency

The `com.unity.nuget.newtonsoft-json` package, declared as a dependency, replaces
`Assets/Colibri/Plugins/Newtonsoft.Json.dll`. **Delete your own copy if you have one.** Two
Newtonsoft assemblies in one project are a compile error, not a warning.

Installing Colibri now takes one git URL, without UniRx, UniTask or NuGetForUnity.

### Breaking: samples are not compiled into your project

In 1.x, every project compiled `Samples/` (`HCIKonstanz.Colibri.Samples.*`) into the Colibri
assembly, and *Package Manager → Import Sample* added a second copy of the same types. Samples now
live in `Samples~`, which Unity does not compile. Their types exist only after you import the
sample, and then belong to your project, in `Assets/Samples/` and `Assembly-CSharp`.

**Code that uses a sample type without importing the sample no longer compiles.** Import the sample,
or copy the files you need. Prefabs are unaffected. `[RemoteLogger]` and `[SyncTransformManager]`
can still be dragged from `Packages/Colibri/Prefabs`.

### Breaking: `LockFreeQueue` removed

The public types `LockFreeQueue<T>`, `LockFreeLinkPool<T>`, `SingleLinkNode<T>` and `SyncMethods` in
`HCIKonstanz.Colibri.Networking` were removed. Colibri no longer used them, and they were safe only
with a single producer. Use `System.Collections.Concurrent.ConcurrentQueue<T>`, which is safe with
any number of producers and consumers.

---

## TLS

TLS is optional in 2.0. To turn it on, set `TLS_CERT` and `TLS_KEY` on the server, and tick
*Server supports SSL/TLS?* in each Unity app. Details:
[server guide](colibri-server/docs/guide.md#tls), [Unity guide](colibri-unity/docs/guide.md#tls).

- The setting (`ColibriConfig.IsSSL`) now covers the TCP connection too, not only the Store.
- With the setting ticked, a deployment with only the web port behind a TLS proxy, such as nginx on
  443, and a plain TCP port needs TLS on the TCP port as well. Set `TLS_CERT` and `TLS_KEY`, or
  terminate TLS for it in the proxy. Otherwise the client reports that the server
  `did not answer the TLS handshake`.
- Existing `ColibriConfig` assets load unchanged, with both new certificate settings off or empty.
- 1.x clients cannot use TLS. The protocol version does not change.

---

## Behaviour changes that still compile

### Send rate of synced objects (Unity)

Each synced object sends at most *Max Send Rate* updates a second, 30 by default, also in projects
configured with 1.x. In 1.x, every `SyncBehaviour<T>`, `SyncTransform` included, sent an update in
every frame in which a value changed: 72 to 120 a second per moving object on a headset, too many
for one server and one Wi-Fi network with dozens of headsets.

- The first change after a quiet spell is sent at once. Later changes within the interval are
  merged, and their latest values are sent when it ends. Only the values in between are skipped.
- Switching an object off or on, and destroying it, are sent at once.
- Other clients see a moving object take 30 steps a second instead of one per frame.
- *Window → Colibri Configuration → Optional Config → Max Send Rate* sets the limit.
  `SyncSettings.MaxSendRate` changes it from code for the running app. `0` restores the 1.x
  behaviour. `Sync.Send` is not limited.

### String payloads

1.x wrote string payloads *unquoted*, which is not valid JSON. The server read them with a different
parser, so a Unity `Sync.Send(channel, "hello")` and the same message from a web client arrived
differently. Both are now sent as JSON. Remove any workaround for that difference. The `log` channel
is the deliberate exception and still carries raw text, because the admin UI reads it as a string.

### Colours between Unity and web

Unity writes `#RRGGBBAA`. colibri-web's `sendColor` writes `[r, g, b, a]` when given an array. Unity
used to throw an `InvalidCastException` on the array form inside the frame's single dispatch loop,
which lost every message queued behind it in that frame. Unity and colibri-web now accept
both forms ([colour callbacks](#breaking-colour-callbacks-get-a-colorvalue)).

### Integers from Unity (web)

Unity tags `int` and `float` differently, so `Sync.Send(channel, 5)` arrives as `broadcast::int`.
colibri-web's `receiveNumber` listened only for `broadcast::float` and silently dropped these. It
now listens for both.

### Store timeout (Unity)

`Store` calls give up after 10 seconds. `UnityWebRequest` has no timeout by default, so with a wrong
server address, `Get`, `Put` and `Delete` used to hang forever, with no result, no error and no
console output. They now fail and log what failed, the URL and the HTTP status.

### Store values

1.x answered `400` to anything but an object or an array, and `413` above 100 kB. The store now
accepts any JSON value up to 5 MiB, including a plain number, string, boolean or `null`, as in
Unity's `Store.Put("score", 42)` or colibri-web's `setRestObject('note', 'text')`.

### Store serialization (Unity)

Unity's `Store` converts with Newtonsoft JSON instead of `JsonUtility`.

- Newtonsoft saves public fields and properties. A private `[SerializeField]` field of a saved class
  is no longer saved or loaded. Make it public, or add `[JsonProperty]`.
- A `Vector2`, `Vector3`, `Vector4`, `Quaternion` or `Color` inside the class is saved as an array
  of its components. Values that 1.x saved as `{"x": …}` still load.
- If a value cannot be converted, or a saved value does not fit the requested type, `Put` returns
  `false` and `Get` returns `default`, with the reason in the console.

### Reconnects

In 1.x, clients requested the synced models' state only when a listener registered, and missed what
changed during an outage until the next change. Unity and web clients now request it after every
reconnect, and update their objects instead of creating duplicates.

- The server still forgets an app's models when it restarts and when the app's last client
  disconnects, which is how a lone client's outage looks to it. A client that finds its objects gone
  sends them again in full (colibri-web: the models it registered). The exception is a Unity object
  that changed during the outage. Its changes reach the server first, and until its other members
  change, the server and every client that joins later have only those changes
  ([Known limits](colibri-server/docs/protocol.md#known-limits)).
- An object another client deleted during the outage is deleted on the reconnecting client too, if
  the delete is at most `MODEL_TOMBSTONE_SECONDS` (ten minutes) old. colibri-web does this only for
  the models it registered. A model it got from another client stays.
- A change made as the connection dies without closing, as on a Wi-Fi drop, is lost in the dead
  connection. The answer after the reconnect no longer undoes it. The client keeps its value and
  sends it again (colibri-web: for the models it registered). A value another client set during the
  outage still wins, unless this client had it in the 10 s before the outage. A member or field set
  back to such a value looks like a lost change, and the other client's change is undone
  ([Known limits](colibri-server/docs/protocol.md#known-limits)).
- A Unity object destroyed at the drop has its delete sent again.
- After their re-requests, both clients send one more `model::request`, on the channel
  `colibri::reconnect`, to detect the end of the answers. A Unity client does so after every
  reconnect, and when an object's first answer arrives outside that round after the object changed
  its own members ([details](#changes-before-the-servers-state-arrives-unity)). colibri-web does so
  after requesting every model, after requesting one of its models again, and after the first update
  for a model it registers if it does neither. See
  [After a reconnect](colibri-server/docs/protocol.md#after-a-reconnect).
- While disconnected, a Unity client queues outgoing messages and sends them in order once
  reconnected. Past 256 broadcasts and log lines, the oldest are dropped, with one warning per
  outage. The model updates for one object are merged into one instead.
- The whole queue holds at most 10,000 messages, connected or not. Past that, the oldest broadcasts
  and log lines are dropped first, then the oldest model messages, with a warning.

### Changes before the server's state arrives (Unity)

A `SyncBehaviour` or `SyncTransform` requests the server's state when it wakes up. In 1.x, a change
made before the answer, in `Start` for example, was dropped, and the answer restored the server's
values. Such a change now replaces the server's value on every client, as colibri-web's
`registerModel` does ([`registerModel` (web)](#registermodel-web)).

- A script that sets a `[Sync]` member or moves a `SyncTransform` in `Start` therefore does so for
  everyone each time a client starts.
- To have the object take the server's state instead, set starting values in the scene or the
  prefab, or in a model's `Awake` before `base.Awake()`.
- Set up whatever a `[Sync]` getter reads in the same place, such as a cached component. A getter
  that reads its fallback in `base.Awake()` and the real value later counts as changed.
- A placed `SyncTransform` with `PhysicsAuthority` ticked stays kinematic until the answer.

### `registerModel` (web)

`registerModel` used to send the new instance in full at once. If the server already held the id,
such as the fixed id `'session'` kept while another client stayed connected and the page
reloaded, this overwrote everyone else's copy. The answer to the request for every model then
restored the old values on this client only.

`registerModel` now first requests the model with that id from the server. If the server has the
model, its values replace the instance's, and changes made after `registerModel` are sent on top of
them. If not, the instance is sent in full, one round trip later than before. Registering an id that
is already listed replaces the listed instance instead of listing the id twice.

### Voice port (Unity)

The voice receive socket binds to an ephemeral port instead of 9014, which allowed only one Unity
client per machine. The server replies to the datagram's source port, so a fixed port is not needed.

### Voice per app (Unity)

In 1.x, every voice packet went to every client on the server that was sending voice, and a
`VoiceReceiver` played the voice id it was given, from any app. Now only clients with the same
*App Name* hear each other, so two apps on one server can use the same voice ids. A project without
an App Name sends no voice. This separates apps but is not access control. Anyone who knows the App
Name can listen, and voice is not encrypted.

The server also relays voice only from the address of a Unity client connected with the same App
Name, one voice sender per such client. Voice therefore needs `WebServerConnection` connected, which
`VoiceBroadcast`, `VoiceReceiver` and `VoiceServerConnection` do not start. A scene that uses voice
without any `Sync` call or `SyncBehaviour` gets no voice at all, and Unity logs nothing. Call
`Sync.Receive`, or read `WebServerConnection.Instance`, in such a scene. After an App Name change at
runtime, voice stops until `WebServerConnection` reconnects with the new name.

### Latency echo removed

The `colibri` / `latency` message round trip was removed. TCP latency comes from the 100 ms
heartbeat, which the client echoes back unchanged. The server no longer sends `latency` to a TCP
client.

### Missing configuration (Unity)

Without a config asset, `ColibriConfig.Load()` returned `null`, so `GetWebUrl` threw a
`NullReferenceException` and the connection loop polled forever without output. It now returns
defaults and reports the missing configuration once, with the menu item that fixes it.

### Type mismatch warnings (Unity)

Colibri routes messages by channel *and* type. A `float` sent to a `string` listener used to be
dropped silently. This mismatch is now reported once per channel and type, not once per message,
with both types and the fix. Such warnings after the upgrade are mismatches that 1.x hid.

### `Sync` listener lifetime (Unity)

`Sync.Receive` records the Unity object a listener belongs to, and removes the listener when that
object is destroyed. For a method group, this is its component. For a lambda, it is the component
the closure captured.

- A listener without such an object stays registered until `Sync.Unregister`, as in 1.x. This
  applies to a static method, and to a lambda that uses nothing of its component (only its
  parameter, `Debug.Log` or a static), because that lambda captures nothing.
- Registering the same listener again on the same channel adds nothing. A `Start` that runs again
  after a scene reload does not receive each message twice.
- Keep existing `Sync.Unregister` calls in `OnDestroy`. They are still correct. For a component's
  listener, a forgotten one no longer breaks delivery. In 1.x, the destroyed component was still
  called, `MissingReferenceException` came out of `WebServerConnection.Update`, and every message
  queued behind it in that frame was lost. This is a likely cause of unexplained gaps in delivery in
  a 1.x project.
- **This covers `Sync.Receive` only.** The static `ModelCreated` and `ModelDestroyed` events of
  `SyncBehaviour<T>` are plain C# events and still need their `-=`.

### Server data store fixes

`DataStore` keyed on the concatenation `group + channel`, so app `ab` with channel `c` collided with
app `a` with channel `bc`. `clearApp` matched on a `startsWith` prefix, so when the last client of
app `test` disconnected, the store of app `test2` was wiped too. Both bugs are fixed structurally.

---

## Post-upgrade checks

1. **Every `[Sync]` member has a supported type.** Members are validated when the model type is
   first initialized. An unsupported type, a property without an accessor, or two members whose
   lower-cased names collide are reported at startup, not on the first message.
2. **Every static event subscription is removed** in `OnDisable` or `OnDestroy`. This applies to
   `SyncBehaviour<T>.ModelCreated` and `ModelDestroyed`. Most `Sync.Receive` listeners are removed
   automatically. A static method, or a lambda that uses nothing of its component, still needs
   `Sync.Unregister` ([`Sync` listener lifetime](#sync-listener-lifetime-unity)).
3. **Turn on *Run In Background*** (Project Settings → Player). With it off, an unfocused Editor
   stops running the player loop. The client then stops sending and receiving without an error,
   while the socket stays open and everything still reports as connected. This is not new in 2.0,
   but it is the most common cause of lost debugging time.
4. **Open *Window → Colibri Status*** while connected. It shows the app name. With a typo in the
   name, the connection is healthy, but no other client ever appears. A name others also use puts
   unrelated clients in your app. *Window → Colibri Configuration* now warns about names such as
   `test` or `myAppName`, and the server logs a warning when one app has more than 8 clients.

---

## Test coverage

| Command | Tests | In CI |
| --- | --- | --- |
| `npm test` in `colibri-server` and `colibri-web` | Unit tests | Yes |
| `npm run test:e2e` in `colibri-web` | Against a running server | No |
| `node colibri-unity/run-tests.mjs` | Unity EditMode tests, and PlayMode tests against a real server, started with Docker unless one is already running. Needs a local Unity installation. See [Running the tests](colibri-unity/docs/guide.md#running-the-tests). | No |
| `npm run test:docker` in `colibri-server` | The image against a fresh, a root-owned and a named-volume data directory. Needs Docker. | No |

CI also checks that the server's frame encoding matches the vectors the Unity tests use, and that
every client announces the server's protocol version.

Not covered by any suite:

- **Voice chat** end to end, which needs a microphone. Unit tests cover the server's relay, the
  packet format on both sides, and in the Unity client the choice of server address (IPv4 and IPv6),
  failed sends, the socket with its receive thread over the IPv6 loopback, the queue that hands
  received packets to the main thread, resampling and framing with the fallback to PCM, decoding,
  and the playback buffer. Microphone capture, the `AudioSource` output, the sample and two real
  clients are not tested.
- **Android and Meta Quest.** No suite builds for Android or runs on a headset. The code that runs
  only there (the IL2CPP `[Sync]` accessors) and the Android settings check are tested in the
  Editor.
- **Two Unity clients.** The PlayMode tests use a scripted peer, not a second Unity client. An
  object following its copy between two Unity players is a manual check.
- **The samples.** No suite compiles or runs them.

Batched `model::request` replies were deliberately left for later (see the server changelog).
Colibri has no access control, by design. Anyone who can reach the server's ports can join any app
and read or change its store. Run it on a network you trust.
