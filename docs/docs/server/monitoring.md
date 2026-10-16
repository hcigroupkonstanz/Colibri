---
sidebar_position: 3
title: Monitoring
---

# Monitoring

The server has a monitoring page that shows what happens on it: the log of the server and of every client, the
connected clients, the synchronized objects and the server's settings. Open it in a browser:

```
http://<server-address>:9211
```

With [TLS](./configuration.md#tls), use `https://` instead.

The monitoring page only shows information. Nothing on it changes, deletes or disconnects anything.

:::warning
The monitoring page has no password. Anyone who can reach the server can read the log, the connected clients, the
synchronized objects and the settings.
:::

The page has four parts, in the menu at the top: _Log_, _Clients_, _Models_ and _Server_.

## Log

![Log page](/img/server/admin-log.png)

The _Log_ page shows the log of the server and of every client that sends its log ([Client log](#client-log)).

- **Filters:** show one app, or only some levels (error, warning, info, debug). The search finds text in the loaded
  lines.
- **Sync traffic:** also shows the messages the clients send each other. Off by default, because there are many.
- **Connections:** off hides the routine lines about clients connecting and disconnecting. Warnings and errors about
  connections stay.
- **Details:** click a line for its details and a link to the clients of its app.
- **Errors and warnings:** the arrows jump to the previous or next error or warning. _New errors_ jumps to the first
  error since you opened the page.
- **Pause:** scrolling up pauses the log, so that new lines do not move it.
- **Download:** saves the lines that match the filters and the search, as text or as JSON.

The filters are part of the page's address, so a reload or a copied link keeps them, e.g.
`/log?levels=error,warn&q=timeout#myAppName`.

Times are in the browser's local time. Hover over a time to see it in UTC, as `docker logs` shows it.

The page keeps the last 20,000 log lines in the server's memory, and loses them when the server restarts. A line that
repeats is shown once per client, where it last occurred. For a complete log, use the [console](#log-in-the-console).

**Keys**, with the focus in the log: `/` search, `p` and `n` previous and next error or warning, `e` first new error.

## Clients

![Clients page](/img/server/admin-clients.png)

The _Clients_ page lists every connected Unity and web client with:

- its app, name and address
- its connection: Unity (TCP) or web, with or without TLS (_TLS (proxy)_ when a [reverse
  proxy](./configuration.md#running-behind-a-reverse-proxy) handles TLS), and its protocol version
- how long it has been connected and its latency
- the messages it sent and received per second
- whether a [load limit](./configuration.md#load-limits) holds back its updates: _Rate limit_ or _Backlog_, with the
  number of objects held

Click a column to sort by it. Show only one app with `/clients?app=myAppName`, and open a client's lines in the log. While
the mouse is over the list, its order stays fixed.

Below the list, two charts show the last 2 minutes: the latency of each client, and the messages per second of all
clients, stacked. _In_ counts what the clients sent, _Out_ what they were sent.

A client that the server refused, for example a Colibri 1 client, does not appear here. The log names it.

## Models

![Models page](/img/server/admin-models.png)

The _Models_ page shows the synchronized objects of each app, 50 to a page. For each object it shows its id, its
channel, its number of fields, its size and the time since its last update. Filter by part of an id or channel name.

Click an object to see its current value as JSON, and to download it. Very large values are cut. Below the list, the
page shows the objects deleted recently ([Deleted objects](./configuration.md#deleted-objects)).

_Refresh_ reads the list again. _Live_ updates the list and the open object every second. `Esc` closes the open
object.

## Server

![Server page](/img/server/admin-server.png)

The _Server_ page shows:

- the server's version, the commit it was built from, the protocol version, the Node.js version and the uptime
- the settings in effect, with the variables that set them: ports, TLS, reverse proxy, load limits, idle timeout,
  deleted objects and voice chat ([Configuration](./configuration.md))
- the TLS certificate's names, issuer, validity and fingerprint, with a warning 30 days before it expires
- the number of clients, apps, synchronized objects and data store values

Use it to check that a change of the configuration took effect. The page never shows certificate files or keys.

## Log in the console

The server also writes its log to the console. With Docker:

```sh
docker logs colibri
```

Add `-f` to follow new lines, and `--since 10m` for the last 10 minutes only. Each line looks like
`<time> <LEVEL> [<group>/<service>] <message>`. Errors and warnings go to stderr, the rest to stdout. Unlike the
monitoring page, this log survives a restart of the server, up to the size limit in the compose file.

The console log contains the same lines as the monitoring page, client logs included, filtered by two settings:

| Variable                        | Default | Effect                                                                         |
| ------------------------------- | ------- | ------------------------------------------------------------------------------ |
| `CONSOLE_LOG_LEVEL`             | `info`  | Least severe level printed: `error`, `warn`, `info` or `debug`                 |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | `true` also prints every message the clients send each other                   |

## Client log

Clients can send their log to the server, so that you see it on the monitoring page. This helps most with headsets
and phones, which have no console you can watch.

- **Unity:** add the `[RemoteLogger]` prefab to the scene. It sends the Unity console log
  ([Unity monitoring](../unity/monitoring.md)).
- **Web:** create a `RemoteLogger` ([web monitoring](../web/monitoring.md)).

Each line appears in the log with the client's name and app.

## Common messages in the log

| Message or symptom                                                          | Cause                                                                                   | Fix                                                                                                         |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `DATA_ROOT is not writable: <path>` at startup                              | The server cannot write to its data directory. It keeps running but saves nothing.      | Apply the fix in the message ([Installation](./installation.md#if-the-server-cannot-write-its-data))        |
| Unity clients upgraded from Colibri 1 never appear on the monitoring page   | Their configuration still has the old ports 9011 to 9013                                | Set 9211, 9212 and 9213 in Unity's _Window → Colibri Configuration_                                         |
| `Refusing a connection from <address>: it looks like a Colibri 1.x client ...` | A Unity client with Colibri 1                                                        | Update the client to Colibri 2                                                                              |
| `Refusing client '<name>' ...: Unsupported protocol version '1' ...`        | A web client with Colibri 1                                                             | Update the client to Colibri 2                                                                              |
| `Refusing a connection from <address> ...` about TLS                        | _Server supports SSL/TLS?_ in Unity does not match the server                           | Fix the TLS setting ([TLS errors](./configuration.md#tls-errors))                                           |
| A Unity client disconnects while stopped at a breakpoint                    | The debugger also pauses the client's answers to the server                             | Raise `TCP_IDLE_TIMEOUT_SECONDS` or set it to `0` ([Idle timeout](./configuration.md#idle-timeout))         |
| `App 'myAppName' now has 9 clients, more than 8 ...`                            | Several projects use the same app name                                                  | Give each project its own app name                                                                          |
| A warning naming `CLIENT_MESSAGE_RATE_LIMIT`                                | The named client sends too much, usually in every frame                                 | Send less often from that client ([Load limits](./configuration.md#load-limits))                            |
| A warning naming `TCP_INBOUND_BACKLOG_LIMIT`                                | The server receives more than it can handle                                             | Synchronize fewer objects, less often, or with fewer clients per app                                        |
| `Client '<name>' ... sent '<command>' on channel '<channel>', which the server does not handle ...` | The client sent a message the server does not pass on              | Send messages with Colibri's functions for messages ([Unity](../unity/messages.md), [web](../web/messages.md)) |
| `Ignoring voice packet ...`                                                 | The voice comes from another address than the Unity client, e.g. through a proxy or NAT | See [Voice chat](./configuration.md#voice-chat)                                                             |
| Every client is logged with the reverse proxy's address                     | The server does not trust the proxy                                                     | Set `TRUSTED_PROXIES` ([Reverse proxy](./configuration.md#running-behind-a-reverse-proxy))                  |
| The log page is empty after a restart                                       | The page keeps the log in memory only                                                   | Use `docker logs colibri`                                                                                   |

Refusals are logged at most once a minute per address. Repeats appear at debug level.
