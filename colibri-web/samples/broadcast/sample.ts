import { Colibri, Sync } from '@hcikn/colibri';

Colibri.init('myAppName', 'colibri.hci.uni.kn');

Sync.sendBool('myChannel', true);

Sync.receiveBool('myChannel', (value) => {
    console.log('Value received on myChannel', value);
});

const listener = (value: boolean) => {
    // Do something with the value
};
Sync.receiveBool('myChannel', listener);
Sync.unregister('myChannel', listener);
