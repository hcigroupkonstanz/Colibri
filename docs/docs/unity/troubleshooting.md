---
sidebar_position: 9
title: Troubleshooting
---

# Troubleshooting

This page lists common problems and the console messages Colibri logs, with their causes and fixes.

Start with *Window → Colibri Status* in Play mode. It shows the connection state, app name, last connection error,
channels with listeners and the last 20 messages. See [Colibri Status window](./monitoring.md#colibri-status-window).
On a headset or smartphone, add the `[RemoteLogger]` prefab and read the log on the server's
[monitoring page](./monitoring.md#client-log).

## Common problems

| Symptom | Cause | Fix |
|---|---|---|
| Two connected clients do not see each other | Different app names | Use the same app name. The console line `Colibri: connected to <host>:<port> as app '<app>'. …` shows the name in use. |
| One client shows *Connected* but sends and receives nothing | Its Editor is in the background with *Run In Background/Run Without Focus* off | Enable [Run In Background/Run Without Focus](./configuration.md#run-in-background) |
| Messages of one type never arrive | Type mismatch, e.g. `int` sent and `float` received | Send and receive the same type on a channel. Receive numbers from web clients as `float`. See [Type mismatches](./messages.md#type-mismatches). |
| A `SyncBehaviour` object never syncs | `void Awake()` hides the base method (warning CS0114) | Declare it `protected override` and call `base.Awake()` ([Awake and OnDestroy](./syncbehaviour.md#awake-and-ondestroy)) |
| Destroying a `SyncBehaviour` does not delete it on the other clients | `void OnDestroy()` hides the base method (warning CS0114) | Declare it `protected override` and call `base.OnDestroy()` |
| An object placed in the scene does not sync, or appears twice | Its `Id` is empty, so it gets a new random `Id` on each client | Click *Generate ID* on the `SyncTransform`, or enter an `Id` on your `SyncBehaviour` ([SyncTransform](./synctransform.md#getting-started)) |
| An object jumps back to an old position when a client starts | A script changes it in `Start`, which counts as a change for everyone | Set starting values in the scene or prefab ([Server state](./synctransform.md#server-state-and-late-joiners)) |
| Objects created at runtime do not appear on other clients | No manager for the prefab, or the `ModelId` does not match | Add a manager with the prefab as `Template` ([Objects created at runtime](./synctransform.md#objects-created-at-runtime)) |
| `Store.Get` or `Store.Put` fails | Wrong server address, or plain HTTP blocked ("Insecure connection not allowed") | Check the URL in the log. Allow HTTP or enable TLS ([Allow downloads over HTTP](./configuration.md#allow-downloads-over-http)). |
| `NullReferenceException` in `TMP_Settings` in a sample scene | TextMeshPro essential resources missing | *Window → TextMeshPro → Import TMP Essential Resources* ([TextMeshPro resources](./installation.md#textmeshpro-resources)) |
| Unknown objects or messages appear | Another project uses the same app name. Unity reports nothing. | Choose a unique [app name](./configuration.md#app-name). The server log warns when an app has more than 8 clients. |
| Works in the Editor but not on the Quest | Android Player settings, or a server address the headset cannot reach, such as `localhost` | Use the server's LAN IPv4 address. Fix the settings named in the `Colibri (Android build): …` and `Colibri (build): …` warnings ([Build settings check](./configuration.md#build-settings-check)). |
| UniRx or UniTask errors after installing | Colibri 1 is installed | Install Colibri 2 ([Installation](./installation.md)) |

## Console messages

### Connection

| Message | Cause | Fix |
|---|---|---|
| `Colibri is not configured yet. Open Window -> Colibri Configuration…` | No app name set | Enter an app name and click *Save Config* |
| `Colibri: 192.168.0.10:9212 did not answer within 5 s. …` | Wrong IP address, server on another network or subnet, Wi-Fi client isolation, or a firewall | Fix the address or the network |
| `Colibri: connection to 192.168.0.10 failed (ConnectionRefused), retrying...` | The computer is reachable, but nothing listens on the TCP port | Start colibri-server, or check *TCP server Port* |
| `… failed (HostUnreachable) …`, `(NetworkUnreachable)` or another socket error | Wrong address or network | Fix the address or the network |
| `Colibri: no connection to 192.0.2.10:9212 within 2.5 s, trying [2001:db8::1]:9212` or `Colibri: no connection to 192.0.2.10:9212 (…), trying …` | The server name has several addresses and this one does not work from here. Colibri tries the next one. | Nothing, if the next address connects. But voice chat still uses the first IPv4 address and is not heard ([Server addresses](./configuration.md#server-addresses)). Make the address reachable, or remove it from DNS. |
| `Colibri: colibri.example.org could not be resolved within 5 s. …` | The device's DNS server does not answer | Check the network, or use the server's IP address |
| `Colibri: invalid frame from server, dropping connection: …`, then `Colibri: 3 connections in a row were accepted but ended before a single frame could be read. …` | A Colibri 1 server, an address that is not a colibri-server, or TLS on the server only. Without TLS, also a proxy or port forwarding whose server is not running. | Use a Colibri 2 server, correct the address, tick *Server supports SSL/TLS?*, or start the server behind the proxy |
| `Colibri: 192.168.0.10:9212 accepted the connection but has not sent anything in 2 s, dropping it`, then `Colibri: 3 connections in a row to 192.168.0.10:9212 were accepted, but nothing was received on any of them: …` | A proxy or port forwarding whose server is down, a captive portal or a firewall accepts the connection, then closes it or forwards nothing. Or the server does not answer or is not a colibri-server. | Check that colibri-server is running and reachable at that address and port |
| `… did not answer the TLS handshake …` or `rejected the certificate of …` | The TLS settings do not match the server | See [TLS errors](#tls-errors) |
| `Colibri (Android build): …` or `Colibri (build): …` | A Player setting that fails only in the built app (*Internet Access*, *Allow downloads over HTTP*) | Click the fix button in *Window → Colibri Configuration* ([Build settings check](./configuration.md#build-settings-check)) |

Colibri keeps retrying after each of these errors, so you do not need to restart the app after fixing the server or
network.

### Messages and synchronized objects

| Message | Cause | Fix |
|---|---|---|
| `Colibri: a float arrived on channel 'chat', but the listener registered there expects string. …` | Sender and listener use different types on the channel | Use the same type on both sides ([Type mismatches](./messages.md#type-mismatches)) |
| `Colibri: cannot receive '<type>' on channel '<channel>' - supported types are …` | `Sync.Receive` with an unsupported type | Receive a `JToken` and convert it ([Sending other types as JSON](./messages.md#sending-other-types-as-json)) |
| `Colibri: received a … on channel '…' that cannot be read as …` | A value that does not fit the type, e.g. from a web client | Send a value of the expected type |
| `Colibri: a listener for … on channel '…' threw an exception. …` | Your listener threw an exception | Fix the listener. The exception follows in the message. |
| `Colibri: more than 256 messages are waiting for the connection to come back, …` | Many messages sent during an outage | See [Connection and outages](./messages.md#connection-and-outages) |
| `Colibri: more than 10000 messages are waiting to be sent…` | The network is too slow for the traffic, or a long outage | Send less, or lower the [send rate](./syncbehaviour.md#send-rate) |
| `Colibri: … received messages waited for Update, which did not run for a while…` | The app was paused, or the Editor was in the background without *Run In Background* | Enable [Run In Background](./configuration.md#run-in-background). On a headset, this is normal after taking it off. |
| `Colibri: cannot synchronize '<class>.<member>' …` at startup | A `[Sync]` member with an unsupported type, a property without both a getter and a setter, or a `readonly` field | Follow the message. Sync your own classes as `JObject` ([Sync members](./syncbehaviour.md#sync-members)). |
| `No generic Colibri SyncManager found (without ModelId) …` or `No Colibri SyncManager found (ModelID '…') …` | No manager for this object type and `ModelId` in the scene | Add a `[SyncTransformManager]` or your `SyncBehaviourManager` ([Objects created at runtime](./synctransform.md#objects-created-at-runtime)) |
| `Scene contains multiple overlapping SyncTransform IDs!` | Two `SyncTransform`s have the same `Id`, e.g. after duplicating an object | Click *Generate ID* on the copy |
| `Warning: Multiple instances of '…' detected with overlapping ModelID. …` | Two managers handle the same `ModelId` | Keep one manager per `ModelId` |
| `Colibri: '…' received model '…' on channel '…', which is not in this scene, and has no Template to build it from. …` | Another client created an object, and the manager has no `Template` | Set the manager's `Template` |
| `Colibri: no connection to a server for 5 s, so placed SyncTransforms with a Rigidbody and PhysicsAuthority ticked are simulated without the server's state; …` | No server reached | Start colibri-server before the clients, or check the server address ([Physics](./synctransform.md#physics)) |

### Data store

| Message | Cause | Fix |
|---|---|---|
| `Colibri: could not save "<name>" at <url> …`, `could not load …` or `could not delete …` | A failed request. The message names the URL, the error and the HTTP status. HTTP 404 means nothing is saved under the name. | Check the server address and app name. For "Insecure connection not allowed", see [Allow downloads over HTTP](./configuration.md#allow-downloads-over-http). |
| `Colibri: could not save "<name>" - … cannot be converted to JSON: …` | The value cannot be converted to JSON | See [What can be saved](./data-store.md#what-can-be-saved) |
| `Colibri: could not load "<name>" as … - what the server holds does not fit it: …` | The saved value does not fit the type in `Store.Get<T>` | Load it with the type it was saved as |

### TLS errors

| Message | Cause | Fix |
|---|---|---|
| `<host:port> did not answer the TLS handshake …` or `<host:port> accepted the connection but did not answer the TLS handshake within 5 s` | The server has no TLS | Enable TLS on the server, or untick *Server supports SSL/TLS?* |
| `rejected the certificate of <host:port>: it is self-signed …` | Self-signed certificate, neither pinned nor allowed | Pin its fingerprint, or tick *Allow self-signed certificate* ([Certificates](./configuration.md#certificates)) |
| `… it expired on <date>` | Expired certificate | Renew it on the server |
| `… it is not issued for '<address>'` | The certificate does not cover the *Server Address* | Connect by a name it covers, pin it, or allow self-signed certificates |
| `… its SHA-256 fingerprint is <X>, not the one in 'Server certificate SHA-256' …` | The server's certificate was replaced | Copy the new fingerprint from the server log |
| `… This usually means a protocol mismatch … tick 'Server supports SSL/TLS' …` | TLS on the server only | Tick *Server supports SSL/TLS?* |

Each TLS error is logged once as an error, then as an info line on each retry. The client keeps retrying, so fixing
the server needs no app restart.

### Voice chat

| Message or symptom | Cause | Fix |
|---|---|---|
| Nobody is heard, and the server logs `Ignoring voice packet from <address>:<port> for app <app id>: no Unity client of that app is connected from <address>` | The client is not connected for messages, the voice goes through a proxy, or the client connected over IPv6 while voice uses IPv4 | Make sure the scene calls `Sync.Receive` or uses a `SyncBehaviour`. See [Requirements](./voice-chat.md#requirements) and [Server addresses](./configuration.md#server-addresses). |
| A client hears nobody | It does not broadcast itself | Start its `VoiceBroadcast` ([Requirements](./voice-chat.md#requirements)) |
| `[VoiceBroadcast] Voice Broadcast initialization failed: Microphone permission NOT granted. …` | The user refused the microphone permission on Android | Grant the permission in the device settings. Voice starts then. |
| `[VoiceBroadcast] Voice Broadcast initialization failed: No recording device found` | No microphone | Connect a microphone |
| `Colibri voice: no voice is sent without an App Name. …` | No app name set | Set an app name ([Configuration](./configuration.md)) |
| `Colibri voice: could not resolve the server address '…' (…). Voice chat is off until it works; trying again. …` | The server address cannot be resolved, e.g. on a device that is not on the network yet | Check the server address. Voice starts by itself once it resolves. |
| `Colibri voice: the server address '…' has only IPv6 addresses (…), and this device has no route to them, …` or `Colibri voice: sending to … failed (NetworkUnreachable), dropping voice until a send works again` | No route to the server's voice address, e.g. a server name with only IPv6 addresses on a network without IPv6, or a network change | Use a network with IPv6, or give the server name an IPv4 address. After a network change, voice resumes by itself. |
| `[VoiceBroadcast] Use Opus Codec is on, but …. Sending voice as PCM.` | Opus does not support this platform, sampling rate or frame size | See [Opus](./voice-chat.md#opus) |

## Connection state in code

A headset has no Status window, and `[RemoteLogger]` cannot send the log while the client is disconnected. To see
why a client does not connect, show the connection state in your app with `WebServerConnection.Instance`
(namespace `HCIKonstanz.Colibri.Networking`):

| Member | Description |
|---|---|
| `Status` | `Connecting`, `Connected`, `Reconnecting`, `Disconnected` or `ProtocolMismatch` |
| `LastConnectFailure` | Why the last attempt failed, e.g. `… did not answer within 5 s`. `null` once connected. |
| `OnConnected` | Event raised on the main thread once the server has answered |
| `OnDisconnected` | Event raised once for every `OnConnected`, when that connection ends |
| `Connected` | A `Task` that completes once connected. `await` it to wait for the connection. |
| `ProtocolMismatchReason`, `ServerVersion` | Why the server refused this client, and the server's version |
| `SuspectedProtocolMismatch` | A version mismatch that the server could not report, e.g. with a Colibri 1 server |

```csharp
using HCIKonstanz.Colibri.Networking;
using UnityEngine;
using UnityEngine.UI;

public class ConnectionLabel : MonoBehaviour
{
    public Text Label;

    void Update()
    {
        WebServerConnection connection = WebServerConnection.Instance;
        if (connection == null)
        {
            return;
        }

        if (connection.Status == ConnectionStatus.Connected)
        {
            Label.text = "Connected";
        }
        else
        {
            Label.text = connection.Status + ": " + connection.LastConnectFailure;
        }
    }
}
```

Reading `WebServerConnection.Instance` starts the connection if it is not running yet.

## Version mismatch

Colibri 2 clients work only with a Colibri 2 server.

- **Colibri 2 client, Colibri 1 server:** the server cannot report the mismatch. After three failed connections in
  a row, *Window → Colibri Status* shows a suspected version mismatch in yellow. The client keeps retrying, because
  an address that is not a Colibri server looks the same.
- **Colibri 1 client, Colibri 2 server:** the server refuses the client and logs
  `Refusing a connection from <address>: it looks like a Colibri 1.x client …`.
- **Other protocol version, e.g. a future server:** the server refuses the client with a reason, shown in red in
  *Window → Colibri Status*. `Status` becomes `ProtocolMismatch`, and the client stops reconnecting. Messages are
  dropped with a one-time warning. Update the client and server to matching versions. To try again without
  restarting the app, disable and enable the `WebServerConnection` component on the `[WebServerConnection]`
  GameObject.
