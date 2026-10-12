# Colibri Server

Server for [Colibri](../README.md). Relays messages and synchronized-object updates between the Unity and web
clients of each app and keeps the current object state. Provides a REST key-value store, a UDP voice relay and an
admin UI with the log, the connected clients, the synchronized models and the server settings.

Full documentation: [docs/guide.md](docs/guide.md). Changes since 1.x: [docs/v2-changelog.md](docs/v2-changelog.md).

## Requirements

- Docker, or Node.js 24 or newer
- Open ports 9211/tcp (admin UI, web clients, REST store), 9212/tcp (Unity clients) and 9213/udp (voice). 1.x used
  9011 to 9013 ([default ports](../MIGRATION.md#default-ports)).
- colibri-unity or colibri-web 2.x clients. The server refuses 1.x clients ([upgrading](../MIGRATION.md)).

## Installation

### Docker

Save as `docker-compose.yml` and run `docker compose up -d`.

```yaml
services:
  colibri:
    image: hcikn/colibri:2.0.0
    restart: unless-stopped
    container_name: colibri
    # Cap the log size. Do not set `tty: true`, which mixes stderr into stdout.
    logging:
      driver: json-file
      options:
        max-size: "10m"
        max-file: "5"
    volumes:
      - colibri-data:/srv/colibri/data
    ports:
      - 9211:9211 # admin UI, web clients, REST store
      - 9212:9212 # TCP, Unity clients
      - "9213:9213/udp" # voice

volumes:
  colibri-data:
```

The admin UI is at `http://<server-ip>:9211`. `docker logs colibri` shows the log.

- `/srv/colibri/data` holds `store.json` and voice recordings. To use a host directory instead of the volume,
  mount it there, e.g. `./data:/srv/colibri/data`. Leave `DATA_ROOT` unset.
- At startup the entrypoint chowns `/srv/colibri/data` to uid 1000 (`node`), including a 1.x data directory.
  With `--user`, see [Running as another user](docs/guide.md#running-as-another-user).
- To change a port, change only the host side of `ports:`, e.g. `"9011:9211"` to keep 1.x's web port.

### Node.js

```sh
git clone https://github.com/hcigroupkonstanz/Colibri.git
cd Colibri/colibri-server
npm ci && npm run build && npm start
```

Ports and admin UI are the same as with Docker. Data is stored in `colibri-server/data`.

## Configuration

Set environment variables or a `.env` file in the working directory, `colibri-server` for `npm start`. In Docker,
use an `environment:` section or mount the file at `/srv/colibri/.env`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `WEBSERVER_PORT`, `TCP_PORT`, `VOICE_PORT` | `9211`, `9212`, `9213` | Admin UI and web clients, Unity clients, UDP voice. 1.x: `9011`, `9012`, `9013`. |
| `TLS_CERT`, `TLS_KEY` | unset | PEM certificate and key. Enable [TLS](docs/guide.md#tls) on the web and TCP ports. All clients must then use TLS. Voice stays unencrypted. |
| `CONSOLE_LOG_LEVEL` | `info` | `error`, `warn`, `info` or `debug` |
| `TCP_IDLE_TIMEOUT_SECONDS` | `10` | Seconds of silence before a Unity client is disconnected. `0` disables it. |

All variables: [`.env.example`](.env.example), [reference](docs/guide.md#configuration).

## Security

Colibri has no authentication. Anyone who can reach the ports can join any app, read and change its
data, and read the log, the connected clients and the server settings. Run the server on a trusted network.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Startup error on stderr about the data directory | The server cannot write there. It keeps running but saves nothing. | Apply the fix named in the message ([details](docs/guide.md#unwritable-data-directory)) |
| Unity clients upgraded from 1.x never appear in the admin UI or the log | Their projects keep 1.x's ports 9011 to 9013 in `ColibriConfig` | *Use 2.0 defaults* in the Unity Setup window, or keep 1.x's ports on the server ([default ports](../MIGRATION.md#default-ports)) |
| A client is missing from the admin UI, and the log shows `Refusing ...` | A 1.x client, or the Unity app's *Server supports SSL/TLS?* does not match the server | Update the client to 2.x, or fix the TLS setting ([TLS log messages](docs/guide.md#tls-log-messages)) |
| A Unity client disconnects while stopped at a breakpoint | The debugger also pauses heartbeat replies | Raise `TCP_IDLE_TIMEOUT_SECONDS` or set it to `0` |
| `App 'MyApp' now has 9 clients, more than 8 ...` | Separate projects use the same app name | Give each project its own app name |
| Warning naming `TCP_INBOUND_BACKLOG_LIMIT`, synced objects lag, broadcasts missing | The server is overloaded | Sync fewer objects, less often, or with fewer clients per app ([Load limits](docs/guide.md#load-limits)) |
| Warning naming `CLIENT_MESSAGE_RATE_LIMIT` | The named client sends too much, usually every frame | Cap that client's send rate |
| No voice, and the log shows `Ignoring voice packet from <address>:<port> for app <app id>: no Unity client of that app is connected from <address>`, logged once that source's voice has been dropped for 3 s | The voice comes from another address than the Unity client's TCP connection: a proxy, NAT, or TCP fell back to IPv6 because the server name's IPv4 address does not answer. Or the Unity app never connects over TCP. | See [Voice relay](docs/guide.md#voice-relay) |
| Every client is logged at the reverse proxy's address | The server does not trust the proxy | Set `TRUSTED_PROXIES`, and for Unity clients `TCP_PROXY_PROTOCOL` ([Behind a reverse proxy](docs/guide.md#behind-a-reverse-proxy)) |
| Admin UI shows TLS *Off* and no TLS for web clients behind a proxy that serves HTTPS | The server does not trust the proxy, or the proxy sends no `X-Forwarded-Proto` | Set `TRUSTED_PROXIES` and `proxy_set_header X-Forwarded-Proto $scheme;` ([Behind a reverse proxy](docs/guide.md#behind-a-reverse-proxy)) |
| Admin UI Log page empty after a restart | The admin UI keeps only the last 20,000 messages, in memory | Use `docker logs colibri`, filtered by `CONSOLE_LOG_LEVEL` |

## Development

```sh
npm ci && npm run watch   # development server, recompiles and reloads on changes
npm test                  # unit tests
npm run demo              # synthetic clients against a running server, for the admin UI
```

[All scripts](docs/guide.md#development). Wire protocol: [docs/protocol.md](docs/protocol.md).

## License

[MIT](../LICENSE)
