import { Colibri, Sync } from '@hcikn/colibri';
import { rl, colibriAddress } from './common';

(async () => {
    Colibri.init('myAppName', await colibriAddress());

    console.log('Registering listeners for boolean, number, and string channels');
    Sync.receiveBool('myChannel', (value) => {
        console.log('Boolean value received on myChannel', value);
    });

    Sync.receiveNumber('myChannel', (value) => {
        console.log('Number value received on myChannel', value);
    });

    Sync.receiveString('myChannel', (value) => {
        console.log('String value received on myChannel', value);
    });

    // Example for unregistering a listener
    const listener = (value: boolean) => {
        // Do something with the value
    };
    Sync.receiveBool('myChannel', listener);
    Sync.unregister('myChannel', listener);

    const sendNumber = () => {
        return new Promise((res) => {
            rl.question('Please enter a value to send to the server (exit to quit): ', (answer) => {
                if (answer === 'exit') {
                    rl.close();
                    process.exit();
                } else {
                    console.log(`Sending value "${answer}" to server`);
                    Sync.sendString('myChannel', answer);
                    res(0);
                }
            });
        });
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
        await sendNumber();
    }

})();