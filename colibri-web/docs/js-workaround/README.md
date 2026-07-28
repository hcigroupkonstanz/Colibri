# JavaScript Workaround

Colibri targets TypeScript — see the [web client documentation](../../README.md#syncmodel) for
the regular way to use `SyncModel`. For projects that are tied to plain JavaScript, this folder
documents a workaround.

> **Please note:** a workaround is not a feature. It is not covered by the tests or the
> changelog, it relies on `SyncModel` members that are public only because the `@Synced()`
> decorator needs them, and it may stop working in any future release. Prefer TypeScript
> wherever you have the choice.

## Why a workaround is needed

`@Synced()` is a TypeScript decorator. Plain JavaScript that runs without a build step (Node,
a `<script type="module">` in a browser, …) cannot execute it. `SyncModel` itself is plain
runtime code, though, so the decorator's behaviour can be reproduced by hand.

## What a decorated accessor actually does

`@Synced()` does exactly three things. A hand-written replacement has to do all three, or
synchronization breaks in ways that are hard to debug:

1. **Register the property**, once per instance, via
   `registerSyncedProperty(syncedName, propertyName)`. `syncedName` is the name on the wire and
   **must be lowercase** — `@Synced()` lowercases it for you, so `@Synced('billingAddress')` is
   transmitted as `billingaddress`. If the cases do not match, receiving clients log
   `Unknown property …` and drop the value.
2. **Emit the change** by calling `modelChanges.next(propertyName)` from the setter. Note that
   this is the _local_ property name, not the synced name — `toJson()` resolves it back.
3. **Stay silent while a remote update is applied**: skip the emission when
   `applyingRemoteUpdate` is `true`, otherwise every incoming update is echoed straight back to
   the network.

## The workaround

```js
const defineSynced = (model, prop, initialValue, syncedName = '') => {
    let value = initialValue;

    model.registerSyncedProperty((syncedName || prop).toLowerCase(), prop);

    Object.defineProperty(model, prop, {
        enumerable: true,
        configurable: true,
        get: () => value,
        set: (newValue) => {
            value = newValue;

            if (model.modelChanges && !model.applyingRemoteUpdate) {
                model.modelChanges.next(prop);
            }
        },
    });
};
```

Call it in the constructor for every property that should be synchronized. The following class
is the equivalent of the decorated `SampleClass` from the supported documentation, and
interoperable with it over the network:

```js
import { RegisterModelSync, SyncModel } from '@hcikn/colibri';

export class SampleClass extends SyncModel {
    constructor(id) {
        super(id);

        defineSynced(this, 'name', '');
        defineSynced(this, 'age', 0);
        // a custom name for the synced property, as in @Synced('billingAddress')
        defineSynced(this, 'address', '', 'billingAddress');
    }
}

// registration is identical, just without the type parameter
const [SampleClasses$, registerExampleClass] = RegisterModelSync({ type: SampleClass });
```

`RegisterModelSync`, the returned BehaviorSubject, `update()`, `toJson()` and `delete()` need no
workaround — they are ordinary methods and behave as documented.

## Runnable example

[model-sync.js](model-sync.js) is a self-contained JavaScript version of
[samples/model-sync.ts](../../samples/model-sync.ts). There is no npm script for it; run it
manually from the `colibri-web` folder:

```sh
npm run build && node docs/js-workaround/model-sync.js
```

The `npm run build` is required: plain Node resolves `@hcikn/colibri` through the package's own
`exports` entry (i.e. `dist/`), not through the `tsconfig.json` path mapping that `tsx` uses for
the TypeScript samples.
