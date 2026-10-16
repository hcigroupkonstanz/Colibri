---
sidebar_position: 4
title: Protocol
---

# Protocol

This page explains how Colibri works under the hood: how clients connect, what they send, and what the server does
with it. You do not need it to use Colibri. It helps to understand what you see on the
[monitoring page](./monitoring.md), and to find the cause of a problem.

## Parts and connections

```mermaid
flowchart LR
    U["Unity clients"] <-->|"TCP 9212<br/>messages, synchronized objects, log"| S(("Colibri server"))
    W["Web clients"] <-->|"Socket.IO on 9211<br/>messages, synchronized objects, log"| S
    U <-->|"UDP 9213<br/>voice chat"| S
    U <-->|"HTTP on 9211<br/>data store"| S
    W <-->|"HTTP on 9211<br/>data store"| S
    M["Browser"] <-->|"9211<br/>monitoring page"| S
    S --- D[("Data directory<br/>store.json, voice recordings")]
```

| Connection                | Port     | Used for                                                                |
| ------------------------- | -------- | ----------------------------------------------------------------------- |
| Unity client over TCP     | 9212/tcp | Messages, synchronized objects and the client's log, in a binary format |
| Web client over Socket.IO | 9211/tcp | The same, as Socket.IO events                                           |
| Voice chat over UDP       | 9213/udp | Audio of Unity clients                                                  |
| Data store over HTTP      | 9211/tcp | Values that are saved on the server and survive restarts                |
| Monitoring page           | 9211/tcp | The [monitoring page](./monitoring.md) in the browser                   |

Unity and web clients use different connections, but the server treats their messages the same way. A message from
a Unity client reaches the web clients of its app, and the other way round. With [TLS](./configuration.md#tls), the
TCP and web connections are encrypted. Their content stays the same.

## Apps

Every client connects with an **app name**. The server keeps apps apart: a client only sees the messages,
synchronized objects and voice chat of clients with the same app name. Clients of other apps on the same server are
invisible to it.

Unity and web clients with the same app name belong to the same app. Give each project its own app name, especially
on a shared server.

:::note
The app name `colibri` is reserved for the monitoring page. Do not use it, nor the channel names `colibri`, `log`, or
names starting with `colibri::`.
:::

## What clients send

Each message has three parts: a **channel** (a name the clients choose, e.g. `position`), a **command** (what kind of
message it is) and a **payload** (the content, usually JSON).

| Kind                 | Command                                               | What the server does                                                                               |
| -------------------- | ----------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Message              | `broadcast::<type>`, e.g. `broadcast::vector3`        | Passes it to every other client of the app. Stores nothing.                                        |
| Synchronized objects | `model::request`                                      | Answers the asking client with the objects it stores                                               |
|                      | `model::update`                                       | Merges the changed fields into its copy of the object, and passes the update to every other client |
|                      | `model::delete`                                       | Removes its copy, remembers the deletion for a while, and passes it to every other client          |
| Log                  | `debug`, `info`, `warn`, `error` on the channel `log` | Writes the line into the server's log, at that level                                               |

The server also tells the clients of an app when a client joins or leaves (`client::connected`,
`client::disconnected`).

Other commands reach no other client. The server logs a warning about them. Colibri's client libraries choose the
right commands for you ([Unity messages](../unity/messages.md), [web messages](../web/messages.md)).

## Messages

A message goes from the sender through the server to every other client of the same app. It does not come back to
the sender. The server does not store it, so a client that connects later does not receive it.

```mermaid
sequenceDiagram
    participant A as Client A (app myAppName)
    participant S as Server
    participant B as Client B (app myAppName)
    participant C as Client C (app myAppName)
    participant X as Client X (app Other)
    A->>S: channel "position", broadcast::vector3 [1, 2, 3]
    S->>B: channel "position", broadcast::vector3 [1, 2, 3]
    S->>C: channel "position", broadcast::vector3 [1, 2, 3]
    Note over A,S: Not sent back to A
    Note over X: Other app: receives nothing
```

Messages suit things that change all the time, such as a position. For a state that new clients must see, use
synchronized objects or the data store.

## Synchronized objects

The server keeps a copy of every synchronized object, per app and channel. That way, a client that joins later gets
the current state.

```mermaid
sequenceDiagram
    participant A as Client A
    participant S as Server
    participant B as Client B
    Note over A: Starts
    A->>S: model::request (all objects of the channel)
    S-->>A: model::update for each object it stores
    A->>S: model::request {id: "cube"}
    S-->>A: {id: "cube"}: unknown to the server
    A->>S: model::update {id: "cube", color, size}
    Note over S: Stores the object
    S->>B: model::update {id: "cube", color, size}
    B->>S: model::update {id: "cube", color: "red"}
    Note over S: Merges the changed field
    S->>A: model::update {id: "cube", color: "red"}
    A->>S: model::delete {id: "cube"}
    Note over S: Removes the object and remembers the deletion
    S->>B: model::delete {id: "cube"}
```

- **On start**, a client requests the objects it needs. The server answers with what it has. If it has nothing for
  an object, the client sends the object's full state, and the server stores it.
- **An update** usually carries only the fields that changed. The server merges them into its copy, field by field,
  and passes the update on.
- **A delete** removes the object. For 10 minutes (`MODEL_TOMBSTONE_SECONDS`), the server remembers the deletion and
  ignores late updates for the object, so that they cannot bring it back ([Deleted
  objects](./configuration.md#deleted-objects)).
- **Only in memory:** the server forgets an app's objects when its last client leaves, and when it restarts. To keep
  data, use the [data store](#data-store).

The _Models_ page of the [monitoring page](./monitoring.md#models) shows the objects the server stores.

## Reconnects

Clients reconnect on their own when the connection breaks. Unity clients try again after 0.5 seconds, then less
often, up to every 10 seconds. After a reconnect, each client asks again for the objects it holds, and handles the
answer:

| Answer from the server | Meaning                                    | The client                 |
| ---------------------- | ------------------------------------------ | -------------------------- |
| The object             | Others may have changed it meanwhile       | Takes the changes          |
| Unknown                | The server forgot it, e.g. after a restart | Sends its full state again |
| Deleted                | Another client deleted it meanwhile        | Removes its copy           |

Both clients also notice changes that were lost when the connection broke, and send them again.

The server and the clients keep checking that a connection is alive:

| Client | Check                                                                                                                                                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unity  | The server sends a heartbeat ten times a second, and the client answers. It shows the latency. Silent for 10 seconds, the client is disconnected ([Idle timeout](./configuration.md#idle-timeout)). Without a heartbeat for 2 seconds, the client reconnects. |
| Web    | The server sends a latency check ten times a second. Socket.IO notices a lost connection within about 45 seconds.                                                                                                                                             |

## Data store

The data store keeps values on the server, in `store.json` in the data directory. Unlike synchronized objects, the
values survive restarts. Clients read and write them over HTTP on the web port. Each value belongs to an app and has
a key.

| Request                         | Result                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/store`                | The names of all apps                                                                        |
| `GET /api/store/<app>`          | The keys of the app                                                                          |
| `GET /api/store/<app>/<key>`    | The value. `404` if there is none.                                                           |
| `PUT /api/store/<app>/<key>`    | Stores the JSON value in the request body. `201` if it is new, `200` if it replaced a value. |
| `DELETE /api/store/<app>/<key>` | Deletes the value                                                                            |
| `DELETE /api/store/<app>`       | Deletes every value of the app                                                               |

Values are JSON with the media type `application/vnd.colibri.v2+json`. A `PUT` must send this `Content-Type`, or it
gets `415` and stores nothing. With curl:

```sh
curl -X PUT -H 'Content-Type: application/vnd.colibri.v2+json' -d '{"x":1}' http://localhost:9211/api/store/myAppName/myKey
curl http://localhost:9211/api/store/myAppName/myKey
```

- A value may be up to 5 MiB.
- Write app names and keys with special characters such as `/`, `?` or spaces percent-encoded.
- Any web page may use the data store, also one served from elsewhere.
- The server saves changes to `store.json` within a quarter of a second.

The client libraries do all of this for you ([Unity data store](../unity/data-store.md),
[web data store](../web/data-store.md)).

## Voice chat

Unity clients send their voice as small UDP packets to port 9213. Each packet carries an id of its app. The server
passes each packet to every other client of the same app that sends voice.

```mermaid
flowchart LR
    A["Unity client A<br/>app myAppName"] -->|"voice"| S(("Server"))
    S -->|"voice"| B["Unity client B<br/>app myAppName"]
    S -->|"voice"| C["Unity client C<br/>app myAppName"]
    S -.-x|"nothing"| D["Unity client D<br/>app Other"]
```

- The server relays voice only from an address where a Unity client of the same app is connected over TCP.
- The server learns a client's address from its voice. A client hears others only while it sends voice itself.
- Voice is not encrypted, also with TLS on.

[Voice chat](./configuration.md#voice-chat) on the Configuration page lists what the server needs.

## Protocol version

Colibri 2 changed how clients and the server talk to each other. When a client connects, it sends its protocol
version. The server accepts only its own version. Colibri 2 uses protocol version 2.

| Client          | Server    | Result                                                                                      |
| --------------- | --------- | ------------------------------------------------------------------------------------------- |
| Colibri 2       | Colibri 2 | Works                                                                                       |
| Colibri 1 Unity | Colibri 2 | Refused. The server log says `it looks like a Colibri 1.x client`. The client keeps trying. |
| Colibri 1 web   | Colibri 2 | Refused. The server log says `Unsupported protocol version '1'`. The client shows no error. |
| Colibri 2 Unity | Colibri 1 | Does not connect. The Unity client logs that the server may be too old.                     |
| Colibri 2 web   | Colibri 1 | Works, but the web client warns after 5 seconds that the server may be too old.             |

A refused client never appears on the monitoring page. Only the server's log names it.

The protocol version is not the release version. Every Colibri 2 client works with every Colibri 2 server, e.g. a
2.1 client with a 2.0 server.

## Formats on the wire

This section shows what the messages look like, byte by byte. Numbers that take more than one byte are
_little-endian_: the lowest byte comes first. Text is UTF-8.

### Unity clients (TCP)

Everything a Unity client and the server send over TCP is a **frame**. Every frame starts with the same 5 bytes:

| Byte  | Size    | Field  | Content                                                               |
| ----- | ------- | ------ | --------------------------------------------------------------------- |
| 0–3   | 4 bytes | Length | Number of bytes that follow this field: 1 for the type, plus the body |
| 4     | 1 byte  | Type   | `0x00` heartbeat, `0x01` handshake, `0x02` message                    |
| 5 – … | rest    | Body   | Depends on the type, see below                                        |

#### Handshake (type `0x01`)

The first frame a Unity client sends. It names the protocol version, the app and the device.

| Byte  | Size | Field | Content                                                                      |
| ----- | ---- | ----- | ---------------------------------------------------------------------------- |
| 5 – … | rest | Text  | `version::app::name`, e.g. `2::myAppName::Quest`. `name` is the device name. |

Example: the handshake `2::myAppName::Quest` is 24 bytes long.

| Bytes                                                      | Meaning                    |
| ---------------------------------------------------------- | -------------------------- |
| `14 00 00 00`                                              | Length: 20 bytes follow    |
| `01`                                                       | Type: handshake            |
| `32 3A 3A 6D 79 41 70 70 4E 61 6D 65 3A 3A 51 75 65 73 74` | Text `2::myAppName::Quest` |

The server sends nothing before it has accepted the handshake. Then it either adds the client to its app or refuses
it:

```mermaid
sequenceDiagram
    participant C as Unity client
    participant S as Server
    participant O as Other clients of the app
    C->>S: Opens the TCP connection
    Note over S: Sends nothing yet
    C->>S: Handshake 2::myAppName::Quest
    alt Protocol version 2
        Note over S: Adds the client to the app myAppName
        S->>O: client::connected
        S->>C: Heartbeats, ten per second
        Note over C: Connected once the first frame arrives
    else Another protocol version
        S->>C: Message colibri / protocol::rejected, with the reason
        S--xC: Closes the connection
    else No handshake within 10 seconds
        S--xC: Closes the connection
    end
```

#### Heartbeat (type `0x00`)

The server sends a heartbeat ten times a second. The client sends each one back unchanged. From the time it took,
the server measures the latency.

| Byte | Size    | Field     | Content                                   |
| ---- | ------- | --------- | ----------------------------------------- |
| 5–12 | 8 bytes | Timestamp | The server's clock when it sent the frame |

A heartbeat is always 13 bytes long, e.g. `09 00 00 00` `00` `15 CD 5B 07 00 00 00 00`.

The heartbeat also shows both sides that the connection is still alive:

```mermaid
sequenceDiagram
    participant S as Server
    participant C as Unity client
    loop Every 100 ms
        S->>C: Heartbeat with the timestamp t
        C->>S: The same heartbeat, unchanged
        Note over S: Latency = now - t
    end
    Note over S: Nothing from the client for 10 s: disconnects it
    Note over C: No frame from the server for 2 s: reconnects
```

The 10 seconds are the server's `TCP_IDLE_TIMEOUT_SECONDS` ([Idle timeout](./configuration.md#idle-timeout)).

#### Message (type `0x02`)

Every message, synchronized object and log line. With `n` the length of the channel and `m` the length of the
command:

| Byte                 | Size    | Field          | Content                                          |
| -------------------- | ------- | -------------- | ------------------------------------------------ |
| 5–6                  | 2 bytes | Channel length | `n`                                              |
| 7 – 6+n              | n bytes | Channel        | e.g. `startRound`                                |
| 7+n – 8+n            | 2 bytes | Command length | `m`                                              |
| 9+n – 8+n+m          | m bytes | Command        | e.g. `broadcast::int`, see [Payloads](#payloads) |
| 9+n+m – end of frame | rest    | Payload        | JSON, e.g. `3`. Log lines are plain text.        |

Example: the message `3` on the channel `startRound` with the command `broadcast::int`, as sent by
`Sync.Send("startRound", 3)`, is 34 bytes long.

| Bytes                                       | Meaning                  |
| ------------------------------------------- | ------------------------ |
| `1E 00 00 00`                               | Length: 30 bytes follow  |
| `02`                                        | Type: message            |
| `0A 00`                                     | Channel length: 10       |
| `73 74 61 72 74 52 6F 75 6E 64`             | Channel `startRound`     |
| `0E 00`                                     | Command length: 14       |
| `62 72 6F 61 64 63 61 73 74 3A 3A 69 6E 74` | Command `broadcast::int` |
| `33`                                        | Payload `3`              |

### Web clients (Socket.IO)

Web clients use Socket.IO, which takes care of the framing. A web client connects with the app name and the
protocol version in the address:

| Part of the connection address | Content                        |
| ------------------------------ | ------------------------------ |
| `app`                          | The app name, e.g. `myAppName` |
| `version`                      | The protocol version, `2`      |

Each message is a Socket.IO event:

| Part       | Content                                | Example            |
| ---------- | -------------------------------------- | ------------------ |
| Event name | The channel                            | `startRound`       |
| `command`  | The command, see [Payloads](#payloads) | `broadcast::float` |
| `payload`  | The content, as a JSON value           | `3`                |

The example as the data of the event `startRound`:

```json
{ "command": "broadcast::float", "payload": 3 }
```

The server converts between both formats. A message from a Unity client reaches web clients as a Socket.IO event,
and the other way round.

### Payloads

The command says what the payload contains. For messages, the clients agree on these commands:

| Command                 | Payload                         | Unity                   | Web              |
| ----------------------- | ------------------------------- | ----------------------- | ---------------- |
| `broadcast::bool`       | `true`                          | `Sync.Send(ch, bool)`   | `sendBool`       |
| `broadcast::int`        | `5`                             | `Sync.Send(ch, int)`    | (none)           |
| `broadcast::float`      | `1.5`                           | `Sync.Send(ch, float)`  | `sendNumber`     |
| `broadcast::string`     | `"text"`                        | `Sync.Send(ch, string)` | `sendString`     |
| `broadcast::vector2`    | `[x, y]`                        | `Vector2`               | `sendVector2`    |
| `broadcast::vector3`    | `[x, y, z]`                     | `Vector3`               | `sendVector3`    |
| `broadcast::quaternion` | `[x, y, z, w]`                  | `Quaternion`            | `sendQuaternion` |
| `broadcast::color`      | `"#RRGGBBAA"` or `[r, g, b, a]` | `Color`                 | `sendColor`      |
| `broadcast::json`       | any JSON value                  | `JToken`                | `sendJson`       |

Every command except `broadcast::json` also has an array form: `broadcast::vector3[]` carries `[[x, y, z], ...]`.

For synchronized objects, the payload is a JSON object with the object's `id`:

| Command          | Payload                                     | Meaning                             |
| ---------------- | ------------------------------------------- | ----------------------------------- |
| `model::request` | `{ "id": "cube" }`, or `{}` for all objects | Send me this object, or all of them |
| `model::update`  | `{ "id": "cube", "position": [1, 2, 3] }`   | These fields of the object changed  |
| `model::delete`  | `{ "id": "cube" }`                          | The object was deleted              |

The fields are the synchronized members, in lower case. Vectors are arrays, as in the table above.

### Voice chat (UDP)

Each voice packet carries 11 bytes of header, then the audio.

| Byte   | Size    | Field             | Content                                                                                      |
| ------ | ------- | ----------------- | -------------------------------------------------------------------------------------------- |
| 0–1    | 2 bytes | Voice id          | The sender's voice id. `0` is never played.                                                  |
| 2–3    | 2 bytes | Sequence          | Not used yet, so always `0`. Numbering the packets is planned.                               |
| 4–5    | 2 bytes | Frame size        | Number of audio samples in the packet                                                        |
| 6      | 1 byte  | Version and codec | High 4 bits: header version `2`. Low 4 bits: codec, `0` raw audio, `1` Opus.                 |
| 7–10   | 4 bytes | App id            | The 32-bit FNV-1a hash of the app name, so that only clients of the same app hear each other |
| 11 – … | rest    | Audio             | Raw audio: 16-bit samples. Opus: one Opus packet.                                            |

Example: the header of an Opus packet with 960 samples from voice id 7 in the app `myAppName`:

| Bytes         | Meaning                            |
| ------------- | ---------------------------------- |
| `07 00`       | Voice id 7                         |
| `00 00`       | Sequence 0 (not used yet)          |
| `C0 03`       | 960 samples (20 ms at 48 kHz)      |
| `21`          | Header version 2, codec 1 (Opus)   |
| `C5 D2 42 FC` | App id: FNV-1a hash of `myAppName` |

## Limits

| What                            | Limit                                                                      |
| ------------------------------- | -------------------------------------------------------------------------- |
| One message or object update    | About 5 MiB. A larger one closes the client's connection.                  |
| One data store value            | 5 MiB                                                                      |
| Messages and updates per client | 1000 per second by default ([Load limits](./configuration.md#load-limits)) |

## Full specification

This page leaves out the details. If you write your own client, for example in another language, read the
[full protocol specification](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-server/docs/dev/protocol.md).
