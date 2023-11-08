import { Colibri, Sync } from '@hcikn/colibri';

Colibri.init('myAppName', 'colibri.hci.uni.kn');

Sync.sendBool('myChannel', true);
