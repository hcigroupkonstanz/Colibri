---
sidebar_position: 2
title: Configuration
---

# Configuration

Before your app can exchange data, it creates one Colibri client. The client connects to the server, keeps the
connection open and reconnects when it drops. This page explains its arguments and what happens on the connection.

## Creating the client

Create the Colibri client once, when your app starts:

```ts
import { Colibri } from '@hcikn/colibri';

new Colibri('myAppName', 'colibri.hci.uni-konstanz.de');
```

- The first argument is the **app name**. Set it to a unique name that is not used on the server. Clients exchange
  data only if their app names match, web and Unity alike. Do not use `colibri`, which the server's monitoring page
  uses.
- The second argument is the **server address**: a host name or IP address, optionally with `http://` or
  `https://`. A public test server is available: `colibri.hci.uni-konstanz.de`. In a browser, you can leave it out
  to use the host that served the page.
- A second `new Colibri()` throws. Elsewhere in your app, use `Colibri.getInstance()`.

`new Colibri(app, server, port)` takes these arguments:

| Argument | Default                                  | Description                                                                                                                         |
| -------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `app`    | required                                 | App name. Messages, synchronized objects and the data store are shared only between clients with the same app name.                 |
| `server` | Host of the page. Required in Node.js.   | Host name or IP address, optionally with `http://`, `https://`, `ws://` or `wss://`, `:port` and a trailing `/`. No path, query or fragment. |
| `port`   | `9211`                                   | The server's web port, a whole number from 1 to 65535. Used when `server` has no port. If both have one, they must match.            |

All of these connect to the same server:

```ts
// the address of the monitoring page, without a page path such as '/log'
new Colibri('myAppName', 'http://<server-address>:9211');

// the host, with an optional port
new Colibri('myAppName', '<server-address>');
new Colibri('myAppName', '<server-address>', 9211);
```

## App name

- All clients of your app, web and Unity, must use the same app name.
- Anyone else who uses the name joins your app and sees its messages and synchronized objects. The examples and
  samples use `myAppName`. For your own project, choose a unique name.
- `colibri` is reserved for the server's monitoring page. The server treats a client with this name as a monitoring
  page: it sends it the server's log and skips the protocol version check. Colibri warns if you use it.

## Server address and port

- With `https://` or `wss://`, the connection and the data store requests are encrypted. The server needs
  [TLS](#tls) for this.
- IPv6 addresses go in brackets: `http://[::1]:9211`.
- The port comes from the address first, then from the third argument, then the default 9211. If the address and
  the third argument both name a port, they must be the same, or `new Colibri()` throws. `colibri.port` returns the
  port in use.
- The scheme never sets the port. `https://<server-address>` means port 9211, not 443.
- In a browser without a `server` argument, Colibri uses the host name of the page, but still port 9211, not the
  port of the page.
- Colibri 1 used port 9011 by default. A server that still uses 9011 needs the port in the address or as the third
  argument.
- If you read the port from the page's URL, convert it to a number first. (Plain JavaScript may also pass a string of
  digits such as `'9211'`, as in Colibri 1.)

  ```ts
  const params = new URLSearchParams(window.location.search);
  new Colibri('myAppName', params.get('server') ?? undefined, Number(params.get('port') ?? 9211));
  ```

`new Colibri()` throws a `ColibriError` for an address it cannot connect to:

- an address with a path, such as the monitoring page's `/log`, a query (`?...`) or a fragment (`#...`)
- a scheme other than `http://`, `https://`, `ws://` and `wss://`
- an empty address, for example in Node.js without the `server` argument
- a port that is not a whole number from 1 to 65535
- two different ports in the address and the third argument
- a second instance

The error message says what is wrong.

## One instance

Your app has exactly one Colibri client. Create it once, at startup, and get it elsewhere with
`Colibri.getInstance()`:

```ts
import { Colibri } from '@hcikn/colibri';

const colibri = Colibri.getInstance();
if (colibri) {
    console.log(`Connected to port ${colibri.port}`);
}
```

`Colibri.getInstance()` returns `null` before `new Colibri()`, with the console warning
`Colibri not initialized yet! (Instance is null)`. `Colibri.getInstance(false)` skips the warning.

:::tip
In a framework such as React, create the client outside your components, e.g. in `main.ts`. A component can run more
than once, and a second `new Colibri()` throws.
:::

You may register message listeners, call `RegisterModelSync` and create a `RemoteLogger` before `new Colibri()`.
They start working once the client exists. Sending a message or using the data store needs the client first.

## Connection and reconnection

Colibri connects in the background. You do not have to wait for the connection: what you send while it is not up
yet is sent as soon as it is.

- If the server does not answer, Colibri keeps trying until it does. It warns once per outage:
  `Colibri: could not connect to <address> (<reason>). Retrying until it answers ...`. Check the server address and
  that the server is running.
- When the connection drops, Colibri reconnects by itself. Messages sent by other clients during the outage are
  lost. Synchronized objects catch up with what changed ([details](./syncmodel.md#reconnects)).
- A browser tab in the background may reconnect late after an outage, in one test with Chrome after 90 seconds.
  Browsers slow down timers in hidden tabs. Showing the tab again makes it reconnect within seconds.

## TLS

If the server uses TLS (see the [server configuration](../server/configuration.md)), it accepts only encrypted
connections on its web port.

- Connect with `https://<server-address>:9211` or `wss://<server-address>:9211`. Both encrypt the connection and the
  data store requests.
- The monitoring page is then at `https://<server-address>:9211`.
- `http://<server-address>:9211` gets no answer. The server closes the connection and does not redirect it.

A page served over `https://` can only connect with `https://` or `wss://`. Browsers block `http://` and `ws://`
connections from such a page (mixed content). So for a page on `https://`, the server needs TLS or a reverse proxy
that adds TLS.

| Certificate                                         | What to do on the client                                                                     |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Self-signed, in a browser                           | Open `https://<server-address>:9211` once and accept the certificate, or install it.         |
| Self-signed, in Node.js (scripts, tests)            | Start Node.js with the environment variable `NODE_EXTRA_CA_CERTS=<cert.pem>`.                |
| From a certificate authority, such as Let's Encrypt | Nothing.                                                                                     |
| Reverse proxy that adds TLS                         | Use the proxy's port, such as `wss://<server-address>:443`.                                  |

## Protocol version

Colibri 1 and Colibri 2 cannot talk to each other. Colibri checks this when it connects and tells you through
`colibri.protocolMismatch`:

```ts
import { Colibri } from '@hcikn/colibri';

const colibri = new Colibri('myAppName', 'http://<server-address>:9211');
colibri.protocolMismatch.subscribe(error => {
    if (error.fatal) {
        // disconnected, no reconnect: install matching colibri-web and colibri-server versions
        console.error(`Server protocol v${error.serverVersion}, client protocol v${error.clientVersion}`);
    } else {
        // server older than 2.0.0, the connection still works
    }
});
```

| `fatal` | Cause                                                                                    | Effect                                                    |
| ------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `true`  | The server speaks another protocol version and refused this client.                      | The connection is closed. Colibri does not reconnect.     |
| `false` | The server did not identify itself within 5 seconds, so it is probably a Colibri 1 server. | The connection stays up and works. Upgrade the server. |

- Each kind is reported at most once and also logged to the console, so you see it even without subscribing.
- Subscribe right after `new Colibri()`. A later subscriber does not get an error that was already reported.
- `serverVersion` and `clientVersion` are protocol versions such as `'1'` and `'2'`, not release versions such as
  `2.0.0`. `PROTOCOL_VERSION`, exported by the package, is this client's protocol version.
- A suspected old server (`fatal: false`) can later turn into a refusal (`fatal: true`), for example when the server
  is replaced by a newer one. Not the other way round.
