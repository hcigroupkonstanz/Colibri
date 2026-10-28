# Changelog

All notable changes to Colibri for Unity. Upgrading from Colibri 1: [Migration Guide](../MIGRATION.md).

## [2.0.0] - Unreleased

Works only with colibri-server 2.0.0 or newer.

### Changed

- **Breaking:** Unity 2022.3 or newer is required.
- **Breaking:** the default ports are 9211, 9212 and 9213 instead of 9011, 9012 and 9013. An existing configuration
  keeps its old ports. Change them in *Window → Colibri Configuration*.
- **Breaking:** UniRx and UniTask are no longer needed. `SyncBehaviour<T>.ModelCreated` and `ModelDestroyed` are
  events: subscribe with `+=` and unsubscribe with `-=` yourself.
- **Breaking:** `WebServerConnection.Connected` is a `Task`. Use the events `OnConnected` and `OnDisconnected`
  instead of subscribing to it.
- **Breaking:** `ObservableModel<T>` and `ObservableManager<T>` were removed. Use `SyncBehaviour<T>` and
  `SyncBehaviourManager<T>`.
- **Breaking:** Newtonsoft JSON is installed as a package. Delete your own copy of `Newtonsoft.Json.dll`.
- **Breaking:** samples are no longer part of your project until you import them in the Package Manager.
- **Breaking:** `Store` saves public fields and properties. A private `[SerializeField]` field is no longer saved.
- **Breaking:** `LockFreeQueue<T>` was removed. Use `ConcurrentQueue<T>`.
- **Breaking:** *Server supports SSL/TLS?* also encrypts the connection to the server, not only the data store.
- A synchronized object sends at most 30 updates per second, set by *Max Send Rate*.
- A change made in `Start`, before the server's state arrives, is no longer undone and applies to everyone.
- Voice chat is separated per app name. Only clients with the same app name hear each other.

### Added

- *Window → Colibri Status*: connection state, app name, last error, the channels with listeners and the last
  messages.
- TLS for the connection to the server, with optional self-signed certificates and certificate pinning.
- *Max Send Rate* in *Window → Colibri Configuration*.
- A 10 second timeout for all `Store` requests. Before, a wrong server address made them wait forever.
- Warnings for an app name others probably use too, such as `test`, and for player settings that break a build,
  such as *Internet Access* on Android.
- The `Network Stress` sample, to find out how many objects your setup can sync.

### Fixed

- After a reconnect, synchronized objects are updated with what changed during the outage.
- A change made just before a connection drop is no longer lost.
- An object deleted by another client stays deleted.
- `Sync.Receive` listeners of a destroyed script are removed automatically. Before, they could break the delivery of
  other messages.
- A message whose type does not match the listener is reported in the console instead of being dropped silently.
- Strings sent with `Sync.Send` arrive as sent, also on web clients.
- Servers reached over IPv6 work.
- A connection attempt that gets no answer is given up after 5 seconds and retried.
- Voice chat works with IL2CPP and on Android, and does not freeze the app when encoding fails.
- The package compiles for Android with Unity 2022.3.
- The samples work with URP.
