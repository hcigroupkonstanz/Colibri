import { vi } from 'vitest';
import type { Message } from '../../src/Colibri';

type SocketHandler = (...args: unknown[]) => void;

export function makeFakeSocket() {
    // The ids requested on 'colibri::reconnect', kept apart from emit's calls, which a test may clear.
    const endMarkers: string[] = [];
    return {
        on: vi.fn<(event: string, cb: SocketHandler) => void>(),
        once: vi.fn<(event: string, cb: SocketHandler) => void>(),
        off: vi.fn<(event: string, cb: SocketHandler) => void>(),
        onAny: vi.fn<(cb: SocketHandler) => void>(),
        emit: vi.fn<(event: string, ...args: unknown[]) => void>((event, msg) => {
            if (event === 'colibri::reconnect') endMarkers.push(((msg as Message).payload as { id: string }).id);
        }),
        endMarkers,
        disconnect: vi.fn<() => void>(),
        // Read when the old-server timer expires; a socket that is down explains the silence by itself.
        connected: true,
        // Whether Socket.IO retries after a failed connection attempt.
        active: true,
        // The Manager owns the retry policy; a protocol rejection has to switch it off there.
        io: { reconnection: vi.fn<(on: boolean) => void>() }
    };
}

export type FakeSocket = ReturnType<typeof makeFakeSocket>;

export function getAnyHandler(mock: ReturnType<typeof makeFakeSocket>['onAny']): SocketHandler {
    const call = mock.mock.calls.at(0);
    if (!call) throw new Error('no onAny handler registered');
    return call[0];
}

export function getHandler(mock: ReturnType<typeof makeFakeSocket>['on'], event: string): SocketHandler {
    const call = mock.mock.calls.find(([e]) => e === event);
    if (!call) throw new Error(`no handler registered for "${event}"`);
    return call[1];
}
