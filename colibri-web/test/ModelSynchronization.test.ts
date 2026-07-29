import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock
} from 'vitest';
import type { Observable } from 'rxjs';

// Mock the Colibri wire layer so the real socket.io implementation never runs.
// SendMessage / RegisterChannel come back as vi.fn() mocks we can inspect.
vi.mock('../src/Colibri', () => ({
    SendMessage: vi.fn(),
    RegisterChannel: vi.fn()
}));

import { SendMessage, RegisterChannel } from '../src/Colibri';
import type { Message } from '../src/Colibri';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';

// --- Test models -----------------------------------------------------------

class Widget extends SyncModel<Widget> {
    @Synced() accessor label = '';
    @Synced() accessor count = 0;
}

class Gadget extends SyncModel<Gadget> {
    @Synced() accessor title = '';
}

// --- Helpers ---------------------------------------------------------------

const sendMessageMock = SendMessage as unknown as Mock<
    (channel: string, command: string, payload?: unknown) => void
>;
const registerChannelMock = RegisterChannel as unknown as Mock<
    (channel: string, handler: (payload: Message) => void) => void
>;

/** Grab the handler that RegisterModelSync passed to RegisterChannel. */
function capturedHandler(): (payload: Message) => void {
    return registerChannelMock.mock.calls[0][1];
}

/** Read the current value out of a BehaviorSubject-backed observable. */
function latest<T>(obs: Observable<T[]>): T[] {
    let value: T[] = [];
    const sub = obs.subscribe((v) => {
        value = v;
    });
    sub.unsubscribe();
    return value;
}

/** All SendMessage calls that used the given command. */
function updateCalls(command = 'model::update') {
    return sendMessageMock.mock.calls.filter(c => c[1] === command);
}

describe('ModelSynchronization', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;
    let logSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        errorSpy = vi
            .spyOn(console, 'error')
            .mockImplementation(() => undefined);
        logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        errorSpy.mockRestore();
        logSpy.mockRestore();
        vi.useRealTimers();
    });

    describe('RegisterModelSync', () => {
        it('requests initial data, registers the channel, and captures the handler', () => {
            RegisterModelSync({ name: 'widget', type: Widget });

            // initial data fetch
            expect(sendMessageMock).toHaveBeenCalledWith(
                'widget',
                'model::request'
            );

            // registered exactly one channel, with the derived name
            expect(registerChannelMock).toHaveBeenCalledTimes(1);
            expect(registerChannelMock.mock.calls[0][0]).toBe('widget');

            // handler captured successfully
            expect(typeof capturedHandler()).toBe('function');
        });

        it('uses an explicit name verbatim', () => {
            RegisterModelSync({ name: 'CustomName', type: Widget });

            expect(sendMessageMock).toHaveBeenCalledWith(
                'CustomName',
                'model::request'
            );
            expect(registerChannelMock.mock.calls[0][0]).toBe('CustomName');
        });

        it('derives a lowercased class name when name is omitted', () => {
            RegisterModelSync({ type: Widget });

            expect(sendMessageMock).toHaveBeenCalledWith(
                'widget',
                'model::request'
            );
            expect(registerChannelMock.mock.calls[0][0]).toBe('widget');

            // A different class derives a different channel name.
            vi.clearAllMocks();
            RegisterModelSync({ type: Gadget });
            expect(registerChannelMock.mock.calls[0][0]).toBe('gadget');
        });
    });

    describe('registerModel (locally created models)', () => {
        it('sends the full toJson() as an initial model::update and lists the model', () => {
            const [models, registerModel] = RegisterModelSync({
                name: 'widget',
                type: Widget
            });

            const w = new Widget('local-1');
            w.label = 'hello';
            w.count = 3;

            // clear the model::request bookkeeping so we can assert cleanly
            sendMessageMock.mockClear();

            registerModel(w);

            // Full toJson sent as the initial update.
            const calls = updateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0][0]).toBe('widget');
            expect(calls[0][2]).toEqual({
                id: 'local-1',
                label: 'hello',
                count: 3
            });

            // Model is present in the latest emission.
            const current = latest(models);
            expect(current).toContain(w);
            expect(current.length).toBe(1);
        });

        it('sends only the changed key after a @Synced edit is buffered', async () => {
            vi.useFakeTimers();

            const [, registerModel] = RegisterModelSync({
                name: 'widget',
                type: Widget
            });

            const w = new Widget('local-1');
            registerModel(w);
            sendMessageMock.mockClear();

            // Local edit of a single synced field.
            w.label = 'changed';

            // Nothing sent until the 1ms buffer flushes.
            expect(updateCalls().length).toBe(0);

            await vi.advanceTimersByTimeAsync(1);

            const calls = updateCalls();
            expect(calls.length).toBe(1);
            expect(calls[0][0]).toBe('widget');
            // Only the changed key (+ id) is included, not `count`.
            expect(calls[0][2]).toEqual({ id: 'local-1', label: 'changed' });
        });
    });

    describe('inbound handler messages', () => {
        it('constructs a new model of the registered type for an unknown id', () => {
            const [models] = RegisterModelSync({
                name: 'widget',
                type: Widget
            });
            const handler = capturedHandler();

            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-1', label: 'from server', count: 7 }
            });

            const current = latest(models);
            expect(current.length).toBe(1);
            expect(current[0]).toBeInstanceOf(Widget);
            expect(current[0].id).toBe('srv-1');
            expect(current[0].label).toBe('from server');
            expect(current[0].count).toBe(7);
            expect(current[0].toJson()).toEqual({
                id: 'srv-1',
                label: 'from server',
                count: 7
            });
        });

        it('does NOT echo an inbound new-model update back to the server', async () => {
            vi.useFakeTimers();

            RegisterModelSync({ name: 'widget', type: Widget });
            const handler = capturedHandler();

            sendMessageMock.mockClear();

            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-1', label: 'from server' }
            });

            // Let the 1ms bufferTime window elapse.
            await vi.advanceTimersByTimeAsync(2);

            // The @Synced setter suppresses emission while applyingRemoteUpdate
            // is true (SyncModel.update), so no echo update should be sent.
            expect(updateCalls().length).toBe(0);
        });

        it('updates an existing model in place instead of duplicating it', () => {
            const [models] = RegisterModelSync({
                name: 'widget',
                type: Widget
            });
            const handler = capturedHandler();

            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-1', label: 'first', count: 1 }
            });

            const created = latest(models)[0];

            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-1', label: 'second', count: 2 }
            });

            const current = latest(models);
            // Same object reference, no duplicate.
            expect(current.length).toBe(1);
            expect(current[0]).toBe(created);
            expect(current[0].label).toBe('second');
            expect(current[0].count).toBe(2);
        });

        it('removes a model on model::delete', () => {
            const [models] = RegisterModelSync({
                name: 'widget',
                type: Widget
            });
            const handler = capturedHandler();

            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-1', label: 'a' }
            });
            handler({
                channel: 'widget',
                command: 'model::update',
                payload: { id: 'srv-2', label: 'b' }
            });
            expect(latest(models).length).toBe(2);

            handler({
                channel: 'widget',
                command: 'model::delete',
                payload: { id: 'srv-1' }
            });

            const current = latest(models);
            expect(current.length).toBe(1);
            expect(current.find(m => m.id === 'srv-1')).toBeUndefined();
            expect(current[0].id).toBe('srv-2');
        });

        it('logs an error for an unknown command without throwing', () => {
            RegisterModelSync({ name: 'widget', type: Widget });
            const handler = capturedHandler();

            expect(() => {
                handler({
                    channel: 'widget',
                    command: 'model::bogus',
                    payload: { id: 'x' }
                });
            }
            ).not.toThrow();

            expect(errorSpy).toHaveBeenCalledWith(
                expect.stringContaining('Unknown model command')
            );
        });
    });
});
