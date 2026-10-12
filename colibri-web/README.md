# Colibri Web

TypeScript client for [Colibri](../README.md) with pub/sub messages, synchronized models, a
[key-value store](docs/guide.md#remote-store) and [remote logging](docs/guide.md#web-interface-for-logging). Exchanges
data with web and [colibri-unity](../colibri-unity/README.md) clients through a [colibri-server](../colibri-server/README.md) 2.x.
Voice chat is currently not supported on the web.

Full documentation: [docs/guide.md](docs/guide.md). Upgrading from 1.x: [MIGRATION.md](../MIGRATION.md).
Release notes: [CHANGELOG.md](CHANGELOG.md).

## Requirements

- A browser, or Node.js 18 or newer. In Node.js, pass the server address to `new Colibri()`.
- colibri-server 2.x. 1.x and 2.x [do not interoperate](docs/guide.md#protocol-version).
- TypeScript 5.0 or newer with standard decorators. Leave `experimentalDecorators` unset or `false`. Plain
  JavaScript: [unsupported workaround](docs/js-workaround/README.md).
- Peer dependency rxjs `^7.8.1`, installed by npm 7 and newer.

## Installation

```sh
npm install @hcikn/colibri@2
```

Keep the `@2` to avoid installing a 1.x release. If npm reports `No matching version found for @hcikn/colibri@2`,
[build the package from source](docs/guide.md#building-from-source).

## Quick start

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'http://<your-server>:9211'); // 9211 is the default port

Sync.receiveNumber('temperature', value => console.log('temperature', value));
Sync.sendNumber('temperature', 21.5); // reaches other clients only, e.g. a second browser tab
```

Web and Unity clients exchange data only if their app names match. Use a name no other project on the server uses.
Do not use `colibri`, which the admin UI uses.

## Usage

### SyncModel

```ts
import { RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

class Player extends SyncModel<Player> {
    @Synced()
    accessor score = 0;
}

const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });
players$.subscribe(players => console.log(players.map(p => `${p.id}: ${p.score}`)));

const me = new Player(`player-${Date.now()}`); // the id must be unique across clients
registerPlayer(me);
me.score = 10; // sent to the other clients
```

- Create the `Colibri` instance first, as in the quick start.
- Always pass `name`. Without it, the channel is the class name in lower case, which minification changes.
- To sync with a Unity `SyncBehaviour<T>`, set `name` to the Unity class name in lower case, followed by `_<ModelId>`
  if the component's `ModelId` is set ([details](docs/guide.md#syncmodel)).

## Configuration

| Argument | Default                         | Value                                                                                                                        |
| -------- | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `app`    | required                        | App name. Must match on all clients that exchange data.                                                                      |
| `server` | Host of the page (browser only) | Host name or IP address, optionally with `http://`, `https://`, `ws://` or `wss://` and `:port`. No path, query or fragment. |
| `port`   | `9211`                          | Used when `server` has no port. If both have one, they must match.                                                           |

A second `new Colibri()` throws. Use `Colibri.getInstance()`. All options: [guide](docs/guide.md#configuration).

## Troubleshooting

| Symptom                                                                | Cause                                                                                                                                      | Fix                                                                        |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| `new Colibri()` throws a `ColibriError`                                | Path such as `/log`, query or fragment in the address, another scheme, a port that conflicts with the third argument, or a second instance | Pass only scheme, host and port. Use `Colibri.getInstance()`.              |
| Clients do not see each other                                          | Different app names or servers, or the listener was not registered and connected at send time                                              | Use the same app name and server. Register listeners first.                |
| Nothing connects from an `https://` page                               | The browser blocks `ws://` and `http://` (mixed content)                                                                                   | Use `https://` or `wss://` with [TLS](docs/guide.md#tls) or a TLS proxy    |
| `Colibri: could not connect to ...` after upgrading from 1.x           | The address or `port` names 9011, 1.x's default port. 2.x servers default to 9211.                                                         | Use the server's port                                                      |
| `colibri.protocolMismatch` emits with `fatal: true`                    | The server refused this client and closed the connection                                                                                   | Use 2.x on both sides ([Protocol version](docs/guide.md#protocol-version)) |
| `colibri.protocolMismatch` emits with `fatal: false`                   | No version announcement within 5 s, typical of a pre-2.0.0 server. The connection stays up.                                                | Upgrade the server to 2.x                                                  |
| `@Synced()` fails to compile or does not sync                          | `experimentalDecorators` is on, or a member lacks `accessor`                                                                               | Remove `experimentalDecorators`. Declare synced members with `accessor`.   |
| Models sync in development but not in a production build or with Unity | No `name` in `RegisterModelSync`                                                                                                           | Pass `name`                                                                |
| Unity never receives numbers from the web                              | colibri-web sends every number as `float`                                                                                                  | Receive with `Sync.Receive<float>` in Unity, not `Sync.Receive<int>`       |
| Colors arrive as strings or arrays                                     | Unity sends `"#RRGGBBAA"`, colibri-web `[r, g, b, a]`                                                                                      | Normalize with `toHexColor()` or `toRgbaColor()`                           |
| `Sync.send*` does nothing                                              | Called before `new Colibri()`, dropped with a console warning                                                                              | Create the `Colibri` instance first                                        |

## Testing

```sh
npm test          # unit tests
npm run test:e2e  # end-to-end, starts a colibri-server with Docker Compose unless COLIBRI_E2E_SERVER is set
```

## License

[MIT](LICENSE)
