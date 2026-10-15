# Changelog

All notable changes to `@hcikn/colibri` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0] - Unreleased

Made for colibri-server 2.0.0 or newer: that server refuses colibri-web 1.x, and this release
warns about an older server. [MIGRATION.md](../MIGRATION.md) walks through upgrading every
Colibri component from 1.x.

### Changed

- **Breaking:** `@Synced()` now requires TypeScript's standard TC39 `accessor` decorators
  instead of legacy (`experimentalDecorators`) ones. Remove `experimentalDecorators` from
  your `tsconfig.json` and turn every synced field/property into an `accessor` (e.g.
  `@Synced() private age = 0;` → `@Synced() accessor age = 0;`). This also fixes field
  synchronization in frameworks like React, which never worked correctly under the legacy
  decorator.
- **Breaking:** Colibri now targets TypeScript (5.0 or newer). `@Synced()` is a TypeScript
  decorator, and the documentation, samples and tests all assume a TypeScript project.
  Projects that are tied to plain JavaScript can fall back on the
  [workaround](docs/js-workaround/README.md) documented in the repository.
- **Breaking:** the socket handshake announces protocol version `'2'` instead of `'1'`, and
  colibri-server 2.0.0 checks it and refuses any other version. colibri-web 1.x and
  colibri-server 2.0.0 therefore cannot be used together; upgrade both. See
  `Colibri.protocolMismatch` below for what this release does about a mismatch.
- **Breaking:** the default port is 9211, colibri-server 2.0's default, instead of 9011. A
  `Colibri` created without a port, in the address or as the third argument, connects to 9211.
  For a server that keeps 9011, pass the port. colibri-server 2.0 moved its defaults so that a
  1.x and a 2.0 server can run side by side, and a client of one version does not reach a
  server of the other by its defaults.
- **Breaking:** `Sync.receiveColor`/`receiveColorArray` callbacks get a `ColorValue` instead
  of a `string`. Unity puts the HTML string `"#RRGGBBAA"` on the wire for a colour and this
  library puts `[r, g, b, a]`, so a colour sent by another web client arrived as an array
  through a callback typed `string`. Both forms are now typed and delivered, matching the
  tolerance colibri-unity's `ToColor` already had. Code that assumed a string needs a
  `toHexColor()` around it. What goes on the wire is unchanged.
- `rxjs` moved from a regular dependency to a `peerDependency`, since its types are part of
  this package's public API (`SyncModel`, `RegisterModelSync`, `Colibri.messages`).
- `typescript` is no longer installed as a dependency of this package, and `engines` asks for
  Node 18 or newer, so `yarn add @hcikn/colibri` works on Node 18 and 20. Working on the
  repository needs Node 22, which `devEngines` asks for.
- **`registerModel` asks the server for the model's id first**, and `RegisterModelSync` asks for
  every model only once the models registered in the same block of code, or before
  `new Colibri()`, have their answer. If the server already has the id, its copy wins over the
  values set before `registerModel`. Changes made after `registerModel` are held until the
  answer, then sent on top of it, and kept on this client. When they replace values the server
  had, the model is asked for once more, followed by a request on `colibri::reconnect` whose
  answer tells when that answer is over; changes made meanwhile wait for it, then go out.
  Otherwise one more request on `colibri::reconnect` follows, and the fields sent until its
  answer are kept out of every update: the update taken for the answer may have been another
  client's, or the answer to the request for every model. If the server has nothing for the id,
  the model is sent in full. So a reloaded page that registers a fixed id no longer shows old
  values while everyone else has new ones, and an id deleted a moment ago can be registered
  again. A new model reaches other clients one round trip after `registerModel`.
- After a reconnect, the models registered on this client are asked for again with
  `model::request { id, again: true }`, so a model another client deleted during the outage
  (within `MODEL_TOMBSTONE_SECONDS`) is dropped here instead of being sent back to everyone.
  This needs colibri-server 2.0.0 with its model tombstones.
- The README is now a short page: requirements, install, a minimal example and the most common
  problems. The full reference moved to [docs/guide.md](docs/guide.md), which says that
  `registerModel` takes the server's copy of an existing id, that registered models are sent
  again after a reconnect, and that REST keys are URL-encoded.
- For maintainers: the `publish` npm script is now `release`. Under its old name npm also ran
  it after every `npm publish`, which tried to publish a second time and failed.

### Added

- **`SyncTransform` and `RegisterSyncTransforms()`.** The web side of colibri-unity's
  `SyncTransform` component: `RegisterSyncTransforms()` lists the app's synced Unity objects
  with their `active`, `position`, `rotation` and `scale`, and moves them when one of these is
  assigned. Pass a `ModelId` for objects that have one. `Vector3` and `Quaternion` are
  exported as the array types Unity sends.
- **`Colibri.protocolMismatch`, and `ProtocolMismatchError` (exported).** colibri-server
  2.0.0 checks the handshake `version`, and when it refuses a client it sends a `colibri` /
  `protocol::rejected` message before disconnecting. `Colibri` handles that itself: it turns
  off Socket.IO reconnection (a mismatch cannot resolve itself, and retrying only buries the
  diagnostic), logs what both sides speak, and emits a `ProtocolMismatchError` on
  `Colibri.protocolMismatch`. The rejection is deliberately kept off `Colibri.messages`: it
  is Colibri's own plumbing, not an application message.
- **A warning when the server predates the version check.** That check is server-side, so a
  server too old to have it can neither refuse this client nor announce itself. A 2.0.0+ server
  says `colibri`/`protocol::accepted` on connect; five seconds without it emits a
  `ProtocolMismatchError` on `Colibri.protocolMismatch` with `serverVersion: '1'` (inferred
  rather than received, since every release before 2.0.0 speaks protocol v1). It **stays
  connected**: the Socket.IO envelope did not change between v1 and v2, so the connection
  genuinely works and hanging up over this would turn a warning into an outage. Ordinary
  traffic deliberately does not count as proof of life: a 1.x server relays broadcasts and
  model updates perfectly well, and the 100 ms `latency` broadcast it may also send has been
  there since colibri-server 1.2.0.
- `ProtocolMismatchError` carries `serverVersion` and `clientVersion`, both **protocol**
  versions (`'1'`, `'2'`) and never release versions, so the two are always comparable. Its
  `fatal` flag tells the two cases apart: `true` when the server refused this client and the
  connection is gone, `false` for the suspicion above. **If you subscribe to
  `protocolMismatch` and tear anything down in response, check this flag.** Each kind is
  emitted at most once per `Colibri` instance; a suspicion can be followed by a refusal, but
  not the other way round.
- `PROTOCOL_VERSION` (exported): the version announced in the handshake query.
- **`Sync.sendVector2` / `sendVector2Array` / `receiveVector2` / `receiveVector2Array`.** The
  README has listed `Vector2` as a supported type since 1.x and it was never implemented, so a
  `broadcast::vector2` from a Unity client, which Unity has always been able to send, was
  dropped here without a word.
- **`toHexColor()` and `toRgbaColor()` (exported), plus the `ColorValue` type.** Normalize a
  received colour to whichever shape you want. They warn and fall back to opaque black on a
  payload that is not a colour, rather than throwing.
- A console warning when `RegisterModelSync` derives its channel from a class name that looks
  minified (two characters or fewer, or containing `$`). A minifying build renames classes, so
  such a channel differs between builds and from Unity's; pass `name` explicitly.
- Samples: `npm run samples/rest-api`, and `npm run samples/verification-peer -- [host] [port]`,
  a non-interactive peer that sends and receives one value of every type, for testing against
  a Unity client.
- A Vitest unit-test suite (`npm test`), an end-to-end suite against a real colibri-server
  (`npm run test:e2e`), and `npm run typecheck`.

### Fixed

- **The remote store did not work:** `getRestObject` and `setRestObject` (and with them
  `GetRestApi` and `PutRestApi`) requested a `ws://` URL, which `fetch` rejects. They now use
  `http://`, or `https://` for a secure server address.
- **Integers sent by Unity were dropped.** Unity tags `Sync.Send(channel, 5)` as
  `broadcast::int`, and `receiveNumber`/`receiveNumberArray` only listened for
  `broadcast::float`. They now receive both.
- **Registering before `new Colibri()` silently did nothing.** `Sync.receive*`,
  `RegisterChannel`, `RegisterOnce` and `RegisterModelSync` called before it now attach once
  it is constructed, `RegisterModelSync`'s request for the existing models and a registered
  model's first full update are sent at that point, and `Sync.unregister`/`UnregisterChannel`
  called before it take back a pending registration.
- **Model updates missed during a disconnect were never caught up.** After every reconnect,
  each `RegisterModelSync` asks the server for the current state again; existing models are
  updated in place, and a model registered on this client that the server has forgotten is sent
  again. A model from another client that was deleted while this client was away is still not
  removed.
- After a reconnect, a model registered on this client that another client deleted during the
  outage no longer stops the catch-up. The delete counts as the answer for it, the model is
  dropped, and the request for every other model still goes out, so the changes and new models
  made meanwhile arrive.
- A change to a registered model made just before the connection died without closing (Wi-Fi
  dropping out, say) is no longer undone after the reconnect, however many more were made before
  Socket.IO noticed. Socket.IO notices such a connection only after its ping timeout, and what is
  sent until then is lost. The answer after the reconnect had the value from before, and applying
  it reverted the change here while no other client ever saw it. The field now keeps its value and
  sends it again; a value another client set meanwhile is still applied. That also holds when the
  connection dies again before the answer comes, or before the value sent again arrives, and when
  an update another client sends right after the reconnect arrives ahead of the answer: every
  update for the model is checked until the answers are over. To tell when they are,
  `RegisterModelSync` sends one more `model::request` after them, on the channel
  `colibri::reconnect`; the server needs no change. A field changed more than about 8 times right
  at the moment the connection died may still not be recognised. See
  [docs/guide.md](docs/guide.md#syncmodel).
- A change sent within a round trip of asking the server for every model, on connecting or after
  a reconnect, is no longer undone by the answer. The server made that answer before it had the
  change, and never sends a client's own update back to it, so this page showed the old value
  while the server and every other client had the new one. `RegisterModelSync` now sends one more
  request on `colibri::reconnect` after that one, and keeps the fields it sends out of every update
  until the answer: whatever arrives before then was made before the server had them. Every
  `RegisterModelSync` on the channel does so, as each receives the answers to the others' requests,
  such as those of one created later on a re-render.
- A change to a model is no longer undone by an update for it that arrives before the change is
  sent, 1 ms after it is made. The update was applied over the change, which then went out with
  the update's value, so it was lost on every client. The server reads the change after that
  update, so the change is now kept.
- `registerModel` with an id that `models$` already lists replaces that entry instead of listing
  the id twice. The replaced instance stops syncing (with a console warning if it was registered
  on this client), and registering the same instance again does nothing.
- With two `RegisterModelSync` on the same channel in one page, the server's bare answer to one
  of them does not appear in the other as a model with no fields.
- `new RemoteLogger()` before `new Colibri()` overflowed the stack on the first `console`
  call. Lines logged before Colibri exists are now kept (the first 100) and sent once it is
  constructed; any further lines are counted and reported in one warning.
- With `RemoteLogger` installed, logging a value JSON cannot encode (a `BigInt`, a throwing
  `toJSON`) threw out of `console.log`. Forwarding never throws now, and a `BigInt` is sent as
  its decimal string.
- **Server addresses in the form a browser shows them.** `'http://host'` became
  `ws://http://host:9011` (and `'https://host'` likewise), and a port in the address, as in
  `'host:9011'`, ended up twice: `ws://host:9011:9011`. Neither could connect, and nothing
  reported an error. `http://` and `ws://` now mean `ws` for the socket and `http` for the REST API, `https://`
  and `wss://` mean `wss` and `https`, a port in the address is used, and a trailing slash is
  ignored. `Colibri.port` is the port actually used: the one in the address, else the one
  passed, else 9211. A `ColibriError` is now thrown for anything that cannot connect: a port
  in the address that disagrees with the one passed, a path, query or fragment after the host
  (such as the admin UI's `/log`), any other scheme, an IPv6 address without brackets, and a
  port that is not a whole number from 1 to 65535 (`NaN` used to get through). The `port`
  parameter stays typed `number`, but untyped (JavaScript) callers that pass a string of
  digits such as `'9011'` still get that port, as they did in 1.x.
- `new Colibri(app)` without a server address outside a browser throws a `ColibriError`
  instead of `ReferenceError: window is not defined`.
- `ColibriError` is now a named export, fixing `import { ColibriError } from '@hcikn/colibri'`,
  which previously failed silently because a default export is not re-exported by `export *`.
- Removed a stray `console.log` on every model registration that, combined with `RemoteLogger`,
  produced unnecessary network traffic to the server.
- The package's entry points: `module` pointed at a file that was never built, and `require()`
  got the ES module build. An `exports` map now gives `import` and `require()` each their own
  build and type declarations (`.d.ts`/`.d.cts`).
- The published npm package now includes a `LICENSE` file.
- `Sync.sendInt` is now documented as emitting `broadcast::float`: JavaScript has one number
  type, so it cannot do otherwise, and a Unity peer must listen with `Sync.Receive<float>`. The
  alias stays for API symmetry.
