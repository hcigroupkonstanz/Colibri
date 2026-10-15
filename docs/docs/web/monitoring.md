---
sidebar_position: 8
title: Monitoring
---

# Monitoring

While you develop and run a study, you want to see which clients are connected and what they log. The server's
monitoring page shows this for all clients, web and Unity, in one place. With `RemoteLogger`, it also shows the
console log of your web app, which is the easiest way to read the log of a web app on a smartphone or head-mounted
display.

## The monitoring page

The server's monitoring page at `http://<server-address>:9211` (with TLS: `https://`) shows the connected clients
with their latency and throughput, the synchronized objects with their current values, and the log of the server
and of every client. See [Monitoring](../server/monitoring.md) in the server documentation.

![The log on the monitoring page](/img/web/monitoring-log.png)

## Sending the console log to the server

To also see a client's console log on the monitoring page, create a `RemoteLogger` when your app starts:

```ts
import { RemoteLogger } from '@hcikn/colibri';

new RemoteLogger();
```

From then on, everything logged with `console` also appears on the monitoring page. The log still appears in the
browser's console as before.

Runnable sample:
[remote-logging](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/remote-logging.ts)
(`npm run samples/remote-logging`, see [Samples](./installation.md#samples)).

### Creating it once

- Create one `RemoteLogger`, at startup. It may come before or after `new Colibri()`.
- Lines logged before `new Colibri()` are kept and sent once the client exists, up to the first 100 lines. Colibri
  counts the lines beyond that and reports their number in one warning.
- A second `new RemoteLogger()` does not forward the log a second time. It warns once
  (`RemoteLogger: the console is already forwarded by an earlier new RemoteLogger() ...`) and from then on controls
  the first one. This also happens if a framework such as React creates your component twice.

### Turning it on and off

```ts
import { RemoteLogger } from '@hcikn/colibri';

const logger = new RemoteLogger();

logger.disable(); // stop forwarding
logger.enable(); // forward again
```

`new RemoteLogger(false)` creates it switched off. Turn it on later with `enable()`, e.g. only during a study
session.

### What is forwarded

| Logged with                  | Level on the monitoring page |
| ---------------------------- | ---------------------------- |
| `console.error`              | Error                        |
| `console.warn`               | Warn                         |
| `console.log`, `console.info` | Info                        |
| `console.debug`              | Debug                        |

- Each line is labeled with the client's app name, so you can filter the log by app.
- Objects are shown as JSON. Errors are shown with their message and stack trace.
- Forwarded lines also appear in the server's console output (`docker logs` with Docker). `console.debug` lines
  appear there only if the server runs with `CONSOLE_LOG_LEVEL=debug` (see the
  [server configuration](../server/configuration.md)).
- Other `console` functions, such as `console.table`, are not forwarded.
- Forwarding never makes a `console` call throw. If a line cannot be forwarded, it is still logged locally.
