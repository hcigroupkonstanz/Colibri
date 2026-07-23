# Colibri - Web Client

See [CHANGELOG.md](CHANGELOG.md) for release notes, including breaking changes when upgrading from 1.x.

## Installation

- NPM: `npm install @hcikn/colibri`
- Yarn: `yarn add @hcikn/colibri`

## Configuration

Initialize Colibri once with:

```ts
import { Colibri } from '@hcikn/colibri';
new Colibri('app_name', 'server_address');

// if using a custom port:
new Colibri('app_name', 'server_address', 9011);
```

For server setup, refer to [colibri-server](../colibri-server/).

## Usage

### Web Interface for Logging

Colibri provides a _web logger_ with web interface to send diagnostic data (currently: console logs) to the server. This may be useful for devices (e.g., VR devices, smartphones) where access to the console is not easily available.

To setup, import the `RemoteLogger` and construct a new instance. Any subsequent `console` calls should now also appear on your colibri server's web interface, which can be accessed via `http://<your-server-ip>:9011`.

```ts
import { RemoteLogger } from '@hcikn/colibri';
const logger = new RemoteLogger();

// en-/disable RemoteLogger
logger.enable();
logger.disable();
```

See also [the remote-logging sample](samples/remote-logging.ts) (run sample with `npm run samples/remote-logging`).

### Sending Data between Clients

Colibri supports simple data transmission via pub/sub communication. Data can be published from anywhere in  
the executed code, as illustrated with the following simple example of sending a boolean value on a "click" channel:

```ts
import { Sync } from '@hcikn/colibri';
Sync.sendBool('myChannel', true);
```

The sent data can then be received anywhere by registering a listener:

```ts
Sync.receiveBool('myChannel', (value) => {
    // Will be called whenever a bool on "click" channel is received
});
```

The listener can be deregistered via:

```ts
Sync.unregister('myChannel', MyMethod);
```

The following built-in types are available for sync: `bool, int (as number), float (as number), string, Vector2, Vector3, Quaternion, Color` and arrays thereof. For arbitrary data, you can use JSON:

```ts
Sync.sendJson('myChannel', { foo: 'bar' });
Sync.receiveJson('myChannel', (json) => {
    /* ... */
});
```

See also [the broadcast sample](samples/broadcast.ts) (run sample with `npm run samples/broadcast`).

Limitations:

- You have to register the listener _before_ sending out data
- Type and channel _must_ match between Listener and Sender (`number` will be converted to float for Unity clients, i.e., use `float` listener on Unity clients for sending numbers!)
- Remember to unregister your listener where necessary!

### SyncModel

(Counterpart to [SyncBehaviour in Unity client](../colibri-unity#SyncBehaviour))

For more complex scenarios, Colibri supports synchronization of data models (e.g., for use in model-view-controller architectures). For this, we need extend the _Model_ with `SyncModel`:

```ts
import { SyncModel, Synced } from '@hcikn/colibri';

export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    accessor name = '';

    @Synced()
    accessor age = 0;

    @Synced('billingAddress')
    accessor address = '';
}
```

`@Synced()` requires TypeScript's standard decorators, the default since TypeScript 5.0 — make sure `experimentalDecorators` is **not** set (or is `false`) in your `tsconfig.json`, and declare every synced member with the `accessor` keyword.

Any `accessor` member marked with `@Synced()` will be synchronized across all network clients.

> **Migrating from 1.x:** `@Synced()` now requires standard TC39 decorators instead of legacy
> (`experimentalDecorators`) ones. To migrate: remove `experimentalDecorators` from your
> `tsconfig.json`, and turn every synced field/property into an `accessor` (e.g.
> `@Synced() private age = 0;` → `@Synced() accessor age = 0;`). This also fixes field
> synchronization in frameworks like React, which never worked correctly under the legacy decorator.

Lastly, we need to register the class with the Synchronization mechanism by calling `RegisterModelSync`:

```ts
import { RegisterModelSync } from '@hcikn/colibri';
const [SampleClasses$, registerExampleClass] = RegisterModelSync<SampleClass>({ type: SampleClass });
```

The first return value (e.g., `SampleClasses$`) is a [BehaviorSubject](https://www.learnrxjs.io/learn-rxjs/subjects/behaviorsubject) that will be updated whenever a new instance of SampleClass is added, updated, or deleted. The second return value (e.g., `registerExampleClass`) can be used to sync new instantiations:

```ts
const mySample = new SampleClass('myId'); // mySample is not synchronized across clients yet
registerExampleClass(mySample); // mySample is sent out to all other clients and will be synchronized
```

See also [the model-sync sample](samples/model-sync.ts) (run sample with `npm run samples/model-sync`).

### Remote Store

Colibri offers persistent data storage on the server, so that data can be shared easily between connected clients. Each object is identified by it's individual `key`:

```ts
import { Colibri, GetRestApi, PutRestApi } from '@hcikn/colibri';

const colibri = Colibri.getInstance();
const key = 'sampleKey';
const data = {...};

// fetch data
colibri.getRestObject(key); // or...
GetRestApi(key);

// update data
colibri.setRestObject(key, data); // or...
PutRestApi(key, data);
```

Each operation can be achieved by either directly interaction with the `Colibri` object or using the corresponding wrapper method.

## Samples

See [Sample folder](samples/) for more examples on how to use the Colibri web client.
