/**
 *  JavaScript workaround for projects that are tied to plain JavaScript — please
 *  read ./README.md first. Colibri targets TypeScript; a workaround is not a
 *  feature and is not covered by the tests.
 *
 *  Self-contained equivalent of samples/model-sync.ts. Run from the colibri-web
 *  folder with:  npm run build && node docs/js-workaround/model-sync.js
 */
import * as readline from 'node:readline';

import { Colibri, RegisterModelSync, SyncModel } from '@hcikn/colibri';

console.log(
    '=============================================================================='
);
console.log(
    'Please start a second instance of this application to see the sample in action'
);
console.log(
    '=============================================================================='
);

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

const colibriAddress = async () => {
    return new Promise((resolve) => {
        rl.question(
            'Please specify a colibri server address (default: colibri.hci.uni-konstanz.de) >> ',
            (answer) => {
                resolve(
                    answer.trim().length === 0
                        ? 'colibri.hci.uni-konstanz.de'
                        : answer
                );
            }
        );
    });
};

const colibriPort = async () => {
    return new Promise((resolve) => {
        rl.question(
            'Please specify a colibri server port (default: 9011) >> ',
            (answer) => {
                const port = parseInt(answer);
                resolve(port > 0 ? port : 9011);
            }
        );
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
        set: (newValue) => {
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
     *  This is the registration for the SampleClass.
     *  It returns an observable (BehaviorSubject) that contains all instances
     *  of SampleClass and a function to register new instances.
     */
    const [SampleClasses$, registerExampleClass] = RegisterModelSync({
        type: SampleClass
    });

    // SampleClasses$ contains all synchronized instances.
    // Since 'RegisterModelSync' returns a BehaviorSubject,
    // the method will be executed with the current value.
    SampleClasses$.subscribe((classes) => {
        // will be called whenever a new instance is created,
        // an existing one is updated, or one is deleted
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

    // models can be deleted by calling the delete method
    // newClass.delete();

    const sendNumber = () => {
        return new Promise((resolve) => {
            rl.question('> ', (answer) => {
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
    console.log(
        'Try to modify the name of the SampleClass instance by typing "newClass.name = \'new name\'"'
    );
    console.log(
        'or instantiate new objects here via "registerExampleClass(new SampleClass(\'myId\'))" '
    );
    console.log(' ');
    console.log('Terminate by typing "exit"');
    console.log(' ');

    while (true) {
        await sendNumber();
    }
})();
