# Colibri Web

TypeScript client for Colibri supporting messages between clients, synchronized objects, data store and monitoring.
Voice chat is currently not supported on the web.

[Full documentation](https://colibri.hci.uni-konstanz.de/web/installation)

Upgrading from Colibri 1.x: [Migration Guide](../MIGRATION.md).

## Requirements

- Node.js 18 or newer
- TypeScript 5.0 or newer with standard decorators. Leave `experimentalDecorators` unset or `false` in
  `tsconfig.json`.
- [colibri-server](../colibri-server/README.md#installation) 2.0.0 or newer

## Installation

### npm (recommended)

```sh
npm install @hcikn/colibri@2
```

Keep the `@2`. Without it, npm may install a 1.x release. The peer dependency `rxjs` is installed automatically.

### Building from source

To build the package from the repository:

```sh
cd colibri-web
npm ci
npm run build
npm pack
```

Copy the resulting `hcikn-colibri-<version>.tgz` into your project and install it with
`npm install ./hcikn-colibri-<version>.tgz`.

## Configuration

Create the Colibri client once, when your app starts:

```ts
import { Colibri } from '@hcikn/colibri';

new Colibri('myAppName', 'colibri.hci.uni-konstanz.de');
```

- The first argument is the **app name**. Set it to a unique name that is not used on the server. Clients exchange
  data only if their app names match, web and Unity alike. Do not use `colibri`, which the server's web page uses.
- The second argument is the **server address**: a host name or IP address, optionally with `http://` or
  `https://`. A public test server is available: `colibri.hci.uni-konstanz.de`. You can leave it out when colibri-server runs on the server that served your page.
- A second `new Colibri()` throws an error. Elsewhere in your app, use `Colibri.getInstance()`.

## Samples

The [samples](samples/) are in the `colibri-web` folder of the repository. They run in a terminal with Node.js:

```sh
cd colibri-web
npm ci
npm run samples/broadcast
```

Each sample asks for the server address and port. Press Enter twice for the public test server. To see two clients
exchange data, start the same sample in a second terminal, or run it next to a Unity client whose app name is
`myAppName`, which the samples use.

| Sample                                      | Shows                                              |
| ------------------------------------------- | -------------------------------------------------- |
| [broadcast](samples/broadcast.ts)           | Sending and receiving messages                     |
| [model-sync](samples/model-sync.ts)         | Synchronized objects with `SyncModel`              |
| [remote-logging](samples/remote-logging.ts) | Sending the console log to the server              |
| [rest-api](samples/rest-api.ts)             | Saving and loading values in the data store        |
| [sync-transform](samples/sync-transform.ts) | Showing and moving Unity's `SyncTransform` objects |

## Usage

### Send/Receive Messages

For sending simple messages of events and commands you can use `Sync.send*`. Each message has a channel name.

```ts
const myNumber = 5;
Sync.sendNumber('myChannel', myNumber);
```

A client receives the messages of every channel it listens to:

```ts
function onMyChannel(myNumber: number) {
    // This code is executed whenever
    // a number is received on 'myChannel'
}

Sync.receiveNumber('myChannel', onMyChannel);
```

A full example:

```ts
import { Sync } from '@hcikn/colibri';

function onStartRound(round: number) {
    console.log(`Round ${round} starts`);
    // reset the scores, start the timer, ...
}

// Register before anything is sent. Messages without a listener are dropped.
Sync.receiveNumber('startRound', onStartRound);

// Reaches all other clients with the same app name, not this one.
export function startRound(round: number) {
    Sync.sendNumber('startRound', round);
    onStartRound(round);
}
```

The script listens on the channel `startRound` for numbers. One player calls `startRound`, e.g. from a button,
which sends the round number to all other clients, web and Unity. On each of them, Colibri calls `onStartRound`,
which starts the round. A client does not receive its own messages, so `startRound` also calls `onStartRound`
directly to start the round on the sending client too.

- Channel and type must match on both sides.
- Supported types: `sendBool`, `sendNumber`, `sendString`, `sendVector2`, `sendVector3`, `sendQuaternion`,
  `sendColor`, their array forms such as `sendVector3Array`, and `sendJson` for anything else. Each has a matching
  `receive*` ([details](https://colibri.hci.uni-konstanz.de/web/messages#types)).
- JavaScript has only one number type, so every number is sent as `float`. Unity must receive it with
  `Sync.Receive<float>`, not `Sync.Receive<int>`.
- A listener stays registered until `Sync.unregister`.

### SyncTransform

`SyncTransform` gives the web the objects of Unity's `SyncTransform` component: their position, rotation, scale
and visibility, e.g. to show a shared 3D object on a web page or to move it from there.

```ts
import { RegisterSyncTransforms } from '@hcikn/colibri';

const [transforms$] = RegisterSyncTransforms();

transforms$.subscribe(transforms => {
    for (const transform of transforms) {
        console.log(transform.id, transform.position, transform.rotation, transform.scale, transform.active);
    }
});
```

`RegisterSyncTransforms` returns `transforms$`, an Observable of all `SyncTransform` objects of the app. It emits
the list whenever an object is added, moved, shown, hidden or deleted on any client.

To move an object, assign a new position to it, e.g. when the user drags it in a 3D view. Colibri sends it to all
other clients, web and Unity:

```ts
transform.position = [1, 0, 2];
```

- Positions and scales are `[x, y, z]`, rotations `[x, y, z, w]`, in Unity's coordinates: left-handed with Y up.
  For three.js and most other web 3D libraries, which are right-handed, negate `z`.
- Assign a new array to change a value. Changing an array in place, e.g. `position[0] = 1`, is not sent.
- Unity objects with a `ModelId` sync on a channel of their own. Pass it: `RegisterSyncTransforms('<ModelId>')`.
- Call `RegisterSyncTransforms` once per `ModelId` and share what it returns.
- Move an object from one client at a time. Concurrent updates make it jitter.

### SyncModel

`SyncModel` synchronizes the properties of your own classes between clients, e.g. a score, a selection or the state
of an experiment. It is the web counterpart of Unity's `SyncBehaviour`, and both sync with each other.

```ts
import { RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

class Player extends SyncModel<Player> {
    @Synced()
    accessor score = 0;
}

const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });

players$.subscribe(players => {
    console.log(players.map(p => `${p.id}: ${p.score}`));
});

const me = new Player(`player-${Date.now()}`);
registerPlayer(me);
me.score = 10;
```

`Player` inherits from `SyncModel<Player>`. `@Synced()` marks `score` for syncing: when one client changes it, it
changes on all other clients. `RegisterModelSync` returns `players$`, an [RxJS](https://rxjs.dev/guide/observable)
Observable of all players, and `registerPlayer`. `players$` emits the list whenever a player is added, changed or
deleted, also by another client. `registerPlayer` starts syncing a new player. Its id must be unique across all
clients.

- Declare each synced property with `accessor`. Without it, `@Synced()` does not compile.
- Always pass `name`. Without it, the channel is the class name in lower case, which a minified production build
  changes.
- To sync with a Unity `SyncBehaviour`, set `name` to the Unity class name in lower case, e.g. `'player'` for the
  `Player` in the [Unity README](../colibri-unity/README.md#syncbehaviour). Property names are compared in lower
  case, so `score` matches Unity's `Score` ([details](https://colibri.hci.uni-konstanz.de/web/syncmodel)).
- `delete()` deletes an object for every client.

### Monitoring

The server's web page at `http://<server-address>:9211` shows the connected clients with their latency and
throughput, and the synchronized objects. To also see a client's console log there, create a `RemoteLogger` when
your app starts:

```ts
import { RemoteLogger } from '@hcikn/colibri';

new RemoteLogger();
```

From then on, everything logged with `console` also appears on the server's web page. This is the easiest way to
read the log of a web app on a smartphone or head-mounted display ([details](https://colibri.hci.uni-konstanz.de/web/monitoring)).

### Data store

The data store keeps small amounts of data on the server, e.g. the color a player selected, the settings of a game
or the condition of a study. Unlike messages and synchronized objects, the data stays saved after all clients
disconnect.

```ts
import { GetRestApi, PutRestApi, toHexColor, toRgbaColor } from '@hcikn/colibri';

const playerName = 'Alex';
const avatar = document.getElementById('avatar')!;

async function loadColor() {
    const color = await GetRestApi(`color-${playerName}`);
    if (color) {
        avatar.style.backgroundColor = toHexColor(color);
    }
}

// Call this when the player selects a color, e.g. '#ff0000ff'.
async function selectColor(color: string) {
    avatar.style.backgroundColor = color;
    await PutRestApi(`color-${playerName}`, toRgbaColor(color));
}
```

`selectColor` colors the player's avatar and saves the color on the server under the name `color-<player name>`.
`loadColor` loads the saved color, so the player gets their color back in the next session. `GetRestApi` returns
`null` if the player has not selected a color yet. The color is saved as `[r, g, b, a]`, the format Unity uses, so
the same value also works in the [Unity README's](../colibri-unity/README.md#data-store) `PlayerColor` sample. Other
clients see a new value the next time they call `GetRestApi`. It is not sent to them automatically.

- Values are saved per app name. Each value can be up to 5 MiB.
- Any JSON value works, e.g. an object, an array, a number or a string.
- Create the `Colibri` instance first. Without it, both functions return `undefined`.

### Voice chat

Voice chat is currently not supported on the web. It is available in [colibri-unity](../colibri-unity/README.md#voice-chat).

## Advanced Configuration

`new Colibri(app, server, port)` takes these arguments:

| Argument | Default                                | Description                                                                                                                  |
| -------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app`    | required                               | App name. Must match on all clients that exchange data.                                                                      |
| `server` | Host of the page. Required in Node.js. | Host name or IP address, optionally with `http://`, `https://`, `ws://` or `wss://` and `:port`. No path, query or fragment. |
| `port`   | `9211`                                 | The server's web port. Used when `server` has no port. If both have one, they must match.                                    |

- For a server with [TLS](https://colibri.hci.uni-konstanz.de/web/configuration#tls), use `https://` or `wss://`. A page served over `https://` can only
  connect this way, because browsers block `http://` and `ws://` there.

## Troubleshooting

| Symptom                                                                | Cause                                                                                                                                      | Fix                                                                                                                |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `new Colibri()` throws a `ColibriError`                                | Path such as `/log`, query or fragment in the address, another scheme, a port that conflicts with the third argument, or a second instance | Pass only scheme, host and port. Use `Colibri.getInstance()`.                                                      |
| Clients do not see each other                                          | Different app names or servers, or the listener was not registered and connected at send time                                              | Use the same app name and server. Register listeners first.                                                        |
| Nothing connects from an `https://` page                               | The browser blocks `ws://` and `http://` (mixed content)                                                                                   | Use `https://` or `wss://` with [TLS](https://colibri.hci.uni-konstanz.de/web/configuration#tls) or a TLS proxy    |
| `Colibri: could not connect to ...` after upgrading from 1.x           | The address or `port` names 9011, 1.x's default port. 2.x servers default to 9211.                                                         | Use the server's port                                                                                              |
| `colibri.protocolMismatch` emits with `fatal: true`                    | The server refused this client and closed the connection                                                                                   | Use 2.x on both sides ([Protocol version](https://colibri.hci.uni-konstanz.de/web/configuration#protocol-version)) |
| `colibri.protocolMismatch` emits with `fatal: false`                   | No version announcement within 5 s, typical of a pre-2.0.0 server. The connection stays up.                                                | Upgrade the server to 2.x                                                                                          |
| `@Synced()` fails to compile or does not sync                          | `experimentalDecorators` is on, or a member lacks `accessor`                                                                               | Remove `experimentalDecorators`. Declare synced members with `accessor`.                                           |
| Models sync in development but not in a production build or with Unity | No `name` in `RegisterModelSync`                                                                                                           | Pass `name`                                                                                                        |
| Unity never receives numbers from the web                              | colibri-web sends every number as `float`                                                                                                  | Receive with `Sync.Receive<float>` in Unity, not `Sync.Receive<int>`                                               |
| Colors arrive as strings or arrays                                     | Unity sends `"#RRGGBBAA"`, colibri-web `[r, g, b, a]`                                                                                      | Normalize with `toHexColor()` or `toRgbaColor()`                                                                   |
| `Sync.send*` does nothing                                              | Called before `new Colibri()`, dropped with a console warning                                                                              | Create the `Colibri` instance first                                                                                |

## License

[MIT](LICENSE)
