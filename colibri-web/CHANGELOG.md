# Changelog

All notable changes to `@hcikn/colibri` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.0.0]

### Changed

- **Breaking:** `@Synced()` now requires TypeScript's standard TC39 `accessor` decorators
  instead of legacy (`experimentalDecorators`) ones. Remove `experimentalDecorators` from
  your `tsconfig.json` and turn every synced field/property into an `accessor` (e.g.
  `@Synced() private age = 0;` → `@Synced() accessor age = 0;`). This also fixes field
  synchronization in frameworks like React, which never worked correctly under the legacy
  decorator.
- **Breaking:** Colibri now targets TypeScript (5.0 or newer). `@Synced()` is a TypeScript
  decorator, and the documentation, samples and tests all assume a TypeScript project; the
  plain-JavaScript sample ports were removed again. Projects that are tied to plain
  JavaScript can fall back on the workaround documented in the repository.
- **Breaking:** the socket handshake `version` query bumped from `'1'` to `'2'` to mark the
  2.0 client line. This field is informational only on the server side and does not change
  wire compatibility with existing `colibri-server` deployments.
- `rxjs` moved from a regular dependency to a `peerDependency`, since its types are part of
  this package's public API (`SyncModel`, `RegisterModelSync`, `Colibri.messages`).

### Fixed

- `ColibriError` is now a named export, fixing `import { ColibriError } from '@hcikn/colibri'`,
  which previously failed silently because a default export is not re-exported by `export *`.
- Removed a stray `console.log` on every model registration that, combined with `RemoteLogger`,
  produced unnecessary network traffic to the server.
- The published npm package now includes a `LICENSE` file.
- Hardened the `exports` map so `require()` consumers get their own `.d.cts` type
  declarations instead of sharing the ESM `.d.ts`.

### Added

- A full Vitest unit-test suite covering `Colibri`, `Broadcasting`, `RemoteLogger`,
  `SyncModel`, and `ModelSynchronization`.
