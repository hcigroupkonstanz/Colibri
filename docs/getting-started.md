# Getting started with Colibri

## Prerequisites

- Unity 2022.3 or newer
- A colibri-server 2.x, [self-hosted](../colibri-server/README.md#installation) or shared. Colibri
  Unity 2.x cannot connect to a 1.x server.

## Installation

In *Window → Package Manager → + → Install package from git URL*, enter:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

The Package Manager must list **Colibri 2.0.0** or newer. UniRx or UniTask errors indicate a 1.x
install. Remove it and install again with a [release tag](https://github.com/hcigroupkonstanz/Colibri/releases)
appended to the URL, e.g. `#v2.0.0`.

## Configuration

Open *Window → Colibri Configuration*, set **Server Address** and **App Name**, and click *Save Config*.

- Enter the server address as a host name or IP address without `http://`. The preset public test
  server `colibri.hci.uni-konstanz.de` works only while it runs colibri-server 2.x.
- Use the same app name on all clients that exchange data. Choose one no other project on the
  server uses, e.g. `museum-ar-prototype` instead of `test`. Projects with the same name share data.

Enable *Project Settings → Player → Resolution and Presentation → **Run In Background***. Required
for two clients on one machine. Otherwise the Editor pauses the game when it loses focus. The
client still shows *Connected* but sends nothing and calls no listeners.

## Sending messages

```csharp
using HCIKonstanz.Colibri.Synchronization;

// Sender
Sync.Send("Temperature", 21.5f);

// Receiver
private void Start()
{
    Sync.Receive<float>("Temperature", OnTemperature);
}

private void OnTemperature(float value)
{
    Debug.Log($"Temperature: {value}");
}
```

- Channel and type must match. The console logs a type mismatch.
- Register listeners before anything is sent. Messages without a listener are dropped.
- A client does not receive its own messages. Test with a second client, either a build of the
  scene or a copy of the project's `Assets`, `Packages` and `ProjectSettings` folders opened from
  Unity Hub. Unity cannot open one project twice.
- Listeners that are component methods, or lambdas that use component members, are removed with the
  component. Remove other listeners, or stop listening earlier, with
  `Sync.Unregister<float>("Temperature", OnTemperature)`.

### Supported types

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` and arrays of these.
Send other types as `JToken`:

```csharp
using Newtonsoft.Json.Linq;

Sync.Send("Readings", JToken.FromObject(new Reading { Sensor = "left", Value = 7 }));

Sync.Receive<JToken>("Readings", OnReading);
private void OnReading(JToken token)
{
    Debug.Log(token.ToObject<Reading>().Sensor);
}
```

## Synchronizing transforms

Add **`SyncTransform`** to a GameObject to sync its position, rotation, scale and active state.

- Late joiners receive the current state. When the app's last client disconnects, the server
  discards the state. Persist data with the [Store](#storing-data-on-the-server).
- `SyncPosition`, `SyncRotation`, `SyncScale` and `SyncActive` select the synchronized values.
  Disabling one stops this client from sending or applying that value.
- Destroying a synchronized object or unloading its scene deletes it on all clients. Leaving Play
  mode or quitting does not.
- For objects instantiated at runtime, add the **`[SyncTransformManager]`** prefab from
  `Packages/Colibri/Prefabs/` to the scene and set its `Template` to the object's prefab. Set a
  `ModelId` on the prefab and leave its `Id` empty ([details](../colibri-unity/docs/guide.md#synctransform)).
- Move an object from one client at a time. Concurrent updates make it jitter.

## Synchronizing custom data

Derive from `SyncBehaviour<T>`, where `T` is the class itself. Mark synchronized members with `[Sync]`.

```csharp
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Player : SyncBehaviour<Player>
{
    [Sync] public string Name = "";
    [Sync] public int Score;
    [Sync] public Color Team;

    protected override void Awake() { base.Awake(); /* your code */ }
}

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Add `PlayerManager` to the scene and set its `Template` to a `Player` prefab. Changes to `[Sync]`
members and new `Player` objects propagate to all clients.

- `[Sync]` works on public and private fields and properties of the
  [supported types](#supported-types). Use a `JObject` for custom classes.
- Only changed members are sent. Assigning an unchanged value sends nothing.
- Override `Awake` and `OnDestroy` as shown and call the base method. A plain `void Awake()`
  compiles with warning CS0114, but the object never syncs. Without `base.OnDestroy()`, destroying
  the object does not delete it on other clients.

## Storing data on the server

`Store` saves values on the server. They persist after all clients disconnect.

```csharp
using HCIKonstanz.Colibri.Store;

await Store.Put("highscores", myScores);
var scores = await Store.Get<ScoreTable>("highscores");
```

- Any value Json.NET can serialize works, up to 5 MiB.
- If the server is unreachable, the call fails after 10 s. The console logs the error and the URL.
- Without TLS, a server other than `localhost` requires *Player → Other Settings → Allow downloads
  over HTTP* set to *Always allowed*. Otherwise calls fail with "Insecure connection not allowed".
- There is no access control. Anyone who can reach the server can read, change and delete stored
  data. Do not store personal data, such as recordings of study participants.

## Remote logging

Add the **`[RemoteLogger]`** prefab from `Packages/Colibri/Prefabs/` to the scene. `Debug.Log`
output then appears at `http://<your-server>:9211`.

## Meta Quest

Switch the platform to Android in *File → Build Settings* (*File → Build Profiles* in Unity 6). In
*Project Settings → Player → Other Settings*, set *Scripting Backend* to IL2CPP and *Target
Architectures* to ARM64.

| Player setting | Required value | Symptom if wrong |
| --- | --- | --- |
| Internet Access | *Require* | The app never connects |
| Allow downloads over HTTP | *Always allowed*, if TLS is off and the server is not `localhost` | `Store` calls fail with "Insecure connection not allowed" |

- With the Android target active, *Window → Colibri Configuration* checks both settings and offers
  fixes. The console warns too.
- Use the server's LAN IPv4 address. On a headset, `localhost` is the headset.
- *Run In Background* has no effect on Android. A paused app sends nothing and calls no listeners.
- Code stripping keeps `[Sync]` members. Classes used only through JSON, such as with
  `JToken.FromObject` or `Store`, need *Managed Stripping Level* *Minimal*, `[Preserve]` or a
  `link.xml` ([details](../colibri-unity/docs/guide.md#meta-quest-and-android)).

## Samples

*Window → Package Manager → Colibri → Samples → Import* copies a sample into `Assets/Samples/` for
editing.

| Sample | Content |
| --- | --- |
| **SendData** | `Sync.Send` and `Sync.Receive` for every supported type |
| **SyncTransform** | Synchronized transforms, including instantiation from a template |
| **SyncBehaviour** | `[Sync]` on a custom class |
| **Remote Store** | Saving and loading data on the server |
| **Voice Chat** | Voice chat between clients |
| **Network Stress** | Load test measuring throughput, latency and dropped messages |

SendData, SyncTransform, Remote Store and Voice Chat need the TMP Essential Resources. Import them
with *Window → TextMeshPro → Import TMP Essential Resources*. On Unity 2022.3, install the
*TextMeshPro* package first if the menu is missing.

## Web client

Web and Unity clients with the same app name share data. The web client requires TypeScript 5 or newer.

```sh
npm install @hcikn/colibri@2
```

Keep the `@2`. A 2.x server refuses 1.x web clients, which connect once and then stop without an
error.

```ts
import { Colibri, Sync } from '@hcikn/colibri';

new Colibri('your-app-name', 'your-server-address');

Sync.sendNumber('Temperature', 21.5);
Sync.receiveNumber('Temperature', value => console.log(value));
```

Address formats and errors: [colibri-web Configuration](../colibri-web/README.md#configuration).
Use `https://` only for a server with TLS or behind a TLS proxy.

### Differences from Unity

- Vectors and colors are arrays, e.g. `Sync.sendVector3('pos', [1, 2, 3])` and
  `Sync.sendColor('tint', [1, 0, 0, 1])`. Colors arrive as `"#RRGGBBAA"` from Unity and as
  `[r, g, b, a]` from web clients. `toHexColor()`, `toRgbaColor()` and Unity's `ToColor` accept both forms.
- Numbers from web clients arrive in Unity as `float`. Receive them with `Sync.Receive<float>`, not
  `Sync.Receive<int>`.

## TLS

Set `TLS_CERT` and `TLS_KEY` on the server to enable [TLS](../colibri-server/docs/guide.md#tls), for
example on networks that block unencrypted TCP. In Unity, tick *Server supports SSL/TLS?* under
*Optional Config* in *Window → Colibri Configuration*. For a self-signed certificate, also paste the
fingerprint from the server log into *Server certificate SHA-256*. Web clients connect to
`https://<your-server>:9211`. Voice chat stays unencrypted.

## Troubleshooting

Open *Window → Colibri Status* while the game runs. It shows the connection, server, app name,
channels with listeners and their types, and recent messages. Symptoms and fixes:
[colibri-unity](../colibri-unity/README.md#troubleshooting), [colibri-web](../colibri-web/README.md#troubleshooting).

If the console is empty and the Status window shows *Connected* with the correct app name, check the
channel name and type on the receiving client.

## Next steps

- [Unity guide](../colibri-unity/docs/guide.md)
- [Web guide](../colibri-web/docs/guide.md)
- [MIGRATION.md](../MIGRATION.md) for projects on Colibri 1.x
