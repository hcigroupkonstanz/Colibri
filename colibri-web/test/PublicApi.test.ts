import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import * as api from '../src/index';
import { Colibri, ProtocolMismatchError, RemoteLogger, Sync, SyncModel, SyncTransform } from '../src/index';
import type { ColorValue, Message, Quaternion, Vector3 } from '../src/index';

const connectMock = connect as unknown as Mock;

const RUNTIME_EXPORTS = [
    'Colibri',
    'ColibriError',
    'DeleteRestApi',
    'GetRestApi',
    'PROTOCOL_VERSION',
    'ProtocolMismatchError',
    'PutRestApi',
    'RegisterChannel',
    'RegisterModelSync',
    'RegisterOnce',
    'RegisterSyncTransforms',
    'RemoteLogger',
    'SendMessage',
    'Sync',
    'SyncModel',
    'SyncTransform',
    'Synced',
    'UnregisterChannel',
    'synced',
    'toHexColor',
    'toRgbaColor'
];

const SYNC_KEYS = [
    'receiveBool',
    'receiveBoolArray',
    'receiveColor',
    'receiveColorArray',
    'receiveJson',
    'receiveNumber',
    'receiveNumberArray',
    'receiveQuaternion',
    'receiveQuaternionArray',
    'receiveString',
    'receiveStringArray',
    'receiveVector2',
    'receiveVector2Array',
    'receiveVector3',
    'receiveVector3Array',
    'sendBool',
    'sendBoolArray',
    'sendColor',
    'sendColorArray',
    'sendFloat',
    'sendFloatArray',
    'sendInt',
    'sendIntArray',
    'sendJson',
    'sendNumber',
    'sendNumberArray',
    'sendQuaternion',
    'sendQuaternionArray',
    'sendString',
    'sendStringArray',
    'sendVector2',
    'sendVector2Array',
    'sendVector3',
    'sendVector3Array',
    'unregister'
];

const typesOfMembers = (target: object, names: readonly string[]): Record<string, string> =>
    Object.fromEntries(names.map(name => [name, typeof Reflect.get(target, name)]));

const functionsNamed = (names: readonly string[]): Record<string, string> =>
    Object.fromEntries(names.map(name => [name, 'function']));

const distFile = (name: string): string => fileURLToPath(new URL(`../dist/${name}`, import.meta.url));

class Model extends SyncModel<{ value: number }> {}

class ModelWatchingChanges extends SyncModel<{ value: number }> {
    public readonly changed: string[] = [];

    protected override onModelChanges(prop: string): void {
        this.changed.push(prop);
        super.onModelChanges(prop);
    }
}

describe('runtime exports of src/index.ts', () => {
    it('are exactly the names the package lists', () => {
        expect(Object.keys(api).sort()).toEqual(RUNTIME_EXPORTS);
    });
});

describe.runIf(existsSync(distFile('index.js')))('runtime exports of dist/index.js', () => {
    it('are exactly the names the package lists', async () => {
        const bundle = (await import(pathToFileURL(distFile('index.js')).href)) as Record<string, unknown>;

        expect(Object.keys(bundle).sort()).toEqual(RUNTIME_EXPORTS);
    });
});

describe.runIf(existsSync(distFile('index.cjs')))('runtime exports of dist/index.cjs', () => {
    it('are exactly the names the package lists', () => {
        const bundle = createRequire(import.meta.url)(distFile('index.cjs')) as Record<string, unknown>;

        expect(Object.keys(bundle).sort()).toEqual(RUNTIME_EXPORTS);
    });
});

describe('Colibri', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        connectMock.mockReturnValue({
            on: vi.fn(),
            once: vi.fn(),
            off: vi.fn(),
            onAny: vi.fn(),
            emit: vi.fn(),
            disconnect: vi.fn()
        });
    });

    afterEach(() => {
        // Colibri.instance is a private static that must not leak between tests.
        (Colibri as unknown as { instance: Colibri | null }).instance = null;
    });

    it('has the methods on the prototype', () => {
        const methods = [
            'getRestUri',
            'getRestObject',
            'setRestObject',
            'deleteRestObject',
            'sendMessage',
            'registerChannel',
            'unregisterChannel',
            'registerOnce'
        ];

        expect(typesOfMembers(Colibri.prototype, methods)).toEqual(functionsNamed(methods));
    });

    it('has the static getInstance', () => {
        expect(typeof Colibri.getInstance).toBe('function');
    });

    it('has the fields on an instance', () => {
        const colibri = new Colibri('app', 'localhost', 9211);

        expect(
            typesOfMembers(colibri, ['app', 'server', 'port', 'uri', 'uriRestApi', 'messages', 'protocolMismatch'])
        ).toEqual({
            app: 'string',
            server: 'string',
            port: 'number',
            uri: 'string',
            uriRestApi: 'string',
            messages: 'object',
            protocolMismatch: 'object'
        });
    });
});

describe('SyncModel', () => {
    const methods = ['delete', 'detach', 'registerSyncedProperty', 'update', 'toJson'];

    it('has the methods on the prototype', () => {
        expect(typesOfMembers(SyncModel.prototype, methods)).toEqual(functionsNamed(methods));
    });

    it('has the fields and methods on a subclass instance', () => {
        const model = new Model('m1');

        expect(
            typesOfMembers(model, [
                'id',
                'applyingRemoteUpdate',
                'modelChanges',
                'modelChanges$',
                'deletions',
                ...methods
            ])
        ).toEqual({
            id: 'string',
            applyingRemoteUpdate: 'boolean',
            modelChanges: 'object',
            modelChanges$: 'object',
            deletions: 'object',
            ...functionsNamed(methods)
        });
    });
});

describe('type exports of src/index.ts', () => {
    it('are usable as types', () => {
        const color: ColorValue = '#FF0000FF';
        const message: Message = { channel: 'c', command: 'x', payload: 1 };
        const rotation: Quaternion = [0, 0, 0, 1];
        const position: Vector3 = [0, 0, 0];

        expect([color, message, rotation, position]).toHaveLength(4);
    });
});

describe('SyncModel subclasses', () => {
    it('can override the protected onModelChanges', () => {
        expect(typeof Reflect.get(SyncModel.prototype, 'onModelChanges')).toBe('function');
        expect(new ModelWatchingChanges('m2').changed).toEqual([]);
    });
});

describe('ProtocolMismatchError', () => {
    it('has the fields on an instance', () => {
        const error = new ProtocolMismatchError('message', '1', '2', false);

        expect(typesOfMembers(error, ['serverVersion', 'clientVersion', 'fatal'])).toEqual({
            serverVersion: 'string',
            clientVersion: 'string',
            fatal: 'boolean'
        });
    });
});

describe('Sync', () => {
    it('has exactly these keys', () => {
        expect(Object.keys(Sync).sort()).toEqual(SYNC_KEYS);
    });

    it('has a function under every key', () => {
        expect(typesOfMembers(Sync, SYNC_KEYS)).toEqual(functionsNamed(SYNC_KEYS));
    });
});

describe('RemoteLogger', () => {
    it('has the static init', () => {
        expect(typesOfMembers(RemoteLogger, ['init'])).toEqual(functionsNamed(['init']));
    });

    it('has enable and disable on the prototype', () => {
        const methods = ['enable', 'disable'];

        expect(typesOfMembers(RemoteLogger.prototype, methods)).toEqual(functionsNamed(methods));
    });
});

describe('SyncTransform', () => {
    it.each(['active', 'position', 'rotation', 'scale', 'physicsId'])('has the accessor %s on the prototype', name => {
        const descriptor = Object.getOwnPropertyDescriptor(SyncTransform.prototype, name);

        expect(typeof descriptor?.get).toBe('function');
        expect(typeof descriptor?.set).toBe('function');
    });
});
