# Upgrading to Colibri 2

Colibri 2 does not work with Colibri 1. A Colibri 2 server refuses Colibri 1 clients, and a Colibri 2 Unity client
cannot connect to a Colibri 1 server. Upgrade the server and all clients together.

## Checklist

1. [Upgrade the server](#server)
2. [Upgrade your Unity projects](#unity)
3. [Upgrade your web apps](#web)
4. [Check your app after the upgrade](#after-the-upgrade)

## Default ports

Colibri 2 uses new default ports, so that a Colibri 1 and a Colibri 2 server can run side by side:

| Port                | Colibri 1 | Colibri 2 |
| ------------------- | --------- | --------- |
| Web and web clients | 9011      | 9211      |
| Unity clients (TCP) | 9012      | 9212      |
| Voice chat (UDP)    | 9013      | 9213      |

**Your existing Unity configuration still contains the old ports.** Unless your server keeps the old ports, change
them as described under [Unity](#unity).

## Server

1. **Docker:** use the new image and pin its version, e.g. `image: hcikn/colibri:2.0.0`. Without a version, the
   next pull can switch a server between Colibri 1 and 2 unnoticed.
2. **Ports:** change the port mappings, firewall rules and reverse proxy to 9211, 9212 and 9213/udp. To keep the old
   ports instead, publish them on the new container ports, e.g. `"9011:9211"`, or set `WEBSERVER_PORT`, `TCP_PORT`
   and `VOICE_PORT`.
3. **Compose file from the Colibri 1 README:** remove `tty: true`. Otherwise warnings and errors are mixed into the
   normal log output. The new [compose file](colibri-server/README.md#docker-recommended) also limits the log size.
4. **Data directory:** your data in `./data` keeps working. The server now runs as user `node` (uid 1000) and takes
   over the data directory on startup. If you start the container with `--user` (or `user:` in compose), give the
   directory to that user first, e.g. `sudo chown -R 1001:1001 ./data` for `--user 1001:1001`.
5. **Without Docker:** the server needs Node.js 24 or newer.

If you use voice chat through a UDP proxy, add the proxy to `TRUSTED_PROXIES`, or publish 9213/udp directly.
Otherwise the server drops the voice.

If your own scripts write to the data store over HTTP, send `Content-Type: application/vnd.colibri.v2+json`:

```sh
curl -X PUT -H 'Content-Type: application/vnd.colibri.v2+json' -d '{"x":1}' http://localhost:9211/api/store/myAppName/myKey
```

## Unity

### Update the package

1. Colibri 2 needs **Unity 2022.3 or newer**.
2. Install Colibri 2 as described in the [README](colibri-unity/README.md#installation). The Package Manager must
   show version 2.0.0 or newer.
3. Remove UniRx, UniTask and NuGetForUnity if you installed them only for Colibri. Colibri 2 no longer needs them.
4. Delete your own copy of `Newtonsoft.Json.dll` if you have one. Colibri 2 installs the Newtonsoft JSON package,
   and two copies do not compile.

### Change the ports

In *Window → Colibri Configuration → Optional Config*, set the ports to **9211**, **9212** and **9213**, then click
*Save Config*. Skip this if your server keeps the old ports 9011 to 9013.

If *Server supports SSL/TLS?* is ticked, the server needs TLS on its TCP port too, not only on the web port.

### Update your code

**`ModelCreated` and `ModelDestroyed` are events.** Subscribe with `+=` and unsubscribe with `-=` yourself.
A missing `-=` keeps calling the handler of a destroyed object.

```c#
// Colibri 1
SyncBehaviour<Player>.ModelCreated()
    .Subscribe(Register)
    .AddTo(this);

// Colibri 2
private void OnEnable()
{
    SyncBehaviour<Player>.ModelCreated += Register;
}

private void OnDisable()
{
    SyncBehaviour<Player>.ModelCreated -= Register;
}
```

**`WebServerConnection.Connected` is a `Task`.** `await WebServerConnection.Instance.Connected` still works.
Replace `Connected.Subscribe(...)` with the events `OnConnected` and `OnDisconnected`.

**`ObservableModel<T>` and `ObservableManager<T>` were removed.** Use `SyncBehaviour<T>` and
`SyncBehaviourManager<T>` instead:

```c#
public class Player : SyncBehaviour<Player>
{
    [Sync]
    public int Score;
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

**Samples are no longer part of the package.** If your code uses a class from a Colibri sample, import the sample in
*Package Manager → Colibri → Samples*, or copy the files you need.

**`LockFreeQueue<T>` was removed.** Use `System.Collections.Concurrent.ConcurrentQueue<T>`.

### Changes in behaviour

These changes need no code changes, but you may notice them:

- **Send rate:** a synchronized object sends at most 30 updates per second instead of one per frame. Change this in
  *Window → Colibri Configuration → Optional Config → Max Send Rate*. `0` means no limit.
- **Changes in `Start`:** a `[Sync]` member set in `Start`, or a `SyncTransform` moved there, now changes the object
  for everyone each time a client starts. Set starting values in the scene or prefab instead.
- **Listeners:** `Sync.Receive` listeners that are methods of a script are removed automatically when the script is
  destroyed.
- **Data store:** `Store` saves the public fields and properties of your class. A private `[SerializeField]` field is
  no longer saved. Make it public or add `[JsonProperty]`. Requests now give up after 10 seconds instead of hanging.
- **Voice chat:** only clients with the same app name hear each other. Voice needs a connected Colibri client, so a
  scene that uses voice without any `Sync` call or `SyncBehaviour` gets no voice.
- **Type mismatch:** a message whose type does not match the listener, e.g. a `float` sent to a `string` listener,
  is now reported in the console. Colibri 1 dropped it silently.

## Web

### Update the package

```sh
npm install @hcikn/colibri@2 rxjs
```

- Colibri 2 needs **TypeScript 5.0 or newer**. For plain JavaScript, see the
  [unsupported workaround](colibri-web/docs/js-workaround/README.md).
- `rxjs` is now a peer dependency. npm 7 and newer install it automatically.

### Change the port

Without a port, Colibri 2 connects to port **9211**. If your server address contains port 9011, change it, unless
your server keeps the old ports.

### Update your code

**`@Synced()` needs standard decorators.** Remove `experimentalDecorators` from `tsconfig.json` and declare every
synced member with `accessor`:

```ts
// Colibri 1
class Player extends SyncModel<Player> {
    @Synced() private age = 0;
}

// Colibri 2
class Player extends SyncModel<Player> {
    @Synced() accessor age = 0;
}
```

**Colour callbacks receive a `ColorValue`.** A colour arrives from Unity as `"#RRGGBBAA"` and from a web client as
`[r, g, b, a]`. Convert it with `toHexColor()` or `toRgbaColor()`:

```ts
// Colibri 1
Sync.receiveColor('tint', (hex: string) => setTint(hex));

// Colibri 2
Sync.receiveColor('tint', colour => setTint(toHexColor(colour)));
```

**Pass `name` to `RegisterModelSync`.** Without it, the channel is the class name, which a minified production
build changes: `RegisterModelSync({ name: 'player', type: Player })`.

### Changes in behaviour

- **`registerModel`** first asks the server for a model with the same id. If the server has one, its values replace
  the new instance's values instead of the other way round.
- **Numbers from Unity:** `receiveNumber` now also receives `int` values sent from Unity.
- **Server address:** the address can be written as a browser shows it, e.g. `'http://192.168.0.10:9211'`. An
  address with a path, such as the monitoring page's `.../log`, throws a `ColibriError`.

## After the upgrade

1. **Enable *Run In Background*** in *Project Settings → Player*. Without it, a Unity Editor that is not in focus
   stops sending and receiving, while it still shows as connected.
2. **Check the app name** in *Window → Colibri Status* while connected. Clients exchange data only if their app
   names match.
3. **Look at the server's monitoring page** at `http://<server-address>:9211`. It lists every connected client. A
   client still on Colibri 1 is named in the log with the reason it was refused.
