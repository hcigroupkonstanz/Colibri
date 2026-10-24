// Registering channels, listeners and models before new Colibri() exists: they attach once it is constructed.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Sync } from '../src/Broadcasting';
import { Colibri, RegisterChannel, RegisterOnce, UnregisterChannel } from '../src/Colibri';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { type FakeSocket, makeFakeSocket } from './support/fakeSocket';
import { Widget, deliver, latest, nextTask } from './support/modelSyncHelpers';

const connectMock = connect as unknown as Mock;

let fakeSocket: FakeSocket;

beforeEach(() => {
    vi.clearAllMocks();
    fakeSocket = makeFakeSocket();
    connectMock.mockReturnValue(fakeSocket);
});

afterEach(() => {
    // Colibri.instance is a private static that must not leak between tests.
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
    fakeSocket.connected = false;
    vi.unstubAllGlobals();
});

// Registering first and constructing Colibri second is the natural order for module-level code
// (`const [players$] = RegisterModelSync(...)` at the top of a file), and it used to leave every
// one of those registrations listening to nothing, silently.
describe('registering before new Colibri()', () => {
    let warnSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    it('attaches RegisterChannel and RegisterOnce handlers once Colibri is constructed', () => {
        const handler = vi.fn();
        const onceHandler = vi.fn();
        RegisterChannel('early', handler);
        RegisterOnce('early-once', onceHandler);
        expect(connectMock).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9211);

        expect(fakeSocket.on).toHaveBeenCalledWith('early', handler);
        expect(fakeSocket.once).toHaveBeenCalledWith('early-once', onceHandler);
        // Registering early is supported now, so it is no longer worth a warning.
        expect(warnSpy).not.toHaveBeenCalled();
    });

    it('lets UnregisterChannel take back a handler that is still waiting', () => {
        const handler = vi.fn();
        RegisterChannel('early', handler);
        RegisterOnce('early', handler);
        UnregisterChannel('early', handler);
        UnregisterChannel('early', handler);

        new Colibri('app', 'localhost', 9211);

        expect(fakeSocket.on).not.toHaveBeenCalledWith('early', handler);
        expect(fakeSocket.once).not.toHaveBeenCalledWith('early', handler);
    });

    it('delivers to a Sync.receive* listener registered before Colibri existed', () => {
        const received = vi.fn();
        Sync.receiveString('early-sync', received);

        new Colibri('app', 'localhost', 9211);
        deliver(fakeSocket, 'early-sync', { command: 'broadcast::string', payload: 'hello' });

        expect(received).toHaveBeenCalledWith('hello');
    });

    it('does not attach a Sync listener that was unregistered before Colibri existed', () => {
        const received = vi.fn();
        Sync.receiveBool('early-unregistered', received);
        Sync.unregister('early-unregistered', received);

        new Colibri('app', 'localhost', 9211);

        expect(fakeSocket.on.mock.calls.map(([event]) => event)).not.toContain('early-unregistered');
    });

    it('requests the current state, and receives models, for a RegisterModelSync made first', async () => {
        const [models$] = RegisterModelSync({ name: 'early-widget', type: Widget });
        expect(warnSpy).not.toHaveBeenCalled();

        new Colibri('app', 'localhost', 9211);
        await nextTask();

        expect(fakeSocket.emit).toHaveBeenCalledWith('early-widget', { command: 'model::request', payload: {} });

        deliver(fakeSocket, 'early-widget', {
            command: 'model::update',
            payload: { id: 'w1', label: 'from the server' }
        });

        const models = latest(models$);
        expect(models).toHaveLength(1);
        expect(models[0].label).toBe('from the server');
    });

    it('asks for a model registered before Colibri existed once Colibri does, and sends it as it is then', () => {
        vi.useFakeTimers();
        const [, registerModel] = RegisterModelSync({ name: 'early-local', type: Widget });
        const widget = new Widget('w1');
        try {
            registerModel(widget);
            widget.label = 'changed before connecting';

            new Colibri('app', 'localhost', 9211);

            expect(fakeSocket.emit).toHaveBeenCalledWith('early-local', {
                command: 'model::request',
                payload: { id: 'w1' }
            });

            // The server has nothing for it.
            deliver(fakeSocket, 'early-local', { command: 'model::update', payload: { id: 'w1' } });

            expect(fakeSocket.emit).toHaveBeenCalledWith('early-local', {
                command: 'model::update',
                payload: { id: 'w1', label: 'changed before connecting' }
            });
        } finally {
            widget.delete();
            vi.useRealTimers();
        }
    });
});
