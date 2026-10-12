import { Colibri, RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';
import { colibriAddress, colibriPort, rl } from './common';

/**
 *  To use the @Synced() decorator, TypeScript standard decorators must be enabled
 *  (the default since TypeScript 5.0). Make sure "experimentalDecorators" is
 *  *not* set in your tsconfig.json, and decorate `accessor` members:
 */
export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    accessor name = '';

    @Synced()
    accessor age = 0;

    // We can provide a custom name for the synced property
    @Synced('billingAddress')
    accessor address = '';
}

void (async () => {
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
    const [SampleClasses$, registerExampleClass] = RegisterModelSync<SampleClass>({
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

    for (;;) {
        await sendNumber();
    }
})();
