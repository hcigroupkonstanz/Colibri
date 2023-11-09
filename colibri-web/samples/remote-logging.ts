import { Colibri, RemoteLogger } from '@hcikn/colibri';

Colibri.init('myApp', 'colibri.hci.uni.kn');

// once we initialize the remote logger, everything logged via console will be sent to the server (and to the console)
RemoteLogger.init();

// visit the web interface at http://<YOUR_COLIBRI_SERVER>:9011 to see the logs
// in this case: http://colibri.hci.uni.kn:9011
console.log('Hello world!');
console.info('This is an information');
console.debug('This is a debug message', { foo: 'bar' });
console.warn('This is a warning');
console.error('This is an error', new Error('Error message'));
