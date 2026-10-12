# Colibri Unity

Unity client for [Colibri](../README.md) with pub/sub messages, synchronized objects, a
[key-value store](docs/guide.md#remote-store), [remote logging](docs/guide.md#web-interface-for-logging) and
[voice chat](docs/guide.md#voice-chat).

Full documentation: [docs/guide.md](docs/guide.md). Upgrading from 1.x: [MIGRATION.md](../MIGRATION.md).
Release notes: [CHANGELOG.md](CHANGELOG.md).

## Requirements

- Unity 2022.3 LTS or newer
- [colibri-server](../colibri-server/README.md#installation) 2.0.0 or newer. 1.x and 2.x
  [do not interoperate](docs/guide.md#requirements).

## Installation

In *Window → Package Manager → + → Install package from git URL*, enter:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

- The Package Manager must list **Colibri 2.0.0** or newer. UniRx or UniTask errors indicate a 1.x install.
- To pin a [release](https://github.com/hcigroupkonstanz/Colibri/releases), append its tag after the path:
  `https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri#v2.0.0`
- The git URL installs the dependency `com.unity.nuget.newtonsoft-json`. With the
  [`.unitypackage`](docs/guide.md#unitypackage) from the release page, add it manually in the Package Manager.

## Quick start

1. In *Window → Colibri Configuration*, set **App Name** and **Server Address**, then click *Save Config*.
   - Clients exchange data only if their app names match. Use a name that is unique on the server, not a
     common one such as `test` or `myAppName`.
   - The address is a host name or IP address without `http://`. The preset public test server
     `colibri.hci.uni-konstanz.de` works only while it runs colibri-server 2.x.
2. Enable *Project Settings → Player → Resolution and Presentation → **Run In Background***. Otherwise a
   background Editor shows *Connected* but sends nothing and calls no listeners.
3. Import the **SendData** sample from *Window → Package Manager → Colibri → Samples*. Its scene requires
   [TextMeshPro essential resources](docs/guide.md#samples).
4. Copy the `Assets`, `Packages` and `ProjectSettings` folders to a new folder and open it from Unity Hub as
   a second client. Unity cannot open one project twice.
5. Open the sample scene in both Editors and enter Play mode. Enable `SendProperties` on the `[ClickMe]`
   object in one Editor. The other Editor logs `Received message with value …`.

## Usage

### Messages

```c#
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Thermometer : MonoBehaviour
{
    // Register before anything is sent. Messages without a listener are dropped.
    void Start() => Sync.Receive<float>("temperature", OnTemperature);
    void OnTemperature(float t) => Debug.Log($"temperature {t}");

    // Reaches all other clients with the same app name, not this one.
    public void Report(float t) => Sync.Send("temperature", t);
}
```

- Channel and type must match on both sides.
- Supported types: `bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` and arrays
  of these. Send other types as [`JToken`](docs/guide.md#sending-data-between-clients).
- Listeners that are methods of a `MonoBehaviour` are removed when it is destroyed. Remove other listeners
  with `Sync.Unregister`.

### SyncTransform

- Add `SyncTransform` to a GameObject to sync its active state, position, rotation and scale.
- Late joiners receive the current state. The server discards the state when the app's last client disconnects.
- Move an object from one client at a time. Concurrent updates make it jitter.
- For objects instantiated at runtime, add the `[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/`
  to the scene and set its `Template` to the object's prefab. Give the prefab a `ModelId` and leave its `Id`
  empty ([details](docs/guide.md#synctransform)).

### SyncBehaviour

```c#
public class Player : SyncBehaviour<Player>
{
    [Sync] public int Score;

    // Call the base method. A plain `void Awake()` compiles with warning CS0114, but the object never syncs.
    // Override OnDestroy the same way, or destroying the object does not delete it on other clients.
    protected override void Awake() { base.Awake(); /* your code */ }
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Add `PlayerManager` to the scene and set its `Template` to a `Player` prefab ([details](docs/guide.md#syncbehaviour)).

## Configuration

*Window → Colibri Configuration* saves to `Assets/Resources/ColibriConfig`. Ports, TLS and the voice sampling
rate under *Optional Config* must match the server ([options](docs/guide.md#configuration)). The default ports are
9211 (web), 9212 (TCP) and 9213 (voice). A configuration saved by 1.x keeps 9011 to 9013
([default ports](../MIGRATION.md#default-ports)).

- For a server with [TLS](docs/guide.md#tls), tick *Server supports SSL/TLS?*. For a self-signed certificate,
  also paste the fingerprint from the server log into *Server certificate SHA-256*. Voice chat stays unencrypted.
- Without TLS, `Store` calls to a server other than `localhost` need *Player → Other Settings → Allow
  downloads over HTTP* set to *Always allowed* ([details](docs/guide.md#advanced-configuration)).

## Meta Quest

- Switch the platform to Android. In *Player → Other Settings*, set *Scripting Backend* to IL2CPP, *Target
  Architectures* to ARM64 and *Internet Access* to *Require*. Otherwise the app never connects.
- On a headset, `localhost` is the headset. Use the server's IPv4 address on the LAN.
- For the Android target, *Window → Colibri Configuration* checks *Internet Access* and *Allow downloads over
  HTTP* and offers fixes ([details](docs/guide.md#meta-quest-and-android)).

## Troubleshooting

In Play mode, *Window → Colibri Status* shows the connection state, app name, last connection error, channels
with listeners and the last 20 messages. All console messages: [guide](docs/guide.md#troubleshooting).

| Symptom | Cause | Fix |
|---|---|---|
| Two connected clients do not see each other | Different app names | Use the same app name. The connect log line shows the name in use. |
| One client shows *Connected* but sends and receives nothing | Its Editor is in the background with *Run In Background* off | Enable *Run In Background* |
| `a float arrived on channel 'chat', but the listener registered there expects string…` | Type mismatch | Send and receive the same type on a channel |
| `… did not answer within 5 s` | Wrong address, another network, Wi-Fi client isolation or a firewall | Check the address and the network |
| `… failed (ConnectionRefused), retrying...` | No process listens on the TCP port | Start colibri-server or correct *TCP server Port* |
| `… This usually means a protocol mismatch…` | 1.x server, not a colibri-server, TLS on the server only, or (TLS off) a proxy or port forwarding whose backend is down | Use a 2.x server, correct the address, tick *Server supports SSL/TLS?* or start the server behind the proxy |
| `… nothing was received on any of them…` | A proxy, port forwarding, captive portal or firewall that closes connections or forwards nothing, or a server that does not answer or is not a colibri-server | Check that colibri-server is running and reachable at that address and port |
| `… did not answer the TLS handshake` or `rejected the certificate of …` | TLS settings do not match the server | See [TLS errors](docs/guide.md#tls-errors) |
| A `SyncBehaviour` object never syncs | `void Awake()` hides the base method (warning CS0114) | Declare it `protected override` and call `base.Awake()` |
| `Store.Get` or `Store.Put` fails | Wrong server address, or plain HTTP blocked ("Insecure connection not allowed") | Check the URL in the log. Allow HTTP or enable TLS, see [Configuration](#configuration). |
| `NullReferenceException` in `TMP_Settings` in a sample scene | TMP Essential Resources missing | *Window → TextMeshPro → Import TMP Essential Resources* ([details](docs/guide.md#samples)) |
| Unknown objects or messages appear | Another project uses the same app name | Choose a unique app name |
| Works in the Editor but not on the Quest | Android Player settings, or a server address the headset cannot reach such as `localhost` | See [Meta Quest](#meta-quest) and the `Colibri (Android build): …` and `Colibri (build): …` warnings |

## Testing

```sh
node colibri-unity/run-tests.mjs             # from the repository root, EditMode and PlayMode
node colibri-unity/run-tests.mjs --editmode  # unit tests only, no server
```

PlayMode starts a colibri-server with Docker Compose unless one listens on port 9212 ([details](docs/guide.md#running-the-tests)).

## License

Copyright (c) HCI Group University of Konstanz. All rights reserved. Licensed under the [MIT](../LICENSE)
license. Third-party libraries: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt).
