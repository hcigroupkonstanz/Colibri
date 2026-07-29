import { Colibri, GetRestApi, PutRestApi } from '@hcikn/colibri';

import { colibriAddress, colibriPort, rl } from './common';

void (async () => {
    new Colibri('myAppName', await colibriAddress(), await colibriPort());

    const sampleObject = {
        name: 'Test',
        age: 32,
        skills: ['Typescript', 'C#']
    };
    const identifier = 'sampleObject';

    await PutRestApi(identifier, sampleObject);

    console.log(
        'The object is stored at: %o',
        Colibri.getInstance()?.getRestUri(identifier)
    );
    console.log(' ');
    console.log('Try to modify the age bytyping "sampleObject.age = 22"');
    console.log('Terminate by typing "exit"');

    const sendNumber = () => {
        return new Promise((resolve) => {
            rl.question('> ', (answer) => {
                if (answer === 'exit') {
                    rl.close();
                    process.exit();
                } else {
                    void (async () => {
                        try {
                            eval(answer);
                            if (await PutRestApi(identifier, sampleObject)) {
                                console.log(
                                    'Stored object updated successfully!'
                                );
                            } else {
                                console.error(
                                    'An error occurred while updating the stored object!'
                                );
                            }

                            console.log(
                                'Stored Object: %o',
                                await GetRestApi(identifier)
                            );
                        } catch (e) {
                            console.error(e);
                        }
                        resolve(0);
                    })();
                }
            });
        });
    };

    for (;;) {
        await sendNumber();
    }
})();
