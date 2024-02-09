import { Colibri, RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';
import { rl, colibriAddress, colibriPort } from './common';

/**
 *  To use the @Synced() decorator, please add the following to the "compiler" field of your tsconfig.json:
 *  "experimentalDecorators": true
 */
export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    get name() {
        return this._name;
    }
    set name(val: string) {
        this._name = val;
    }
    private _name = '';

    /* Warning: for some reason syncing fields does not work with some frameworks (e.g., React)! */
    @Synced()
    public age = 0;

    // We can provide a custom name for the synced property
    @Synced('billingAddress')
    public address = '';
}

(async () => {
    new Colibri('myAppName', await colibriAddress(), await colibriPort());

    /**
     *  This is the registration for the SampleClass.
     *  It returns an observable (BehaviorSubject) that contains all instances of SampleClass and a function to register new instances.
     */
    const [SampleClasses$, registerExampleClass] =
        RegisterModelSync<SampleClass>({ type: SampleClass });

    // SampleClasses$ contains all synchronized instances.
    // Since 'RegisterModelSync' returns a BehaviorSubject, the method will be executed with the current value.
    SampleClasses$.subscribe((classes) => {
        // will be called whenever a new instance is created, an existing one is updated, or one is deleted
        // please refer to RxJS documentation for more information: https://rxjs.dev/guide/overview
        console.log(
            'Current SampleClasses:',
            classes.map((c) => ({
                name: c.name,
                age: c.age,
                address: c.address,
            }))
        );
    });

    // When creating a new instance, we need to register it with the model synchronization
    const newClass = new SampleClass('use a real id here');
    registerExampleClass(newClass);

    // models can be deleted by calling the delete method
    // newClass.delete();

    const sendNumber = () => {
        return new Promise((res) => {
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
                    res(0);
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

    // eslint-disable-next-line no-constant-condition
    while (true) {
        await sendNumber();
    }
})();
