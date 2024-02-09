import { Colibri, Sync } from '@hcikn/colibri';
import { rl, colibriAddress, colibriPort } from './common';

(async () => {
    new Colibri('myAppName', await colibriAddress(), await colibriPort());

    console.log(
        'Registering listeners for boolean, number, and string channels'
    );
    Sync.receiveBool('myChannel', (value) => {
        console.log('Boolean value received on myChannel', value);
    });

    Sync.receiveNumber('myChannel', (value) => {
        console.log('Number value received on myChannel', value);
    });

    Sync.receiveString('myChannel', (value) => {
        console.log('String value received on myChannel', value);
    });

    Sync.receiveJson('myChannel', (value) => {
        console.log('JSON value received on myChannel', value);
    });

    // Example for unregistering a listener
    const listener = (value: boolean) => {
        // Do something with the value
        console.log('Listener received: %o', value);
    };
    Sync.receiveBool('myChannel', listener);
    Sync.unregister('myChannel', listener);

    const sendNumber = () => {
        return new Promise((res) => {
            rl.question(
                'Please enter a value to send to the server (exit to quit): ',
                (answer) => {
                    if (answer === 'exit') {
                        rl.close();
                        process.exit();
                    }

                    // Try to guess the type
                    else if (answer === 'true' || answer === 'false') {
                        Sync.sendBool('myChannel', JSON.parse(answer));
                        console.log(
                            `Sending boolean value "${answer}" to server`
                        );
                    } else if (!isNaN(Number(answer))) {
                        Sync.sendNumber('myChannel', Number(answer));
                        console.log(
                            `Sending number value "${answer}" to server`
                        );
                    } else {
                        try {
                            Sync.sendJson('myChannel', JSON.parse(answer));
                            console.log(
                                `Sending JSON value "${answer}" to server`
                            );
                        } catch (_) {
                            Sync.sendString('myChannel', answer);
                            console.log(
                                `Sending string value "${answer}" to server`
                            );
                        }
                    }

                    res(0);
                }
            );
        });
    };

    // eslint-disable-next-line no-constant-condition
    while (true) {
        await sendNumber();
    }
})();
