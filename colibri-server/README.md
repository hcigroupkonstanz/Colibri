# Colibri Server

Server for Colibri. It passes messages and synchronized objects between the Unity and web clients of each app,
provides the data store and voice chat, and shows a monitoring page in the browser.

[Full documentation](https://colibri.hci.uni-konstanz.de/server/installation)

Upgrading from Colibri 1.x: [Migration Guide](../MIGRATION.md).

> [!WARNING]
> Colibri has no authentication. Anyone who can reach the server can join any app on it and read and change its
> data. Run your own server on a trusted network.

## Requirements

- Docker, or Node.js 24.15 or newer
- Open ports 9211/tcp (web), 9212/tcp (Unity clients) and 9213/udp (voice chat)
- Colibri 2 clients. The server refuses Colibri 1 clients.

## Installation

### Docker (recommended)

Save this as `docker-compose.yml` and run `docker compose up -d`:

```yaml
services:
    colibri:
        image: hcikn/colibri:2.0.0
        restart: unless-stopped
        container_name: colibri
        # Limits the log size
        logging:
            driver: json-file
            options:
                max-size: "10m"
                max-file: "5"
        volumes:
            - colibri-data:/srv/colibri/data
        ports:
            - 9211:9211 # web: monitoring, web clients, data store
            - 9212:9212 # Unity clients
            - "9213:9213/udp" # voice chat

volumes:
    colibri-data:
```

`docker logs colibri` shows the log. To keep the data in a folder next to the compose file instead of a Docker
volume, replace `colibri-data:/srv/colibri/data` with `./data:/srv/colibri/data`.

### Node.js

```sh
git clone https://github.com/hcigroupkonstanz/Colibri.git
cd Colibri/colibri-server
npm ci
npm run build
npm start
```

The data is saved in `colibri-server/data`.

## Configuration

The server works without any configuration. To change a setting, set an environment variable:

- **Docker:** in an `environment:` section of the compose file, e.g. `CONSOLE_LOG_LEVEL: debug`.
- **Node.js:** in a `.env` file in the `colibri-server` folder. [`.env.example`](.env.example) lists all variables.

To use other ports with Docker, change only the left side of `ports:`, e.g. `"9011:9211"` to keep Colibri 1's web
port.

## Monitoring

The server's web page at `http://<server-address>:9211` shows what happens on the server.

- **Log:** the log of the server and of every client, filtered by app and level. Unity clients send their log with the
  `[RemoteLogger]` prefab, web clients with `RemoteLogger`.
- **Clients:** every connected client with its app, address, latency and messages per second.
- **Models:** the synchronized objects of each app, with their current values.
- **Server:** the version and the settings in effect.

<img src="img/admin-clients.png" alt="Clients page" width="600"/>

## Advanced Configuration

| Variable                                                 | Default                | Description                                                                                                                                                                             |
| -------------------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEBSERVER_PORT`, `TCP_PORT`, `VOICE_PORT`               | `9211`, `9212`, `9213` | Ports for the web, Unity clients and voice chat                                                                                                                                         |
| `TLS_CERT`, `TLS_KEY`                                    | empty                  | Certificate and private key as PEM files. With both set, the web and Unity ports use [TLS](https://colibri.hci.uni-konstanz.de/server/configuration#tls). Voice is not encrypted.       |
| `CONSOLE_LOG_LEVEL`                                      | `info`                 | Least severe level in the log output: `error`, `warn`, `info` or `debug`                                                                                                                |
| `TCP_IDLE_TIMEOUT_SECONDS`                               | `10`                   | Seconds a Unity client may send nothing before it is disconnected. `0` turns it off.                                                                                                    |
| `CLIENT_MESSAGE_RATE_LIMIT`, `CLIENT_MESSAGE_RATE_BURST` | `1000`, `2000`         | Messages per second one client may send. Above it, the server drops or delays its messages. `0` turns it off.                                                                           |
| `APP_CLIENT_WARNING_THRESHOLD`                           | `8`                    | Warn when an app has more clients than this, usually because several projects use the same app name                                                                                     |
| `MODEL_TOMBSTONE_SECONDS`                                | `600`                  | Seconds the server remembers a deleted object, so that it is not created again by an old update                                                                                         |
| `VOICE_RECORDING`                                        | `false`                | `true` saves the voice of each client as a `.wav` file in the data directory                                                                                                            |
| `TRUSTED_PROXIES`                                        | empty                  | Addresses of [reverse proxies](https://colibri.hci.uni-konstanz.de/server/configuration#running-behind-a-reverse-proxy) in front of the server, so the log shows the clients' addresses |
| `BASE_URL`                                               | empty                  | Path of the monitoring page behind a reverse proxy, e.g. `/colibri`                                                                                                                     |

All settings: [guide](https://colibri.hci.uni-konstanz.de/server/configuration#all-variables).

## Troubleshooting

| Symptom                                                                   | Cause                                                                                   | Fix                                                                                                                                         |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| An error about the data directory at startup                              | The server cannot write to it. It keeps running but saves nothing.                      | Apply the fix named in the message ([details](https://colibri.hci.uni-konstanz.de/server/installation#if-the-server-cannot-write-its-data)) |
| Unity clients upgraded from Colibri 1 never appear on the monitoring page | Their configuration still has the old ports 9011 to 9013                                | Set 9211, 9212 and 9213 in Unity's _Window → Colibri Configuration_ ([Migration Guide](../MIGRATION.md#default-ports))                      |
| A client is missing, and the log shows `Refusing ...`                     | A Colibri 1 client, or _Server supports SSL/TLS?_ in Unity does not match the server    | Update the client to Colibri 2, or fix the TLS setting                                                                                      |
| A Unity client disconnects while stopped at a breakpoint                  | The debugger also pauses the client's answers to the server                             | Raise `TCP_IDLE_TIMEOUT_SECONDS` or set it to `0`                                                                                           |
| `App 'myAppName' now has 9 clients, more than 8 ...`                      | Several projects use the same app name                                                  | Give each project its own app name                                                                                                          |
| Warning naming `CLIENT_MESSAGE_RATE_LIMIT`                                | The named client sends too much, usually in every frame                                 | Send less often from that client                                                                                                            |
| No voice, and the log shows `Ignoring voice packet ...`                   | The voice comes from another address than the Unity client, e.g. through a proxy or NAT | See [Voice relay](https://colibri.hci.uni-konstanz.de/server/configuration#voice-chat)                                                      |
| Every client is logged with the reverse proxy's address                   | The server does not trust the proxy                                                     | Set `TRUSTED_PROXIES` ([Behind a reverse proxy](https://colibri.hci.uni-konstanz.de/server/configuration#running-behind-a-reverse-proxy))   |
| The log page is empty after a restart                                     | The page keeps the log in memory only                                                   | Use `docker logs colibri`                                                                                                                   |

## License

[MIT](../LICENSE)
