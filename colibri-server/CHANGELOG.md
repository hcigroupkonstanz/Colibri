# Changelog

All notable changes to the Colibri server. Upgrading from Colibri 1: [Migration Guide](../MIGRATION.md).

## [2.0.0] - Unreleased

Works only with Colibri 2 clients. Colibri 1 clients are refused, and the log names each of them.

### Changed

- **Breaking:** the default ports are 9211 (web), 9212 (Unity) and 9213 (voice) instead of 9011, 9012 and 9013. A
  Colibri 1 and a Colibri 2 server can run side by side.
- **Breaking:** voice chat is separated per app. Only clients with the same app name hear each other. Voice through
  a UDP proxy needs the proxy in `TRUSTED_PROXIES`.
- **Breaking:** the data store accepts only the media type `application/vnd.colibri.v2+json`. Both Colibri 2 clients
  send it.
- **Breaking:** running without Docker needs Node.js 24 or newer.
- The Docker image runs the server as the non-root user `node` (uid 1000) and takes over the data directory on
  startup. It is about half as large and has a health check.
- The data store accepts any JSON value up to 5 MiB, not only objects and arrays up to 100 kB.
- The server forgets a deleted object only after `MODEL_TOMBSTONE_SECONDS` (10 minutes), so an old update from
  another client can no longer bring it back.

### Added

- Optional TLS on the web and Unity ports with `TLS_CERT` and `TLS_KEY`. A renewed certificate is picked up without
  a restart.
- The log is printed to the console, so `docker logs` shows it. `CONSOLE_LOG_LEVEL` sets the level.
- The monitoring page lists every client with its app, address, latency and messages per second, and shows the
  synchronized objects. The log page filters by level and app, and works on phones.
- Unity clients that send nothing for 10 seconds are disconnected (`TCP_IDLE_TIMEOUT_SECONDS`), so a headset that
  went to sleep no longer stays connected.
- Load limits per client (`CLIENT_MESSAGE_RATE_LIMIT`) protect the server from clients that send too much.
- A warning when an app has more than 8 clients, usually because several projects use the same app name.
- Support for reverse proxies with `TRUSTED_PROXIES`, so the log shows the clients' real addresses.

### Fixed

- The data of an app is no longer deleted when the last client of another app with a similar name disconnects, e.g.
  app `test2` when app `test` is closed.
- A data directory the server cannot write to is reported at startup. Before, the server pretended to save.
- The server shuts down cleanly on `docker stop`.
