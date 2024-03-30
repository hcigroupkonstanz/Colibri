# Colibri - Server

Communication Library for rapid prototyping in Unity

## Setup

### [Docker](https://hub.docker.com/r/hcikn/colibri) _(recommended)_

Use the following `docker-compose.yml` and run `docker-compose up -d`:

```yaml
version: '3.4'
services:
  colibri:
    image: hcikn/colibri
    restart: unless-stopped
    container_name: colibri
    tty: true
    volumes:
        - ./data/:/srv/colibri/data
    ports:
      - 9011:9011 # web interface / web sockets
      - 9012:9012 # tcp (unity)
      - "9013:9013/udp" # voice
```

### Node

Requirements: NodeJS 20+

Clone this repository, build with `npm run build`, then start with `npm start`.

#### Configuration

The web interface, socketIO server, and voice server and customizable.
The main aspect here lies in changing default ports or hostnames to facilitate running the application behind a proxy.

> **Note:** The Unity and Web version are still using the hard-coded Port numbers. Currently there is no way to change the default ports via a configuration file!

For reference, see the `.env.example` file:

```basic
TCP_HOST='0.0.0.0'
TCP_PORT=9012

VOICE_HOST='0.0.0.0'
VOICE_PORT=9013

WEBSERVER_HOST='0.0.0.0'
WEBSERVER_PORT=9011
WEBSERVER_ROOT='../ui/'
BASE_URL=''

DATA_ROOT='../../data'
```

## Features

A web interface is available on `http://<your-server-ip>:9011` to view the log output of connected clients.

## Development

* `npm run watch`: Run development server with auto-compile and reload on file changes
* `npm run build`: Compilation
* `npm start`: Start server -- make sure to compile first.
