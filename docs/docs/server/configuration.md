---
sidebar_position: 2
title: Configuration
---

# Configuration

The server works without any configuration. This page lists every setting and explains the ones you are most likely
to need: other ports, TLS, a reverse proxy, the load limits and voice chat.

## Setting a variable

Every setting is an environment variable.

**Docker:** add an `environment:` section to the service in the compose file:

```yaml
services:
    colibri:
        image: hcikn/colibri:2.0.0
        environment:
            CONSOLE_LOG_LEVEL: debug
            TCP_IDLE_TIMEOUT_SECONDS: 30
        # ... the rest as on the Installation page
```

Then run `docker compose up -d` again. Docker restarts the container with the new settings. Instead of
`environment:`, you can also mount a `.env` file at `/srv/colibri/.env`.

**Node.js:** create a `.env` file in the `colibri-server` folder, one variable per line:

```sh
CONSOLE_LOG_LEVEL=debug
TCP_IDLE_TIMEOUT_SECONDS=30
```

Then restart the server. [`.env.example`](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-server/.env.example)
lists every variable with its default. A variable set in the environment wins over the same variable in `.env`.

The [monitoring page](./monitoring.md#server)'s _Server_ page shows the settings in effect.

:::note
An invalid value stops the server at startup with a message such as `Invalid TCP_PORT: "abc" is not a valid port`.
The message names the variable. `docker logs colibri` shows it.
:::

## All variables

### Port and host variables

| Variable         | Default   | Description                                                            |
| ---------------- | --------- | ---------------------------------------------------------------------- |
| `WEBSERVER_PORT` | `9211`    | Port for the monitoring page, web clients and the data store (TCP)    |
| `TCP_PORT`       | `9212`    | Port for Unity clients (TCP)                                           |
| `VOICE_PORT`     | `9213`    | Port for voice chat (UDP)                                              |
| `WEBSERVER_HOST` | `::`      | Address the web port listens on                                        |
| `TCP_HOST`       | `::`      | Address the Unity port listens on                                      |
| `VOICE_HOST`     | `::`      | Address the voice port listens on                                      |

`::` listens on every IPv6 and IPv4 address of the server, `0.0.0.0` on every IPv4 address only. See [IPv6](#ipv6).

### Data variables

| Variable            | Default      | Description                                                                                                      |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `DATA_ROOT`         | `../../data` | Data directory with `store.db` and voice recordings. Leave it unset with Docker.                                 |
| `WEBSERVER_ROOT`    | `../ui/`     | Files of the monitoring page. You do not need to change it.                                                      |
| `STORE_EXPIRY_DAYS` | `30`         | Days after which a data store value that was not written again is deleted. `0`: never                            |
| `STORE_MAX_MB`      | `0`          | MiB that all data store values may take together. `0`: no limit                                                  |

`DATA_ROOT` and `WEBSERVER_ROOT` may be absolute paths, e.g. `DATA_ROOT=/var/lib/colibri`. A relative path starts
from the server's `dist/server` folder, so the default data directory is `colibri-server/data`. See
[Data store](#data-store) for `STORE_EXPIRY_DAYS` and `STORE_MAX_MB`.

### Logging variables

| Variable                        | Default | Description                                                                                                                              |
| ------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `CONSOLE_LOG_LEVEL`             | `info`  | Least severe level in the console log: `error`, `warn`, `info` or `debug`. The monitoring page always keeps every level.                |
| `CONSOLE_LOG_BROADCAST_TRAFFIC` | `false` | `true` also prints every message the clients send each other, whatever the level. This is a lot of output.                               |
| `STACK_TRACE_LIMIT`             | `30`    | Lines of the stack trace kept for an error in the log                                                                                    |

### Load limit variables

See [Load limits](#load-limits) below for what they do.

| Variable                       | Default | Description                                                                                                                                         |
| ------------------------------ | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLIENT_MESSAGE_RATE_LIMIT`    | `1000`  | Messages and object updates per second that one client may send. Above it, the server holds back its updates and drops its messages. `0` turns it off. |
| `CLIENT_MESSAGE_RATE_BURST`    | `2000`  | How many a client may send at once after a quieter time. At least `1`.                                                                              |
| `TCP_INBOUND_BACKLOG_LIMIT`    | `2000`  | Messages from Unity clients that may wait for the server before it holds back updates and drops messages. `0` turns it off.                          |
| `APP_CLIENT_WARNING_THRESHOLD` | `8`     | Warn when an app has more clients than this, Unity and web together. Usually several projects use the same app name. `0` turns it off.               |

### Connection variables

| Variable                   | Default | Description                                                                                                                                       |
| -------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TCP_IDLE_TIMEOUT_SECONDS` | `10`    | Seconds a Unity client may send nothing before it is disconnected ([Idle timeout](#idle-timeout)). `0` turns it off.                              |
| `MODEL_TOMBSTONE_SECONDS`  | `600`   | Seconds the server remembers a deleted synchronized object, so that an old update cannot create it again ([Deleted objects](#deleted-objects)). `0` turns it off. |

### Voice variables

| Variable              | Default | Description                                                                                               |
| --------------------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `VOICE_RECORDING`     | `false` | `true` saves the voice of each client as a `.wav` file in the data directory ([Voice recording](#voice-recording)) |
| `VOICE_SAMPLING_RATE` | `48000` | Sampling rate of the voice recordings, in Hz                                                              |

### TLS variables

| Variable   | Default | Description                                                                                             |
| ---------- | ------- | ------------------------------------------------------------------------------------------------------- |
| `TLS_CERT` | empty   | PEM file of the certificate, followed by its chain. Let's Encrypt: `fullchain.pem`.                     |
| `TLS_KEY`  | empty   | PEM file of the certificate's private key, without a passphrase. Let's Encrypt: `privkey.pem`.          |

With both set, the web and Unity ports use [TLS](#tls). Voice is not encrypted.

### Reverse proxy variables

| Variable             | Default | Description                                                                                                                                                                           |
| -------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TRUSTED_PROXIES`    | empty   | Addresses of [reverse proxies](#running-behind-a-reverse-proxy) in front of the server, separated by commas, so that the log shows the clients' own addresses. IP addresses, ranges such as `172.30.0.0/24`, and `loopback`, `linklocal`, `uniquelocal`. |
| `TCP_PROXY_PROTOCOL` | `false` | `true`: the proxy in front of the Unity port sends the PROXY protocol, which names the Unity client. Needs `TRUSTED_PROXIES`.                                                          |
| `TCP_TLS_AT_PROXY`   | `false` | `true`: the proxy in front of the Unity port handles TLS. Only changes what the monitoring page shows. Needs `TCP_PROXY_PROTOCOL=true`.                                               |
| `BASE_URL`           | empty   | Path of the monitoring page behind a reverse proxy, e.g. `/colibri`                                                                                                                  |

## Changing ports

**Docker:** change only the left side of `ports:`, the port on the host. For example, to keep the ports of Colibri 1
for existing clients and firewall rules:

```yaml
        ports:
            - 9011:9211 # web: monitoring, web clients, data store
            - 9012:9212 # Unity clients
            - "9013:9213/udp" # voice chat
```

A Colibri 1 server on the same host then needs other ports.

If you set `WEBSERVER_PORT`, `TCP_PORT` or `VOICE_PORT` with Docker anyway, publish the new port, e.g. `"9111:9111"`
for `WEBSERVER_PORT: 9111`.

**Node.js:** set `WEBSERVER_PORT`, `TCP_PORT` and `VOICE_PORT` in `.env`.

After a change, enter the new ports in the clients: in Unity's Colibri configuration
([Unity](../unity/configuration.md)), and in the server address of web clients ([web](../web/configuration.md)).

## IPv6

The server listens on IPv6 and IPv4 by default. On a server without IPv6, it listens on IPv4 only, and the log says
so. To listen on IPv4 only, for example because the firewall covers only IPv4, set:

```sh
WEBSERVER_HOST=0.0.0.0
TCP_HOST=0.0.0.0
VOICE_HOST=0.0.0.0
```

Another IPv6 address listens on that address only, without IPv4. Behind Docker's published ports or a reverse proxy,
Docker or the proxy has to listen on IPv6 as well.

:::note
Unity clients connect over IPv4 if the server's name has an IPv4 address, and over IPv6 only if it has none. If the
IPv4 address does not answer on the Unity port, the client falls back to IPv6, but its voice stays on IPv4. The
server then drops its voice ([Voice chat](#voice-chat)).
:::

## TLS

TLS encrypts the connections of the Unity and web clients and of the monitoring page. With `TLS_CERT` and `TLS_KEY`
set, the Unity port accepts only TLS, and the web port serves only HTTPS and WSS. Both use one certificate. Without
them, both stay unencrypted. There is no mixed mode, so every client must use TLS.

TLS does not add authentication: anyone who can reach the server can still join any app. Voice chat stays
unencrypted.

### Enabling TLS

1. Get a certificate and its private key as PEM files: from Let's Encrypt, from your institution, or
   [self-signed](#self-signed-certificate). The server does not create certificates. RSA and EC certificates both
   work.
2. Set `TLS_CERT` and `TLS_KEY` to the two files, as absolute paths. Set both or neither.
3. Restart the server. The log shows the certificate:

   ```
   TLS is on, with the certificate in /srv/colibri/certs/fullchain.pem and the key in /srv/colibri/certs/privkey.pem: for DNS:colibri.example.org, IP Address:192.0.2.10, self-signed, valid until 2036-10-05T12:00:00.000Z; SHA-256 fingerprint 83:88:B1:CD:...
   ```

4. Turn on TLS in every client:
   - **Unity:** tick _Server supports SSL/TLS?_ in the Colibri configuration
     ([Unity configuration](../unity/configuration.md)). For a self-signed certificate, enter the SHA-256
     fingerprint from the log as _Server certificate SHA-256_.
   - **Web clients and the monitoring page:** use `https://<server-address>:9211`
     ([web configuration](../web/configuration.md)). `http://` gets no answer, and is not redirected.

### Self-signed certificate

For a server in your lab, a self-signed certificate is enough:

```sh
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -keyout privkey.pem -out fullchain.pem -days 3650 -subj "/CN=colibri.example.org" -addext "subjectAltName=DNS:colibri.example.org,IP:192.0.2.10"
```

Replace `colibri.example.org` and `192.0.2.10` with the name and the IP address the clients connect to. For RSA, use
`-newkey rsa:2048` instead of `-newkey ec -pkeyopt ec_paramgen_curve:prime256v1`. The certificate is valid for 10
years. On Windows, Git for Windows includes openssl in `usr/bin`.

Unity apps accept the certificate by its fingerprint. A browser must trust it once: open
`https://<server-address>:9211` and accept the warning, or install the certificate.

### TLS with Docker

Put both files into a `certs` folder next to the compose file, and add:

```yaml
        environment:
            TLS_CERT: /srv/colibri/certs/fullchain.pem
            TLS_KEY: /srv/colibri/certs/privkey.pem
        volumes:
            - colibri-data:/srv/colibri/data
            - ./certs:/srv/colibri/certs:ro
```

- **Mount the folder, not the two files.** A mounted single file misses a renewal that replaces it.
- **uid 1000 must be able to read the key.** The server runs as the user `node` with uid 1000, and openssl creates
  `privkey.pem` readable for its owner only. If needed, run `sudo chown 1000 certs/privkey.pem`.
- **Let's Encrypt:** do not mount `/etc/letsencrypt/live` directly. Its files are links into another folder, and the
  key is readable for root only. Copy both files with a certbot deploy hook instead, which certbot runs after every
  renewal. For example, `/etc/letsencrypt/renewal-hooks/deploy/colibri.sh`, made executable, with
  `/opt/colibri/certs` mounted at `/srv/colibri/certs`:

  ```sh
  #!/bin/sh
  install -o 1000 -g 1000 -m 600 "$RENEWED_LINEAGE/fullchain.pem" "$RENEWED_LINEAGE/privkey.pem" /opt/colibri/certs/
  ```

  Run it once by hand for the current certificate, with `RENEWED_LINEAGE=/etc/letsencrypt/live/<your domain>`.

### Renewal

The server checks both files every 10 seconds. It uses a renewed certificate within about 20 seconds, without a
restart. Open connections keep the old one.

The server warns in the log when it cannot use new files, for example when the certificate is new but the key is not
yet. It then keeps the old certificate. It also warns when the certificate is about to expire or has expired. The
monitoring page's _Server_ page warns 30 days before the end.

### TLS errors

These messages stop the server at startup:

| Message                                                               | Fix                                                      |
| --------------------------------------------------------------------- | -------------------------------------------------------- |
| `TLS_CERT is set, but TLS_KEY is not.` (or the reverse)               | Set both or neither                                      |
| `Cannot read TLS_CERT (<path>): ...` (or `TLS_KEY`)                   | Name a PEM file the server's user can read               |
| `TLS_CERT (<path>) holds no certificate the server can use ...`       | Point `TLS_CERT` at the certificate, not at the key      |
| `TLS_KEY (<path>) holds no private key the server can use ...`        | Point `TLS_KEY` at the private key                       |
| `TLS_KEY (<path>) is not the private key of the certificate ...`      | Use the key that belongs to the certificate              |
| `TLS_KEY (<path>) is protected by a passphrase ...`                   | Remove it: `openssl pkey -in <protected key> -out <key>` |
| `TLS_CERT (<path>) and TLS_KEY (<path>) cannot serve TLS together: ...` | See the OpenSSL error in the message                   |

These appear in the log while the server runs:

| Message                                                                                     | Fix                                                                        |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `Refusing a connection from <address> (Unity client ...): it does not use TLS ...`          | Tick _Server supports SSL/TLS?_ in the Unity client                        |
| `Refusing a connection from <address>: it looks like a Colibri 1.x client, which cannot use TLS ...` | Update the Unity client to Colibri 2 and tick _Server supports SSL/TLS?_ |
| `Refusing a connection from <address>: it starts a TLS handshake, but this server's TCP port does not use TLS ...` | Untick _Server supports SSL/TLS?_, or turn on TLS on the server |
| `TLS handshake with <address> failed: ...`                                                  | The client did not accept the certificate. Follow the hint in the message. |

### TLS at a reverse proxy

Instead of the server, an existing reverse proxy can handle TLS. Leave `TLS_CERT` and `TLS_KEY` unset. For the Unity
port, use nginx's `stream` module with `listen 9212 ssl`, or a Traefik TCP router with TLS. Unity apps then tick
_Server supports SSL/TLS?_ as well. See [Running behind a reverse proxy](#running-behind-a-reverse-proxy).

TLS costs little: about 10 to 15 percent more data between Unity and the server, a little more processor time, and no
measurable delay.

## Running behind a reverse proxy

Behind a reverse proxy, such as nginx or Traefik, every client seems to come from the proxy's address: in the log, on
the monitoring page and for the server's per-address checks. `TRUSTED_PROXIES` tells the server which proxies it may
believe about the client's real address.

| Port         | How the proxy names the client                                                    | Settings                                       |
| ------------ | --------------------------------------------------------------------------------- | ---------------------------------------------- |
| Web (9211)   | The `X-Forwarded-For` and `X-Forwarded-Proto` headers                             | `TRUSTED_PROXIES`                              |
| Unity (9212) | A PROXY protocol header at the start of each connection                           | `TRUSTED_PROXIES`, `TCP_PROXY_PROTOCOL=true`   |
| Voice (9213) | Not at all. Publish the voice port directly instead of through the proxy.         | none                                           |

### With Docker

Publish the web and Unity ports on `127.0.0.1` only, so that clients reach them only through the proxy. Publish the
voice port directly:

```yaml
        ports:
            - 127.0.0.1:9211:9211 # web: monitoring, web clients, data store
            - 127.0.0.1:9212:9212 # Unity clients
            - "9213:9213/udp" # voice chat
```

A proxy on the host then connects from the gateway of the Docker network, e.g. `172.20.0.1`, which can change when
compose recreates the network. The simplest setting trusts the host and every private address:

```yaml
        environment:
            TRUSTED_PROXIES: loopback,uniquelocal
            TCP_PROXY_PROTOCOL: "true"
```

`uniquelocal` covers every private network address (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`). A
client on such a network could then claim another address, and its voice skips the
[voice check](#voice-chat). To trust only the proxy on the host, give the compose network a fixed subnet and trust its
gateway:

```yaml
        environment:
            TRUSTED_PROXIES: 172.30.0.1
            TCP_PROXY_PROTOCOL: "true"

networks:
    default:
        ipam:
            config:
                - subnet: 172.30.0.0/24 # any subnet not in use on the host
                  gateway: 172.30.0.1
```

### nginx

In each `location` that forwards to the web port:

```nginx
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
```

In the `stream` server that forwards to the Unity port:

```nginx
proxy_protocol on;
```

If that `stream` server handles TLS (`listen 9212 ssl`), also set `TCP_TLS_AT_PROXY=true`. Then the monitoring page
shows these Unity clients as _TLS (proxy)_. Nothing else depends on it.

:::warning[Order matters]
First restart the server with `TCP_PROXY_PROTOCOL=true`, then reload nginx with `proxy_protocol on`. Until both are
done, every Unity connection through the proxy fails. In this order, the log says clearly which header is missing.
:::

At startup, the log then shows:

```
Starting Colibri TCP server on [::]:9212, PROXY protocol header required from TRUSTED_PROXIES (loopback, uniquelocal)
```

### Proxy messages in the log

| Message                                                                                                            | Fix                                                             |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| `Refusing a connection from <address>: it is in TRUSTED_PROXIES and TCP_PROXY_PROTOCOL is true, but ...`           | Add `proxy_protocol on;` to the proxy                           |
| `Refusing a connection from <address>: its PROXY protocol header is invalid: ...`                                  | Check the proxy's PROXY protocol settings                       |
| `Refusing a connection from <address>: it starts with a PROXY protocol header, but its address is not in TRUSTED_PROXIES ...` | Add the proxy's address to `TRUSTED_PROXIES`, e.g. after the Docker network changed |
| `Invalid frame from client <id>, ...: Invalid frame length: 1481593424`                                            | The proxy sends the PROXY protocol, but the server does not expect it. Set `TCP_PROXY_PROTOCOL=true`. |
| `TCP_TLS_AT_PROXY is true, but ... it has no effect ...`                                                           | Turn on the PROXY protocol (`proxy_protocol on;`, `TCP_PROXY_PROTOCOL=true`), or set `TCP_TLS_AT_PROXY=false` |
| Every client appears with the proxy's address                                                                      | Set `TRUSTED_PROXIES`                                            |

`TCP_PROXY_PROTOCOL=true` with an empty `TRUSTED_PROXIES` stops the server at startup.

### Monitoring page under a path

To serve the monitoring page under a path, e.g. `https://example.org/colibri/`, set `BASE_URL=/colibri`. The data
store (`/api/store`) and the connections of web clients and the monitoring page (`/socket.io/`) stay at the root, so
the proxy must forward these two paths as well.

## Load limits

Every message and every object update goes to every other client of the app. So the server's work grows with the
square of an app's size: twice the clients means four times the work.

- **Give each project its own app name.** When an app has more than `APP_CLIENT_WARNING_THRESHOLD` (8) clients, the
  log warns, e.g. `App 'myAppName' now has 9 clients, more than 8 (APP_CLIENT_WARNING_THRESHOLD) ...`. Usually, several
  projects on the same server use the same app name.
- **One client sends too much.** Above `CLIENT_MESSAGE_RATE_LIMIT` (1000 per second), the log warns with the
  client's name. Normal clients stay far below it: 10 objects synchronized 72 times a second are 720 updates a second.
  Usually, code sends in every frame without a limit. Send less often from that client.
- **The server as a whole is overloaded.** When it falls `TCP_INBOUND_BACKLOG_LIMIT` (2000) messages behind the Unity
  clients, the log warns naming that variable. Synchronize fewer objects, less often, or with fewer clients per app.

Over a limit, the server protects itself:

| What                   | What happens                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------- |
| Object updates         | Held back and merged per object. The latest value of every field still arrives, only later. Objects move less smoothly for the other clients. |
| Messages               | Dropped                                                                                                       |
| Everything else        | Passes as usual: connecting, requests, deletes, log lines                                                     |

Updates are held for at most 1000 objects per client. An update for one more object is lost, and the object reaches
the others only when it changes again. The log says when this happens. The monitoring page's _Clients_ page shows
which client is held back.

Short overloads, for example a brief pause of the server, are logged only at debug level.

## Idle timeout

The server sends each Unity client a heartbeat ten times a second, and the client answers. A Unity client that sends
nothing for `TCP_IDLE_TIMEOUT_SECONDS` (10 seconds) is disconnected, with a warning naming it. This detects a headset
that left the Wi-Fi or went to sleep without closing its connection. The other clients of its app see it leave.

- Very large messages give a client more time: up to 60 extra seconds at the default.
- A long scene load in Unity does not trigger the timeout.
- **A debugger stopped at a breakpoint does.** For long debugging sessions against your own server, raise
  `TCP_IDLE_TIMEOUT_SECONDS` or set it to `0`.
- Web clients are not affected. A lost web client is detected within about 45 seconds.

## Deleted objects

When a client deletes a synchronized object, the server remembers this for `MODEL_TOMBSTONE_SECONDS` (10 minutes).
Meanwhile, it ignores updates for the object, so that a late update from another client cannot bring it back. A client
that reconnects within this time learns that the object was deleted and removes its copy. A client that has the object
in its scene again, for example after loading the scene again, may create it again.

The server forgets all objects of an app, deleted or not, when the app's last client leaves.

## Data store

The server keeps the values of the [data store](./protocol.md#data-store) in `store.db` in the data directory, an
SQLite database. A value that is not written again for `STORE_EXPIRY_DAYS` (30 days) is deleted. Reading it does not
count. Set `STORE_EXPIRY_DAYS=0` to keep values for good, for example study data that stays on the server for months.

`STORE_MAX_MB` limits how much all values may take together. A `PUT` that would go above it gets `507` and stores
nothing. Without a limit, the data store grows until the disk is full: anyone who can reach the server can store values.

### Backup

`store-export.js` prints the data store as JSON, also while the server runs:

```sh
docker exec colibri node dist/server/store-export.js > store.json
```

**Node.js:** run `node dist/server/store-export.js > store.json` in the `colibri-server` folder.

To restore it, put this `store.json` into a data directory without `store.db`. The server imports it on the next start
and renames it to `store.json.imported-<date>`. A `store.json` next to a `store.db` is not imported, and the log says
so.

## Voice chat

The server relays voice chat between the Unity clients of an app over UDP. Web clients do not support voice chat
([Unity voice chat](../unity/voice-chat.md)).

For voice to work:

- **Port 9213/udp must be open and published.** With Docker, note the `/udp` in `ports:`.
- **The voice must come from the same address as the Unity client's connection.** The server relays voice only if a
  Unity client of the same app is connected from the address the voice comes from. Otherwise the log shows
  `Ignoring voice packet from <address>:<port> for app <app id>: no Unity client of that app is connected from <address> ...`.
  This happens when the voice and the connection take different routes, for example through a proxy, through
  different NAT, or IPv4 and IPv6 ([IPv6](#ipv6)).
- **A client hears others only while it sends voice itself.** The server learns a client's address from its voice,
  and forgets it after 2 to 3 seconds without voice.

Voice through a UDP proxy always comes from the proxy's address. Add the proxy to `TRUSTED_PROXIES`, and the server
relays its voice without the check. Better, publish the voice port directly.

The check only keeps the voice of different apps apart and stops strangers from redirecting it. It is not access
control: anyone who can reach the server can join an app and hear its voice chat. Voice is never encrypted, also with
TLS on.

### Voice recording

With `VOICE_RECORDING=true`, the server saves the voice of each client as a `.wav` file in the data directory, e.g.
`rec_2026-10-09T11_07_58.502Z_app_0xe40c292c_ID_1_port_52114.wav`. The name holds the start time (UTC), the app id,
the client's voice id and its port. The files are written when a client stops sending voice, and when the server
stops.

- Only uncompressed voice is recorded, the default of Colibri's Unity voice chat. Voice compressed with Opus is not,
  and the log warns about it.
- Set `VOICE_SAMPLING_RATE` to the sampling rate of the Unity clients, or the recordings play at the wrong speed.
- Tell the participants of your study that their voice is recorded.
