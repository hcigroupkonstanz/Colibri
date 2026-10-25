---
sidebar_position: 1
title: Installation
---

# Installation

The web client lets a web page or a Node.js script take part in a Colibri app: it sends and receives messages,
synchronizes objects with Unity and other web clients, saves values in the data store and sends its console log to
the server. It is the npm package `@hcikn/colibri`, written in TypeScript.

Voice chat is currently not supported on the web ([details](./voice-chat.md)).

## Requirements

- A current browser, or Node.js 18 or newer.
- TypeScript 5.0 or newer with standard decorators. Leave `experimentalDecorators` unset or `false` in
  `tsconfig.json`. `@Synced()` does not work with it. With Vite, see [Vite](#vite).
- `rxjs` 7.8.1 or a newer 7.x. It is a peer dependency: npm 7 and newer install it automatically. With other
  package managers, add it to your project yourself.
- A [Colibri server](../server/installation.md) 2.0.0 or newer. A Colibri 2 server refuses Colibri 1 web clients,
  and a Colibri 2 web client warns about a Colibri 1 server ([Protocol version](./configuration.md#protocol-version)).

## Install with npm

```sh
npm install @hcikn/colibri@2
```

Or with yarn:

```sh
yarn add @hcikn/colibri@2
```

Keep the `@2`. Without it, npm may install a Colibri 1 release.

## Vite

Vite does not translate standard decorators such as `@Synced()`. A Vite project then fails to build with
`Unexpected token`, or the browser reports `Uncaught SyntaxError: Invalid or unexpected token`. Let esbuild translate
them:

1. Install esbuild:

   ```sh
   npm install --save-dev esbuild
   ```

2. Add this plugin to `vite.config.ts`, or create the file with it:

   ```ts
   import { defineConfig } from 'vite';
   import { transform } from 'esbuild';

   export default defineConfig({
       plugins: [
           {
               name: 'standard-decorators',
               enforce: 'pre',
               async transform(code, id) {
                   const file = id.split('?')[0];
                   if (!/\.[cm]?tsx?$/.test(file)) return null;
                   const result = await transform(code, {
                       loader: file.endsWith('x') ? 'tsx' : 'ts',
                       target: 'es2022',
                       sourcemap: true,
                       sourcefile: file,
                   });
                   return { code: result.code, map: result.map };
               },
           },
       ],
   });
   ```

This works with Vite 7 and 8.

## Building from source

Build the package yourself if npm reports `No matching version found for @hcikn/colibri@2` (yarn:
`Couldn't find any versions`), or if you need a version that is not on npm yet, such as a commit after the latest
release. Building needs Node.js 22 or newer.

```sh
cd colibri-web
npm ci
npm run build
npm pack
```

Without the Git history, for example in a downloaded ZIP of the repository, these commands print
`.git can't be found`. You can ignore it.

`npm pack` writes the file `hcikn-colibri-<version>.tgz`, with the version from `package.json`, such as
`hcikn-colibri-2.1.0.tgz`. To use it:

1. Copy the file into your project.
2. Run `npm install ./hcikn-colibri-2.1.0.tgz` (yarn: `yarn add ./hcikn-colibri-2.1.0.tgz`).
3. Commit the file to your repository. Your `package.json` refers to it by its path.

## Plain JavaScript

Colibri targets TypeScript. The documentation and the samples are TypeScript only. Prefer TypeScript wherever you
can.

Messages, the data store and `RemoteLogger` work from JavaScript as usual. `@Synced()` is a TypeScript decorator, so
plain JavaScript without a build step cannot use it. For `SyncModel` in a project that must stay plain JavaScript,
declare the synced properties with `synced()` in the constructor instead:

```js
import { RegisterModelSync, SyncModel, synced } from '@hcikn/colibri';

class Player extends SyncModel {
    constructor(id) {
        super(id);
        synced(this, { name: '', score: 0 });
    }
}

const [players$, registerPlayer] = RegisterModelSync({ name: 'player', type: Player });
```

- Each key is a synced property with its start value. Properties set outside `synced()` stay on this client.
- `synced(this, { address: '' }, { address: 'billingAddress' })` syncs `address` under another name, as
  `@Synced('billingAddress')` does.

## Samples

The [samples](https://github.com/hcigroupkonstanz/Colibri/tree/develop/colibri-web/samples) are in the
`colibri-web` folder of the repository. They are TypeScript and run in a terminal with Node.js:

```sh
cd colibri-web
npm ci
npm run samples/broadcast
```

Each sample asks for an app name, the server address and the port. Enter an app name of your own, e.g.
`alex-samples`, and press Enter twice for the public test server `colibri.hci.uni-konstanz.de` and port 9211. To see
two clients exchange data, start the same sample in a second terminal with the same app name, or run it next to a
Unity client with that app name.

| Sample                                                                                                                 | Shows                                                                           | Run with                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [broadcast](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/broadcast.ts)                 | [Sending and receiving messages](./messages.md)                                 | `npm run samples/broadcast`                          |
| [model-sync](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/model-sync.ts)               | [Synchronized objects with `SyncModel`](./syncmodel.md)                         | `npm run samples/model-sync`                         |
| [remote-logging](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/remote-logging.ts)       | [Sending the console log to the server](./monitoring.md)                        | `npm run samples/remote-logging`                     |
| [rest-api](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/rest-api.ts)                   | [Saving and loading values in the data store](./data-store.md)                  | `npm run samples/rest-api`                           |
| [sync-transform](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/sync-transform.ts)       | [Showing and moving the objects of Unity's `SyncTransform`](./synctransform.md) | `npm run samples/sync-transform`                     |
| [verification-peer](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/verification-peer.ts) | Receiving and sending one value of every message type                           | `npm run samples/verification-peer -- [host] [port]` |

`verification-peer` does not ask for anything. It takes the server address and port as arguments (default:
`localhost` and 9211), logs every message it receives on `myChannel`, and after 5 seconds sends one value of every
message type. Use it to check that a Unity client and the web client understand each other.

:::note
Everyone who runs the samples on one server with the same app name is in one app and sees the others' data. Without
an app name of your own, the samples use `myAppName`, as other people may do.
:::

## Upgrading from Colibri 1

Colibri 2 does not work with Colibri 1. Upgrade the server and all clients together, as described in the
[Migration Guide](https://github.com/hcigroupkonstanz/Colibri/blob/develop/MIGRATION.md).

## Next steps

Create the Colibri client in your app, as described in [Configuration](./configuration.md).
