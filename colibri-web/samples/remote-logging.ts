import { Colibri, RemoteLogger } from '@hcikn/colibri';

import { colibriAddress, colibriPort } from './common';

(async () => {
    new Colibri('myAppName', await colibriAddress(), await colibriPort());

    console.log(
        'The following prompts will be printed to the console, but also sent to the server:'
    );
    // once we initialize the remote logger, everything logged via console will now be sent to the server (and to the console)
    new RemoteLogger(true);

    // visit the web interface at http://<YOUR_COLIBRI_SERVER>:9011 to see the logs
    // in this case: http://colibri.hci.uni-konstanz.de:9011
    console.log('Hello world!');
    console.info('This is an information');
    console.debug('This is a debug message', { foo: 'bar' });
    console.warn('This is a warning');
    console.error('This is an error', new Error('Error message'));
})();
