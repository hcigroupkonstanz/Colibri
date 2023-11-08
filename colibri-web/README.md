# Colibri - Web Client

## Installation

- NPM: `npm install @hcikn/colibri`
- Yarn: `yarn add @hcikn/colibri`

## Configuration

Initialize Colibri once with:
```ts
import { Colibri } from '@hcikn/colibri';
Colibri.initialize('app_name', 'server_address');
```

For server setup, refer to [colibri-server](../colibri-server/).

## Usage

### Web Interface for Logging

Colibri provides a _web logger_ with web interface to send diagnostic data (currently: console logs) to the server. This may be useful for devices (e.g., VR devices, smartphones) where access to the console is not easily available.

To setup, import the `RemoteLogger` and call its `init()` method. Any subsequent `console` calls should now also appear on your colibri server's web interface, which can be accessed via `http://<your-server-ip>:9011`.

```ts
import { RemoteLogger } from '@hcikn/colibri';
RemoteLogger.init();
```

See also [the remote-logging sample.](samples/remote-logging/sample.ts)

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

```c#
Sync.sendJson('myChannel', { foo: 'bar' });
Sync.receiveJson('myChannel', (json) => { /* ... */ });
```

See also [the broadcast sample](samples/broadcast/sample.ts).

Limitations:
- You have to register the listener *before* sending out data
- Type and channel *must* match between Listener and Sender (`number` will be converted to float for Unity clients, i.e., use `float` listener on Unity clients for sending numbers!)
- Remember to unregister your listener where necessary!

### SyncModel
(Counterpart to [SyncBehaviour in Unity client](../colibri-unity#SyncBehaviour))

For more complex scenarios, Colibri supports synchronization of data models (e.g., for use in model-view-controller architectures). For this, we need extend the *Model* with `SyncModel`:

```ts
import { SyncModel, Synced } from '@hcikn/colibri';

export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    get name() { return this._name; }
    set name(val: string) { this._name = val; }
    private _name = '';

    @Synced()
    private age = 0;

    @Synced('billingAddress')
    private address = '';
}
```

and enable `experimentalDecorators` in the `tsconfig.json`:
```json
{
  "compilerOptions": {
    "experimentalDecorators": true
  }
}

```

Any property or field marked with `@Synced()` will be synchronized across all network clients. *Note: Synchronization of fields (e.g., `@Synced() private age = 0;` does not work on some frameworks such as React for some reason.*

Lastly, we need to register the class with the Synchronization mechanism by calling `RegisterModelSync`:
```ts
import { RegisterModelSync } from '@hcikn/colibri';
const [ SampleClasses$, registerExampleClass ] = RegisterModelSync<SampleClass>({ type: SampleClass });
```
The first return value (e.g., `SampleClasses$`) is a [BehaviorSubject](https://www.learnrxjs.io/learn-rxjs/subjects/behaviorsubject) that will be updated whenever a new instance of SampleClass is added, updated, or deleted. The second return value (e.g., `registerExampleClass`) can be used to sync new instantiations:

```ts
const mySample = new SampleClass('myId'); // mySample is not synchronized across clients yet
registerExampleClass(mySample); // mySample is sent out to all other clients and will be synchronized
```

See also [the model-sync sample](samples/model-sync/sample.ts).

## Samples
See [Sample folder](samples/) for more examples on how to use the Colibri web client.
