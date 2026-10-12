/**
 *  JavaScript workaround for projects that are tied to plain JavaScript. Please
 *  read ./README.md first. Colibri targets TypeScript; a workaround is not a
 *  feature and is not covered by the tests.
 *
 *  Self-contained equivalent of samples/model-sync.ts. Run from the colibri-web
 *  folder with:  npm run build && node docs/js-workaround/model-sync.js
 */
import * as readline from 'node:readline';

import { Colibri, RegisterModelSync, SyncModel } from '@hcikn/colibri';

console.log('==============================================================================');
console.log('Please start a second instance of this application to see the sample in action');
console.log('==============================================================================');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const colibriAddress = async () => {
    return new Promise(resolve => {
        rl.question('Please specify a colibri server address (default: colibri.hci.uni-konstanz.de) >> ', answer => {
            resolve(answer.trim().length === 0 ? 'colibri.hci.uni-konstanz.de' : answer);
        });
    });
};

const colibriPort = async () => {
    return new Promise(resolve => {
        rl.question('Please specify a colibri server port (default: 9211) >> ', answer => {
            const port = parseInt(answer);
            resolve(port > 0 ? port : 9211);
        });
    });
};

/**
 *  The @Synced() decorator used by samples/model-sync.ts relies on TypeScript's
 *  standard decorators, which plain Node cannot run. This helper is the
 *  decorator-free equivalent and does exactly what the decorator does:
 *    - register the mapping "network name -> local property" (lowercasing the
 *      network name, just like @Synced() does),
 *    - emit the property name on `modelChanges` whenever it is assigned, unless a
 *      remote update is currently being applied (that would echo the change back).
 *
 *  It relies on members of SyncModel that are public only because the decorator
 *  needs them; they are not a supported API. See ./README.md.
 */
const defineSynced = (model, prop, initialValue, syncedName = '') => {
    let value = initialValue;

    model.registerSyncedProperty((syncedName || prop).toLowerCase(), prop);

    Object.defineProperty(model, prop, {
        enumerable: true,
        configurable: true,
        get: () => value,
        set: newValue => {
            value = newValue;

            if (model.modelChanges && !model.applyingRemoteUpdate) {
                model.modelChanges.next(prop);
            }
        }
    });
};

export class SampleClass extends SyncModel {
    constructor(id) {
        super(id);

        defineSynced(this, 'name', '');
        defineSynced(this, 'age', 0);
        // We can provide a custom name for the synced property
        defineSynced(this, 'address', '', 'billingAddress');
    }
}

(async () => {
    new Colibri('myAppName', await colibriAddress(), await colibriPort());

    /**
     *  This is the registration for the SampleClass. It returns an Observable of every
     *  SampleClass instance - the ones registered here and the ones other clients
     *  created - and a function to register new instances.
     *
     *  `name` is the channel the instances are synced on; every client syncing them,
     *  Unity included, has to use the same one. Always give it: without it, the channel
     *  is the class name in lowercase, which a minifying production build changes.
     */
    const [SampleClasses$, registerExampleClass] = RegisterModelSync({
        name: 'sampleclass',
        type: SampleClass
    });

    // SampleClasses$ contains all synchronized instances. It hands every new subscriber
    // the current list at once, so the callback below also runs right away.
    SampleClasses$.subscribe(classes => {
        // will be called whenever an instance is added, an existing one is updated,
        // or another client deletes one
        // please refer to RxJS documentation for more information: https://rxjs.dev/guide/overview
        console.log(
            'Current SampleClasses:',
            classes.map(c => ({
                name: c.name,
                age: c.age,
                address: c.address
            }))
        );
    });

    // When creating a new instance, we need to register it with the model synchronization
    const newClass = new SampleClass('use a real id here');
    registerExampleClass(newClass);

    // colibri-web has no call that deletes a model for every client. newClass.delete() only
    // stops this client sending newClass's changes: newClass stays in SampleClasses$,
    // on the server and on every other client.
    // newClass.delete();

    const sendNumber = () => {
        return new Promise(resolve => {
            rl.question('> ', answer => {
                if (answer === 'exit') {
                    rl.close();
                    process.exit();
                } else {
                    try {
                        eval(answer);
                    } catch (e) {
                        console.error(e);
                    }
                    resolve(0);
                }
            });
        });
    };

    console.log(' ');
    console.log('Try to modify the name of the SampleClass instance by typing "newClass.name = \'new name\'"');
    console.log('or instantiate new objects here via "registerExampleClass(new SampleClass(\'myId\'))" ');
    console.log(' ');
    console.log('Terminate by typing "exit"');
    console.log(' ');

    while (true) {
        await sendNumber();
    }
})();
