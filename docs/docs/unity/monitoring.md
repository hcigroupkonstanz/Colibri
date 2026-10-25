---
sidebar_position: 8
title: Monitoring
---

# Monitoring

Colibri gives you two places to watch what your app does: the server's monitoring page in the browser, and the
*Colibri Status* window in the Unity Editor. The monitoring page also shows the Unity console log of every client,
which is the easiest way to read the log of an app built for a smartphone or head-mounted display.

## Monitoring page

The server's web page at `http://<server-address>:9211` shows:

- the connected clients with their latency and throughput. Unity clients appear under their device name.
- the synchronized objects and their values
- the log of the server and, with the `[RemoteLogger]` prefab, of your clients

In the Unity Editor, *Window → Colibri Status → Open Server Web UI* opens this page. See
[Monitoring](../server/monitoring.md) in the server documentation for everything the page offers.

## Client log

To see a client's Unity console log on the monitoring page, add the `[RemoteLogger]` prefab from
`Packages/Colibri/Runtime/Prefabs/` to the scene. This needs no code. The log then appears on the page's *Log* tab, with the
app name and device name of each client.

![The Log tab of the monitoring page](/img/unity/admin-log.png)

- `[RemoteLogger]` sends everything that appears in the Unity console: `Debug.Log` as info, `Debug.LogWarning` as
  warning, and errors and exceptions as error, with their stack trace.
- It sends the log once per second. Identical lines within one second are sent once.
- Between two sends, it keeps at most the newest 1000 lines. While the client is disconnected, it keeps the lines and
  sends them once the connection is back.
- Where lines were dropped, the log shows one line instead:
  `Colibri: N log lines are missing here …`. The device's own log keeps everything.
- `[RemoteLogger]` opens the connection to the server itself, so it also works in a scene without other Colibri
  features.

:::warning
The log is visible to everyone who can open the monitoring page. Do not log sensitive data.
:::

A client that cannot connect cannot send its log either. To find out why a headset does not connect, show the
connection state in your app. See [Connection state in code](./troubleshooting.md#connection-state-in-code).

## Colibri Status window

In Play mode, *Window → Colibri Status* shows what the client in this Editor is doing:

- the configured app name and server, and whether the project is configured at all
- the connection state, server and app name of the running connection
- whether the server's heartbeat arrives, and for how long it has been missing
- with TLS, how the server's certificate was accepted and its SHA-256 fingerprint
- the delivery rate in frames per second. Below 20, the window warns that received messages wait for the next frame,
  usually because the Editor is in the background without [Run In Background](./configuration.md#run-in-background).
- when not connected, why the last attempt failed
- the channels with listeners and the type each listener expects
- the last 20 messages sent and received

The *Colibri Configuration* button opens the [Colibri Setup window](./configuration.md).

Outside Play mode, the window shows only the configuration. The connection exists only while the game runs, from the
first `Sync.Send`, `Sync.Receive` or `SyncBehaviour` on.
