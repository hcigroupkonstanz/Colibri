# colibri-web guide

Overview and quick start: [README](../README.md). Release notes and breaking changes since 1.x:
[CHANGELOG.md](../CHANGELOG.md). Upgrading all components to 2.0: [MIGRATION.md](../../MIGRATION.md).

- [Installation](#installation)
    - [Building from source](#building-from-source)
- [Configuration](#configuration)
    - [App name](#app-name)
    - [Server address and port](#server-address-and-port)
    - [Instance and connection](#instance-and-connection)
    - [TLS](#tls)
    - [Protocol version](#protocol-version)
- [Usage](#usage)
    - [Sending data between clients](#sending-data-between-clients)
    - [SyncModel](#syncmodel)
    - [SyncTransform](#synctransform)
    - [Remote store](#remote-store)
    - [Web interface for logging](#web-interface-for-logging)
- [Samples](#samples)
- [Development](#development)

## Installation

```sh
npm install @hcikn/colibri@2
# or
yarn add @hcikn/colibri@2
```

- Keep the `@2` to avoid getting a 1.x release.
- Requires colibri-server 2.x. A 2.x server refuses 1.x web clients. A 2.x web client warns about a 1.x server
  ([Protocol version](#protocol-version)).
- Peer dependency: `rxjs` 7.8.1 or a newer 7.x. npm 7 and newer install it. Otherwise, add it to your project.
- TypeScript 5.0 or newer with standard decorators, required by `@Synced()`. Docs, samples and tests are TypeScript
  only. Plain JavaScript: [unsupported workaround](js-workaround/README.md).

### Building from source

Build from source if npm reports `No matching version found for @hcikn/colibri@2` (yarn: `Couldn't find any versions`),
or for a version not on npm, such as a commit after the latest release. Requires Node.js 22 or newer.

```sh
cd colibri-web
npm ci
npm run build
npm pack
```

Without Git history, these commands print `.git can't be found`. Ignore it.

`npm pack` writes `hcikn-colibri-<version>.tgz` with the version from `package.json`, such as `hcikn-colibri-2.0.0.tgz`.

1. Copy the file into your project.
2. Run `npm install ./hcikn-colibri-2.0.0.tgz` (yarn: `yarn add ./hcikn-colibri-2.0.0.tgz`).
3. Commit the file. `package.json` refers to it by path.

## Configuration

Server setup: [colibri-server](../../colibri-server/). Create the client once:

```ts
import { Colibri } from '@hcikn/colibri';

// the admin UI's address without its page path ('/log', '/clients', ...)
new Colibri('app_name', 'http://<your-server>:9211');

// or the host, with an optional port
new Colibri('app_name', '<your-server>');
new Colibri('app_name', '<your-server>', 9211);
```

| Argument | Default                                      | Description                                                                                                      |
| -------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `app`    | required                                     | App name. Messages, synchronized models and stored data are shared only within one app name.                     |
| `server` | Host that served the page. Required in Node. | Host name or IP address, optionally with `http://`, `ws://`, `https://` or `wss://`, `:port` and a trailing `/`. |
| `port`   | `9211`                                       | Server port, a `number` from 1 to 65535. Used if `server` has no port.                                           |

### App name

- All clients of your app, web and Unity, must use the same name.
- Anyone else using the name joins your app and sees its messages and objects. Choose a unique name, not a placeholder
  like `app_name`.
- `colibri` is reserved for the admin UI. The server treats a client with this name as an admin UI. colibri-web warns.

### Server address and port

- `https://` and `wss://` encrypt the socket and the REST requests. They need [TLS](#tls) on the server.
- IPv6 addresses go in brackets: `http://[::1]:9211`.
- A path such as the admin UI's `/log`, a query, a fragment or an unsupported scheme throws a `ColibriError`.
- Port precedence: the port in the address, then the third argument, then 9211. If both give a port, they must match,
  or `new Colibri()` throws. `colibri.port` returns the port in use.
- The scheme never implies a port. `https://<your-server>` means port 9211, not 443.
- The default port was 9011 in 1.x. A server that keeps 9011 needs the port in the address or as the argument.
- Convert a port from `URLSearchParams` first: `Number(params.get('port') ?? 9211)`. Plain JavaScript may still pass a
  string of digits such as `'9211'`, as in 1.x.

### Instance and connection

- A second `new Colibri()` throws a `ColibriError`.
- `Colibri.getInstance()` returns the instance, or `null` with the warning
  `Colibri not initialized yet! (Instance is null)`. `Colibri.getInstance(false)` skips the warning.
- Colibri retries a failed connection until the server answers. It warns once per outage:
  `Colibri: could not connect to <address> (<reason>). Retrying until it answers ...`.
- Browsers block `ws://` and `http://` from an `https://` page (mixed content). Use `wss://` or `https://` there, with
  [TLS](#tls) on the server or a TLS proxy.
- After an outage, a background tab may reconnect late (90 s in a test with Chrome). Browsers throttle timers in hidden
  tabs, including Socket.IO's reconnect backoff. Showing the tab again makes it reconnect within seconds.

### TLS

With `TLS_CERT` and `TLS_KEY` set ([server guide](../../colibri-server/docs/guide.md#tls)), colibri-server serves its
web port over HTTPS and WSS only.

- Connect with `https://<your-server>:9211` or `wss://<your-server>:9211`. Both use `wss` for the socket and `https`
  for the REST requests.
- The admin UI is at `https://<your-server>:9211`.
- `http://<your-server>:9211` gets no answer. The connection is closed, not redirected.

| Certificate                                         | Client setup                                                                      |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| Self-signed, in a browser                           | Open `https://<your-server>:9211` once and accept the certificate, or install it. |
| Self-signed, under Node (scripts, tests)            | Start Node with `NODE_EXTRA_CA_CERTS=<cert.pem>`.                                 |
| From a certificate authority, such as Let's Encrypt | None                                                                              |
| Reverse proxy that adds TLS                         | Give the proxy's port, such as `wss://<your-server>:443`.                         |

### Protocol version

The server refuses a client whose protocol version (`PROTOCOL_VERSION`, exported) differs from its own.
`colibri.protocolMismatch` emits a `ProtocolMismatchError`:

| `fatal` | Cause                                                                                     | Effect                                                 |
| ------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `true`  | The server refused this client.                                                           | The connection is closed. Colibri does not reconnect.  |
| `false` | The server did not identify itself within 5 s of connecting, so it is probably pre-2.0.0. | The connection stays up and works. Upgrade the server. |

- Each kind is emitted at most once per `Colibri` instance and also logged to the console.
- A suspected mismatch can be followed by a refusal, not the other way round.
- Nothing is replayed to a late subscriber. Subscribe right after `new Colibri()`.
- `serverVersion` and `clientVersion` are protocol versions (`'1'`, `'2'`), not release versions.

```ts
import { Colibri } from '@hcikn/colibri';

const colibri = new Colibri('app_name', 'http://<your-server>:9211');
colibri.protocolMismatch.subscribe(error => {
    if (error.fatal) {
        // disconnected, no reconnect: install matching colibri-web and colibri-server versions
        console.error(`Server protocol v${error.serverVersion}, client protocol v${error.clientVersion}`);
    } else {
        // server older than 2.0.0, the connection still works
    }
});
```

## Usage

### Sending data between clients

`Sync` sends and receives values on named channels:

```ts
import { Sync } from '@hcikn/colibri';
Sync.sendBool('myChannel', true);

const onValue = (value: boolean) => {
    // called for every bool received on 'myChannel'
};
Sync.receiveBool('myChannel', onValue);
Sync.unregister('myChannel', onValue);
```

Listeners can be registered and unregistered before `new Colibri()`. They are attached when it is created. A
`Sync.send*` call before `new Colibri()` is dropped with the warning `Colibri not initialized yet! (Instance is null)`.

| Type       | Send             | Receive             | Value                                      |
| ---------- | ---------------- | ------------------- | ------------------------------------------ |
| bool       | `sendBool`       | `receiveBool`       | `boolean`                                  |
| int, float | `sendNumber`     | `receiveNumber`     | `number`                                   |
| string     | `sendString`     | `receiveString`     | `string`                                   |
| Vector2    | `sendVector2`    | `receiveVector2`    | `[x, y]`                                   |
| Vector3    | `sendVector3`    | `receiveVector3`    | `[x, y, z]`                                |
| Quaternion | `sendQuaternion` | `receiveQuaternion` | `[x, y, z, w]`                             |
| Color      | `sendColor`      | `receiveColor`      | `[r, g, b, a]`, each 0-1, or `"#RRGGBBAA"` |
| JSON       | `sendJson`       | `receiveJson`       | object                                     |

Each type except JSON also has an array form, such as `sendVector3Array` and `receiveVector3Array`. Unity uses structs
for vectors, quaternions and colours.

`sendInt` and `sendFloat` are send-only aliases of `sendNumber`, named after Unity's types. `sendIntArray` and
`sendFloatArray` are aliases of `sendNumberArray`.

Sample: [broadcast](../samples/broadcast.ts) (`npm run samples/broadcast`).

#### Colours

Unity sends a colour as the HTML string `"#RRGGBBAA"`, colibri-web as `[r, g, b, a]`. A callback receives either form.
Convert it with `toHexColor` or `toRgbaColor`:

```ts
import { Sync, toHexColor, toRgbaColor } from '@hcikn/colibri';

Sync.receiveColor('myChannel', color => {
    element.style.background = toHexColor(color); // "#ff0000ff", whoever sent it
    const [r, g, b, a] = toRgbaColor(color); // ...or 0-1 components
});
```

For a payload that is not a colour, both functions warn and return opaque black instead of throwing. Wire format:
[Payload shapes](../../colibri-server/docs/protocol.md#payload-shapes).

#### Broadcast limitations

- The server relays data without storing it. A listener receives only what is sent while it is registered and
  connected.
- Data goes to the _other_ clients of the app, not to the sender.
- Channel and type must match between sender and listener.
- colibri-web tags every number as `float`, since JavaScript has one number type. `sendInt` sends `float` too.
  **Unity must receive web numbers with `Sync.Receive<float>`, never `Sync.Receive<int>`.** `receiveNumber` accepts
  `int` and `float` from Unity.
- A listener stays registered until `Sync.unregister`.
- By default, the server accepts up to 1000 broadcasts and model updates a second from one client, in bursts
  of up to 2000 (`CLIENT_MESSAGE_RATE_LIMIT`, `CLIENT_MESSAGE_RATE_BURST`). Beyond that, it drops the client's
  broadcasts and holds back its model updates, merged per object so that the latest value of every field still
  arrives. It logs a warning naming the client. The limit catches runaway send loops. Details:
  [Load limits](../../colibri-server/docs/guide.md#load-limits).

### SyncModel

`SyncModel` synchronizes data models between clients. Unity counterpart:
[SyncBehaviour](../../colibri-unity/docs/guide.md#syncbehaviour).

```ts
import { SyncModel, Synced } from '@hcikn/colibri';

export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    accessor name = '';

    @Synced()
    accessor age = 0;

    @Synced('billingAddress')
    accessor address = '';
}
```

Declare each synced member with `accessor` and mark it with `@Synced()`. `@Synced('billingAddress')` syncs the member
under the given name. `@Synced()` needs TypeScript's standard decorators, the default since TypeScript 5.0. Leave
`experimentalDecorators` unset or `false` in `tsconfig.json`.

**From 1.x:** remove `experimentalDecorators` and turn every synced field into an `accessor`
(`@Synced() private age = 0;` becomes `@Synced() accessor age = 0;`). This also fixes field synchronization in
frameworks that re-create instances, such as React. It never worked correctly with the legacy decorator.

Register the class:

```ts
import { RegisterModelSync } from '@hcikn/colibri';
const [SampleClasses$, registerExampleClass] = RegisterModelSync<SampleClass>({
    name: 'sampleclass',
    type: SampleClass
});
```

`name` is the channel. **Always pass it.** The default is the class name in lower case, which minification changes.
Two builds of your app, or a minified build and Unity, then stop synchronizing without an error. Colibri warns only
when the class name looks minified (two characters or fewer, or containing `$`).

To sync with a Unity `SyncBehaviour<T>`, use the Unity class name in lower case (`'myclass'` for `MyClass`), plus
`_<ModelId>` if the component's `ModelId` is set. Property names are compared in lower case, so
`@Synced() accessor myString` matches `[Sync] public string MyString`. A received field the class does not declare
logs `Unknown property <field> in <class>`.

`SampleClasses$` is an RxJS [Observable](https://rxjs.dev/guide/observable) of all synchronized instances. It emits
the list on subscribe, and again when an instance is added or deleted, or another client updates one.
`registerExampleClass` (generically `registerModel`) synchronizes a new instance:

```ts
const mySample = new SampleClass('myId'); // not synchronized yet
registerExampleClass(mySample); // synchronized with the other clients from now on
```

Sample: [model-sync](../samples/model-sync.ts) (`npm run samples/model-sync`).

#### Registering an instance

The id identifies the instance on every client and must be unique. `registerModel` first requests the model with that
id from the server.

- If the server has it, its values replace the instance's. This happens if another client created it, or if this page
  did and was reloaded while another client stayed connected. Changes made after `registerModel` are sent on top and
  kept, even if another client's update arrives before the server's answer.
- Otherwise, the instance is sent in full.

`SampleClasses$` lists the new instance with its constructor values in the same tick, so a bound UI briefly shows the
defaults. Nothing is sent before the server's answer.

A registered instance replaces a listed one with the same id, such as a copy from the server. The replaced one stops
syncing, with a console warning if this client registered it. Registering the same instance again does nothing.

#### Reconnects

- `RegisterModelSync` and `registerModel` may run before `new Colibri()`. The request is sent once `new Colibri()`
  runs.
- After a reconnect, Colibri requests again each instance this client registered, then all others, and applies what
  changed.
- A change made while the server's answer is in transit is kept, since the server built the answer before the change.
  This applies to the answer after `registerModel`, after a reconnect, and after a request from another
  `RegisterModelSync` on the channel.
- A change not yet sent when an update for the instance arrives is also kept. `SyncModel` sends changes 1 ms after
  they are made, so the server receives the change after that update.
- The server keeps models in memory only, per app name. It forgets them on restart and when the app's last client
  disconnects, as in a lone client's outage. This client then resends its registered instances in full. Other models
  come back only from a client that has them.
- An instance another client deleted while this client was disconnected is removed on the reconnect only if this
  client registered it and the delete is at most `MODEL_TOMBSTONE_SECONDS` old (default 10 minutes). Other instances
  stay listed.

Details: [After a reconnect](../../colibri-server/docs/protocol.md#after-a-reconnect).

#### Changes lost in a dropped connection

Socket.IO detects a connection that dies without closing, such as on a Wi-Fi dropout, only after its ping timeout (up
to about 45 s with the server's defaults). Changes sent until then are lost.

If the server's answer after the reconnect, or another client's update that arrives before the last answer, shows a
field at a value it had on this client in the 10 s before the drop, Colibri keeps the local value. It resends that value
after the last answer, regardless of changes made meanwhile. A value this client never had comes from another client
and is applied. This also holds if the connection dies again before the answer or the resent value arrives.

#### SyncModel limitations

- colibri-web cannot delete an instance for other clients. `delete()` only stops the instance sending its changes. An
  instance deleted by another client, such as Unity, is removed from the list.
- A lost change is resent only for a registered instance. On a model listed from the server, the server's value wins.
- A field changed more than about 8 times within roughly 100 ms of the last message from the server before the drop,
  as in a fast drag on a slow link, may not be recognized as lost. The server's value is then applied.
- If another client sets a field back, during the outage or right after the reconnect, to a value the field had on
  this client in the 10 s before the drop, this looks like a lost change. This client's value replaces it.
- A field changed while waiting for the server's answer after `registerModel` or a reconnect is resent if the server
  still shows the replaced value a round trip later, even if another client set it back meanwhile.
- Two `RegisterModelSync` calls on one channel in one page do not receive each other's updates. They share the page's
  connection, and the server relays an update to every client except the sender. Call `RegisterModelSync` once per
  channel and share what it returns.

### SyncTransform

`SyncTransform` is a ready-made `SyncModel` for colibri-unity's
[SyncTransform](../../colibri-unity/docs/guide.md#synctransform) component. `RegisterSyncTransforms()` registers it
on the channel the component uses and returns what `RegisterModelSync` returns:

```ts
import { RegisterSyncTransforms, SyncTransform } from '@hcikn/colibri';

const [transforms$, registerTransform] = RegisterSyncTransforms(); // channel 'synctransform'
const [cubes$] = RegisterSyncTransforms('Cube'); // objects with ModelId 'Cube': 'synctransform_Cube'

transforms$.subscribe(transforms => console.log(transforms.map(t => t.position)));

const marker = new SyncTransform('marker-1');
marker.position = [0, 1, 0];
registerTransform(marker);
```

To move an object, listed from the server or registered here, assign a new value to one of its members. Colibri
sends it to all other clients, web and Unity:

```ts
transform.position = [1, 0, 2];
```

| Member      | Type                         | Default        | Unity                                                         |
| ----------- | ---------------------------- | -------------- | ------------------------------------------------------------- |
| `active`    | `boolean`                    | `true`         | `activeSelf`                                                  |
| `position`  | `Vector3`, `[x, y, z]`       | `[0, 0, 0]`    | `position`, or `localPosition` with _Use Local Transform_     |
| `rotation`  | `Quaternion`, `[x, y, z, w]` | `[0, 0, 0, 1]` | `rotation`, or `localRotation` with _Use Local Transform_     |
| `scale`     | `Vector3`, `[x, y, z]`       | `[1, 1, 1]`    | `localScale`                                                  |
| `physicsId` | `string`                     | `''`           | The client with `PhysicsAuthority`. Do not set it on the web. |

- The values are in Unity's coordinates: left-handed, Y up. For a right-handed library such as three.js, negate `z`
  of positions and `x` and `y` of rotations.
- A member is sent when a new value is assigned. Changing an array in place, e.g. `position[0] = 1`, is not noticed.
- A change to an object listed from the server sends the changed members only, so moving a Unity object never
  touches its `physicsId`.
- A Unity object whose _Sync Position_, _Sync Rotation_, _Sync Scale_ or _Sync Active_ box is unticked never sends
  that member. It keeps its default here.
- A `SyncTransform` registered on the web is sent in full. A Unity client shows it only if it has a
  `SyncTransformManager` whose `Template` has the matching `ModelId`.
- What [SyncModel limitations](#syncmodel-limitations) says applies here too: call `RegisterSyncTransforms` once per
  channel, and the web cannot delete an object for the other clients.

### Remote store

The server stores data persistently under a `key`, per app name. All clients of the app can read and write it.

```ts
import { Colibri, DeleteRestApi, GetRestApi, PutRestApi } from '@hcikn/colibri';

const key = 'sampleKey';
const data = { name: 'Test', age: 32 };

// through the Colibri instance
const colibri = Colibri.getInstance();
if (colibri) {
    await colibri.setRestObject(key, data); // true if stored
    const stored = await colibri.getRestObject(key); // null if nothing is stored under key
    await colibri.deleteRestObject(key); // true if deleted
}

// or through the wrapper functions, which return undefined without a Colibri instance
await PutRestApi(key, data);
const stored = await GetRestApi(key);
await DeleteRestApi(key);
```

- A value is any JSON value up to 5 MiB, `null` included. `undefined` is not JSON, so `setRestObject(key, undefined)`
  stores nothing.
- `setRestObject` resolves to `false` if the server did not store the value, and `deleteRestObject` if there was no
  value to delete. `getRestObject` resolves to `null` if there is no such key or the server answered with an error. All
  three reject if the server cannot be reached.
- Keys are URL-encoded. Any key works, including `/`, `#`, `?`, `%` and spaces. A key addresses the same value as in
  Unity's `Store`.
- Whitespace around a key and leading slashes are stripped. An empty key, `.` or `..` stores and finds nothing
  (`false` and `null`).

### Web interface for logging

`RemoteLogger` sends `console` output to the server, for devices without easy console access such as VR headsets and
smartphones.

```ts
import { RemoteLogger } from '@hcikn/colibri';
const logger = new RemoteLogger();

logger.disable(); // stop forwarding
logger.enable(); // forward again
```

- Forwarded lines appear in the admin UI at `http://<your-server>:9211` and in the server's console output
  (`docker logs` for Docker). `console.debug` lines reach the console output only with `CONSOLE_LOG_LEVEL=debug`.
- Create one `RemoteLogger` at startup. A further instance does not forward a second time. It warns once
  (`RemoteLogger: the console is already forwarded by an earlier new RemoteLogger() ...`). Its `enabled` argument,
  `enable()` and `disable()` control the first instance.
- It may be created before `new Colibri()`. The first 100 lines logged before then are sent once Colibri exists. Further lines
  are counted and reported in one warning.
- Forwarding never makes a `console` call throw.

Sample: [remote-logging](../samples/remote-logging.ts) (`npm run samples/remote-logging`).

## Samples

The [samples](../samples/) are TypeScript and run with [tsx](https://tsx.is/) against the sources. The interactive
ones prompt for the server address and port (prompts in `common.ts`). `verification-peer` takes both as arguments and
sends one value of every type, for testing against a Unity client.

| Sample                                               | Run with                                             |
| ---------------------------------------------------- | ---------------------------------------------------- |
| [broadcast](../samples/broadcast.ts)                 | `npm run samples/broadcast`                          |
| [model-sync](../samples/model-sync.ts)               | `npm run samples/model-sync`                         |
| [remote-logging](../samples/remote-logging.ts)       | `npm run samples/remote-logging`                     |
| [rest-api](../samples/rest-api.ts)                   | `npm run samples/rest-api`                           |
| [verification-peer](../samples/verification-peer.ts) | `npm run samples/verification-peer -- [host] [port]` |

## Development

| Command                | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `npm test`             | Unit tests                                                                                       |
| `npm run typecheck`    | Type-checks sources, samples and tests                                                           |
| `npm run lint`         | Style check (ESLint)                                                                             |
| `npm run format:check` | Formatting check (Prettier)                                                                      |
| `npm run test:e2e`     | End-to-end tests against a real colibri-server                                                   |
| `npm run release`      | Builds and publishes to npm. `npm publish` also builds first. Replaces the 1.x `publish` script. |

`npm run test:e2e` starts a server from `../colibri-server` with Docker Compose on port 9211, unless
`COLIBRI_E2E_SERVER` names a running server (port: `COLIBRI_E2E_PORT`, default 9211).
