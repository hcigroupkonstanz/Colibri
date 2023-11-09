import { Colibri, RemoteLogger } from '@hcikn/colibri';

import { colibriAddress } from './common';

(async () => {
    Colibri.init('myAppName', await colibriAddress());


    console.log('The following prompts will be printed to the console, but also sent to the server');
    // once we initialize the remote logger, everything logged via console will now be sent to the server (and to the console)
    RemoteLogger.init();

    // visit the web interface at http://<YOUR_COLIBRI_SERVER>:9011 to see the logs
    // in this case: http://colibri.hci.uni.kn:9011
    console.log('Hello world!');
    console.info('This is an information');
    console.debug('This is a debug message', { foo: 'bar' });
    console.warn('This is a warning');
    console.error('This is an error', new Error('Error message'));
})();
