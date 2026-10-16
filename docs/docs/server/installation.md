---
sidebar_position: 1
title: Installation
---

# Installation

The Colibri server passes messages and synchronized objects between the Unity and web clients of each app. It also
provides the data store and voice chat, and shows a monitoring page in the browser. This page explains how to run
your own server.

:::warning No authentication
Colibri has no authentication. Anyone who can reach the server can join any app on it, read and change its data, and
read the log on the monitoring page. Run your own server on a trusted network, for example your lab's network or a
VPN.
:::

## Requirements

- Docker, or Node.js 24.15 or newer
- Open ports 9211/tcp, 9212/tcp and 9213/udp (see below)
- Colibri 2 clients. The server refuses Colibri 1 clients. To upgrade an existing project, see the
  [Migration Guide](https://github.com/hcigroupkonstanz/Colibri/blob/develop/MIGRATION.md).

| Port     | Protocol | Used by                                         |
| -------- | -------- | ----------------------------------------------- |
| **9211** | TCP      | Monitoring page, web clients and the data store |
| **9212** | TCP      | Unity clients                                   |
| **9213** | UDP      | Voice chat                                      |

If a firewall runs on the server, allow these ports there too. To use other ports, see
[Changing ports](./configuration.md#changing-ports).

## Public test server

You do not need your own server to try Colibri. The University of Konstanz runs a public test server at
`colibri.hci.uni-konstanz.de`. Enter it as the server address in your [Unity](../unity/configuration.md) or
[web](../web/configuration.md) client.

:::note
Everyone shares the public test server, and everyone can see and change the data of every app on it. Use it for
quick tests, never for study data. Give your app a name that nobody else is likely to use. For your study or
prototype, run your own server.
:::

## Docker (recommended)

The server is available as the Docker image [`hcikn/colibri`](https://hub.docker.com/r/hcikn/colibri). Save this as
`docker-compose.yml`:

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

Start the server in the same folder:

```sh
docker compose up -d
```

Then open `http://<server-address>:9211` in a browser. The [monitoring page](./monitoring.md) shows the server's log
and the connected clients. `docker logs colibri` shows the log in the console. `docker ps` shows the container as
`healthy` once the server answers.

:::tip
Do not add `tty: true` to the compose file. With it, `docker logs` mixes warnings and errors into the normal output.
The `logging:` section keeps the log at 50 MB at most. Without it, Docker's log grows without limit, and every log
line of every client ends up there.
:::

### Data volume or host folder

The server saves its data in `/srv/colibri/data` inside the container:

- `store.db`: the values of the [data store](./protocol.md#data-store)
- `.wav` files of [voice recordings](./configuration.md#voice-recording), if you turned them on

The compose file above keeps this data in the Docker volume `colibri-data`. It needs no setup and survives updates of
the container. To keep the data in a folder next to the compose file instead, for example to back it up easily,
replace the volume line:

```yaml
        volumes:
            - ./data:/srv/colibri/data
```

You can then remove the `volumes:` section at the end of the file. Docker creates the `data` folder on the first
start if it does not exist. A `data` folder from a Colibri 1 server works too: on the first start, the server imports
its `store.json` into `store.db` and renames it to `store.json.imported-<date>`.

:::note
Leave `DATA_ROOT` unset with Docker, and mount the data at `/srv/colibri/data`.
:::

### Owner of the data directory

The server runs as the user `node`, with the user id (uid) 1000. When the container starts, it gives
`/srv/colibri/data` to this user if anything in it belongs to someone else. On the host, a `./data` folder then
belongs to uid 1000. This also fixes a `data` folder from Colibri 1, which belonged to root.

#### Running as another user

With `--user`, or `user:` in the compose file, the container cannot change the owner. The data directory must then
already belong to that user. For example, for `--user 1001:1001`:

```sh
sudo chown -R 1001:1001 ./data
```

A new Docker volume belongs to uid 1000, so it works only with `--user 1000:1000`. For another user, use a host
folder that belongs to that user, or remove `--user`.

### If the server cannot write its data

If the server cannot write to its data directory, it prints `DATA_ROOT is not writable: <path>` at startup, with the
error, its user id and a fix. The monitoring page's log shows the error too. The server keeps running but saves
nothing: data store values and voice recordings stay in memory and are lost when it stops. Values that are already in
`store.db` are still served, as long as the file can be read. Fix the cause and restart the server.

| Error               | Cause                                         | Fix                                                                                   |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| `EACCES`, `EPERM`   | The server's user may not write there         | `chown -R <uid>:<gid> <path>`, with Docker on the host folder                         |
| `EROFS`             | The folder is mounted read-only               | Remove `:ro` from the mount, or set `DATA_ROOT` to a writable directory               |
| `ENOTDIR`, `EEXIST` | The path, or a folder above it, is a file     | Move the file away, or set `DATA_ROOT` to a directory                                 |
| `ENOSPC`, `EDQUOT`  | The disk or your quota is full                | Free disk space                                                                       |
| Other               | The path is not a writable directory          | Make it a directory the server's user can write to, or set `DATA_ROOT` to one         |

### Building the image yourself

To run a changed server, build the image from a checkout of the repository. In `colibri-server`, run:

```sh
COLIBRI_COMMIT=$(git rev-parse HEAD) docker compose up -d --build
```

The `docker-compose.yml` in `colibri-server` builds the image from the source and keeps the data in `./data`.
`COLIBRI_COMMIT` is optional. With it, the monitoring page's _Server_ page shows the commit the server was built
from. Add `COLIBRI_COMMIT_DIRTY=true` if the checkout has changes you have not committed.

In your own compose file, replace the `image:` line with a `build:` section:

```yaml
        build:
            context: <path to the checkout>/colibri-server
            args:
                COLIBRI_COMMIT: ${COLIBRI_COMMIT:-}
                COLIBRI_COMMIT_DIRTY: ${COLIBRI_COMMIT_DIRTY:-}
```

## Node.js

Without Docker, the server needs Node.js 24.15 or newer:

```sh
git clone https://github.com/hcigroupkonstanz/Colibri.git
cd Colibri/colibri-server
npm ci
npm run build
npm start
```

The server runs until you press Ctrl+C. It saves its data in `colibri-server/data`. To change a setting, create a
`.env` file in `colibri-server` ([Configuration](./configuration.md)).

## Updating

### Docker

The compose file names an exact version of the image, for example `hcikn/colibri:2.0.0`. To update, change the
version in the compose file and run:

```sh
docker compose pull
docker compose up -d
```

:::warning Pin the version
Always name a version in `image:`. Without one, or with `latest`, the next pull can switch your server to another
major version without notice, for example from Colibri 1 to Colibri 2. Clients of the old version then cannot connect
any more.
:::

### Node.js

Stop the server, then update and build it again:

```sh
git pull
npm ci
npm run build
npm start
```

To stay on one version, check out its release tag instead of pulling (`git tag` lists them).

### What survives a restart

| Kept                                        | Lost                                                                         |
| ------------------------------------------- | ---------------------------------------------------------------------------- |
| Data store values (`store.db`)              | Synchronized objects. Connected clients send theirs again when they reconnect. |
| Voice recordings                            | The log on the monitoring page. `docker logs colibri` still has it.            |

On `docker stop` or Ctrl+C, the server finishes voice recordings in progress. Data store changes are already saved:
the server saves each change before it answers. Clients reconnect on their own when the server is back.

## Next steps

- Point your clients to the server: [Unity](../unity/configuration.md), [web](../web/configuration.md).
- Change ports, turn on TLS or run the server behind a reverse proxy: [Configuration](./configuration.md).
- Watch the clients and the log: [Monitoring](./monitoring.md).
