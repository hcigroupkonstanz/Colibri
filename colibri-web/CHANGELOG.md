# Changelog

All notable changes to `@hcikn/colibri`. Upgrading from Colibri 1: [Migration Guide](../MIGRATION.md).

## [2.0.0] - Unreleased

Works only with colibri-server 2.0.0 or newer.

### Changed

- **Breaking:** `@Synced()` needs TypeScript 5.0 or newer with standard decorators. Remove `experimentalDecorators`
  and declare synced members with `accessor`: `@Synced() accessor age = 0`. Synced members now also work in
  frameworks such as React.
- **Breaking:** the default port is 9211 instead of 9011.
- **Breaking:** colour callbacks receive a `ColorValue`, either `"#RRGGBBAA"` from Unity or `[r, g, b, a]` from a web
  client. Convert it with `toHexColor()` or `toRgbaColor()`.
- **Breaking:** `rxjs` is a peer dependency. npm 7 and newer install it automatically.
- **Breaking:** `delete()` deletes an object for every client, as deleting a `SyncBehaviour` does in Unity. Before, it
  only stopped syncing the object on this client, which `detach()` does now.
- `registerModel` first asks the server for a model with the same id. If the server has one, its values win.
- After a reconnect, all synchronized models are updated with what changed during the outage.

### Added

- `synced()`: a fallback for synced properties in projects that must stay plain JavaScript. Prefer TypeScript with
  `@Synced()`.
- `SyncTransform` and `RegisterSyncTransforms()`: read and move the objects of Unity's `SyncTransform` component, with
  the `sync-transform` sample.
- `deleteRestObject()` and `DeleteRestApi()`: delete a value from the data store.
- `Sync.sendVector2()` and `Sync.receiveVector2()`, with their array forms.
- `toHexColor()` and `toRgbaColor()`: convert a received colour.
- `Colibri.protocolMismatch`: reports a server that refuses this client or is still on Colibri 1.
- A warning when `RegisterModelSync` has no `name` and the class name looks minified.

### Fixed

- The data store did not work: `getRestObject()` and `setRestObject()` always failed.
- Numbers sent as `int` from Unity were not received by `receiveNumber()`.
- `Sync.receive*()`, `RegisterModelSync()` and `new RemoteLogger()` called before `new Colibri()` did nothing.
- The server address can be written as a browser shows it, e.g. `'http://192.168.0.10:9211'`. An address that cannot
  work, such as one with a path, throws a `ColibriError` instead of failing silently.
- A change made just before a connection drop is no longer undone after the reconnect.
- `import { ColibriError } from '@hcikn/colibri'` works.
- `require()` gets the CommonJS build with its own type declarations.
- No more `console.log` on every model registration.
