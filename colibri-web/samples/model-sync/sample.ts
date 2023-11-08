import { Colibri, RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

Colibri.init('myAppName', 'colibri.hci.uni.kn');

/**
 *  To use the @Synced() decorator, please add the following to the "compiler" field of your tsconfig.json:
 *  "experimentalDecorators": true
 */
export class SampleClass extends SyncModel<SampleClass> {
    @Synced()
    get name() { return this._name; }
    set name(val: string) { this._name = val; }
    private _name = '';

    /* Warning: for some reason syncing fields does not work with some frameworks (e.g., React)! */
    @Synced()
    private age = 0;

    // We can provide a custom name for the synced property
    @Synced('billingAddress')
    private address = '';
}

/**
 *  This is the registration for the SampleClass.
 *  It returns an observable (BehaviorSubject) that contains all instances of SampleClass and a function to register new instances.
 */
const [ SampleClasses$, registerExampleClass ] = RegisterModelSync<SampleClass>({ type: SampleClass });

// SampleClasses$ contains all synchronized instances.
// Since 'RegisterModelSync' returns a BehaviorSubject, the method will be executed with the current value.
SampleClasses$.subscribe(classes => {
    // will be called whenever a new instance is created, an existing one is updated, or one is deleted
    // please refer to RxJS documentation for more information: https://rxjs.dev/guide/overview
    console.log('SampleClasses:', classes);
});


// When creating a new instance, we need to register it with the model synchronization
const newClass = new SampleClass('use a real id here');
registerExampleClass(newClass);
