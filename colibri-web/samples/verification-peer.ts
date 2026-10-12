/**
 * Non-interactive counterpart to the Unity SendMessages sample, for the 2.0.0 end-to-end
 * verification: registers a listener for every type colibri-web supports on `myChannel`,
 * logs each one, and after a short delay sends one value of every type back.
 *
 * Broadcasts exclude the sender, so this has to be running for the Unity side to see anything.
 *
 * Usage: npm run samples/verification-peer -- [host] [port]
 *    or: npx tsx samples/verification-peer.ts [host] [port]
 */
import { Colibri, Sync } from '../src/index';

const host = process.argv[2] ?? 'localhost';
const port = Number(process.argv[3] ?? 9211);

new Colibri('myAppName', host, port);
console.log(`[peer] connecting to ${host}:${port} as myAppName`);

const seen = (label: string) => (value: unknown) => {
    console.log(`[peer] IN  ${label}:`, JSON.stringify(value));
};

Sync.receiveBool('myChannel', seen('bool'));
Sync.receiveNumber('myChannel', seen('number'));
Sync.receiveString('myChannel', seen('string'));
Sync.receiveJson('myChannel', seen('json'));
Sync.receiveVector2('myChannel', seen('vector2'));
Sync.receiveVector3('myChannel', seen('vector3'));
Sync.receiveQuaternion('myChannel', seen('quaternion'));
Sync.receiveColor('myChannel', seen('color'));

Sync.receiveBoolArray('myChannel', seen('bool[]'));
Sync.receiveNumberArray('myChannel', seen('number[]'));
Sync.receiveStringArray('myChannel', seen('string[]'));
Sync.receiveVector2Array('myChannel', seen('vector2[]'));
Sync.receiveVector3Array('myChannel', seen('vector3[]'));
Sync.receiveQuaternionArray('myChannel', seen('quaternion[]'));
Sync.receiveColorArray('myChannel', seen('color[]'));

setTimeout(
    () => {
        console.log('[peer] OUT sending one value of every type');

        Sync.sendBool('myChannel', true);
        Sync.sendNumber('myChannel', 42.5);
        // The bare string is the interesting one: v1 Unity wrote it unquoted, which is not JSON.
        Sync.sendString('myChannel', 'hello from the web client');
        Sync.sendJson('myChannel', { attribute1: 'example', attribute2: 5 });
        // Tuples, not {x,y,z} objects: that is what colibri-web's signatures declare, and it is
        // what Unity's JsonExtensions.ToJson emits.
        Sync.sendVector2('myChannel', [1, 2]);
        Sync.sendVector3('myChannel', [1, 2, 3]);
        Sync.sendQuaternion('myChannel', [0, 0, 0, 1]);
        Sync.sendColor('myChannel', [1, 0.5, 0.25, 1]);

        Sync.sendBoolArray('myChannel', [true, false, true]);
        Sync.sendNumberArray('myChannel', [1, 2, 3]);
        Sync.sendStringArray('myChannel', ['a', 'b', 'c']);
        Sync.sendVector2Array('myChannel', [
            [1, 2],
            [3, 4]
        ]);
        Sync.sendVector3Array('myChannel', [
            [1, 2, 3],
            [4, 5, 6]
        ]);
        Sync.sendQuaternionArray('myChannel', [[0, 0, 0, 1]]);
        Sync.sendColorArray('myChannel', [[0, 1, 0, 1]]);

        console.log('[peer] OUT done');
    },
    Number(process.env.COLIBRI_PEER_SEND_DELAY_MS ?? 5000)
);
