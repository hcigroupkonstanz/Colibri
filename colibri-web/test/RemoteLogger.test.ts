import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

// Only the socket is faked. RemoteLogger runs through the real Colibri, SendMessage and
// getInstance: mocking those away is what hid that a line logged before `new Colibri()` recursed
// through getInstance's own warning until the stack overflowed.
vi.mock('socket.io-client', () => ({
    connect: vi.fn()
}));

import { connect } from 'socket.io-client';
import { Colibri } from '../src/Colibri';
import { RemoteLogger } from '../src/RemoteLogger';

const connectMock = connect as unknown as Mock;

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';
type PatchableConsole = Record<ConsoleMethod, (...args: unknown[]) => void>;
let originalConsole: Record<ConsoleMethod, Console[ConsoleMethod]>;

let emit: Mock<(channel: string, msg: { command: string; payload: unknown }) => void>;

beforeEach(() => {
    originalConsole = {
        debug: console.debug,
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error
    };
    // Stand-ins for the real console underneath the logger, so nothing reaches the test output
    // and what the logger passes through can be checked.
    for (const method of Object.keys(originalConsole) as ConsoleMethod[]) {
        (console as unknown as PatchableConsole)[method] = vi.fn();
    }

    emit = vi.fn();
    connectMock.mockReturnValue({
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        onAny: vi.fn(),
        emit,
        disconnect: vi.fn(),
        connected: false,
        io: { reconnection: vi.fn() }
    });
});

afterEach(() => {
    console.debug = originalConsole.debug;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
    (Colibri as unknown as { instance: Colibri | null }).instance = null;
    // The console was just restored, so the next RemoteLogger has to patch it afresh.
    (RemoteLogger as unknown as { patched: RemoteLogger | null }).patched = null;
});

/** Every line that went out on the `log` channel, as [level, message]. */
const forwarded = () =>
    emit.mock.calls.filter(([channel]) => channel === 'log').map(([, msg]) => [msg.command, msg.payload]);

const createColibri = () => new Colibri('app', 'localhost', 9211);

describe('RemoteLogger console patching', () => {
    it.each([
        ['debug', 'debug'],
        ['log', 'info'],
        ['info', 'info'],
        ['warn', 'warn'],
        ['error', 'error']
    ] as const)('console.%s still calls the original and forwards as level "%s"', (method, level) => {
        const original = (console as unknown as PatchableConsole)[method];
        createColibri();
        new RemoteLogger();

        (console as unknown as PatchableConsole)[method]('hello', 42);

        expect(original).toHaveBeenCalledWith('hello', 42);
        expect(forwarded()).toEqual([[level, 'hello,42']]);
    });
});

describe('RemoteLogger enable/disable', () => {
    beforeEach(() => {
        createColibri();
    });

    it('does not forward when constructed with enabled=false', () => {
        new RemoteLogger(false);
        console.log('hidden');
        expect(forwarded()).toEqual([]);
    });

    it('disable() stops forwarding and enable() resumes it', () => {
        const logger = new RemoteLogger();

        logger.disable();
        console.log('hidden');
        expect(forwarded()).toEqual([]);

        logger.enable();
        console.log('visible');
        expect(forwarded()).toEqual([['info', 'visible']]);
    });
});

// A second RemoteLogger - React's StrictMode, a hot reload, two modules each setting one up -
// used to patch the console over the first one's patches, so every line went out twice.
describe('RemoteLogger created more than once', () => {
    beforeEach(() => {
        createColibri();
    });

    // The warning about the second one is forwarded like any other line; these tests are about
    // what comes after it.
    const forgetForwarded = () => {
        emit.mockClear();
    };

    it('forwards each line once, however many there are', () => {
        const original = console.log;
        new RemoteLogger();
        new RemoteLogger();
        new RemoteLogger();
        forgetForwarded();

        console.log('once');

        expect(forwarded()).toEqual([['info', 'once']]);
        expect(original).toHaveBeenCalledTimes(1);
    });

    it('warns once, on the second, and not on any after it', () => {
        const originalWarn = console.warn;
        new RemoteLogger();
        expect(originalWarn).not.toHaveBeenCalled();

        new RemoteLogger();
        new RemoteLogger();

        expect(originalWarn).toHaveBeenCalledTimes(1);
        expect(originalWarn).toHaveBeenCalledWith(expect.stringContaining('already forwarded'));
        // And it reaches the server's log, where whoever reads it is looking.
        expect(forwarded()).toEqual([['warn', expect.stringContaining('already forwarded')]]);
    });

    it('leaves the console as the first one patched it', () => {
        new RemoteLogger();
        const patchedLog = console.log;

        new RemoteLogger();

        expect(console.log).toBe(patchedLog);
    });

    it('switches the one forwarding there is from any of them', () => {
        const first = new RemoteLogger();
        const second = new RemoteLogger();
        forgetForwarded();

        second.disable();
        console.log('hidden');
        expect(forwarded()).toEqual([]);

        second.enable();
        first.disable();
        console.log('also hidden');
        expect(forwarded()).toEqual([]);

        first.enable();
        console.log('visible');
        expect(forwarded()).toEqual([['info', 'visible']]);
    });

    // A component that disables its logger on unmount and creates one on mount - which StrictMode
    // does twice - must end up forwarding, as the last constructor asked.
    it('takes the enabled flag of the latest one created', () => {
        const first = new RemoteLogger();
        first.disable();

        new RemoteLogger();
        forgetForwarded();
        console.log('forwarded again');
        expect(forwarded()).toEqual([['info', 'forwarded again']]);

        new RemoteLogger(false);
        console.log('hidden');
        expect(forwarded()).toEqual([['info', 'forwarded again']]);
    });
});

describe('RemoteLogger message stringification', () => {
    beforeEach(() => {
        createColibri();
    });

    const message = () => String(forwarded()[0][1]);

    it('stringifies an Error as its message plus stack', () => {
        new RemoteLogger();
        const err = new Error('boom');
        console.error(err);

        expect(message()).toContain('boom');
        expect(message()).toContain(err.stack);
    });

    it('passes plain strings through unchanged', () => {
        new RemoteLogger();
        console.log('hello world');

        expect(message()).toBe('hello world');
    });

    it('pretty-prints plain objects as indented JSON', () => {
        new RemoteLogger();
        console.log({ a: 1, b: 'two' });

        expect(JSON.parse(message())).toEqual({ a: 1, b: 'two' });
        expect(message()).toContain('\n');
    });

    it('does not throw on circular references', () => {
        new RemoteLogger();

        const obj: { a: number; self?: unknown } = { a: 1 };
        obj.self = obj;

        expect(() => {
            console.log(obj);
        }).not.toThrow();

        expect(() => {
            JSON.parse(message());
        }).not.toThrow();
    });

    // JSON.stringify throws on a BigInt, and that used to come straight out of console.log: an
    // application crashed for logging a value the console itself prints without complaint.
    it('forwards a BigInt instead of throwing out of console.log', () => {
        const original = console.log;
        new RemoteLogger();

        expect(() => {
            console.log({ id: 12345678901234567890n });
        }).not.toThrow();

        expect(original).toHaveBeenCalled();
        expect(JSON.parse(message())).toEqual({ id: '12345678901234567890' });
    });

    it('falls back to String() for a value JSON cannot encode at all', () => {
        new RemoteLogger();
        const unencodable = {
            toJSON() {
                throw new Error('not today');
            },
            toString() {
                return 'the unencodable thing';
            }
        };

        expect(() => {
            console.warn('before', unencodable);
        }).not.toThrow();

        expect(message()).toBe('before,the unencodable thing');
    });

    it('never throws out of console.* even when forwarding fails outright', () => {
        const originalError = console.error;
        new RemoteLogger();
        emit.mockImplementation(() => {
            throw new Error('socket is broken');
        });

        expect(() => {
            console.info('still printed');
        }).not.toThrow();

        expect(originalError).toHaveBeenCalledWith('RemoteLogger: could not forward a log line.', expect.any(Error));
    });
});

describe('RemoteLogger before new Colibri()', () => {
    it('does not overflow the stack on the first line', () => {
        const originalWarn = console.warn;
        new RemoteLogger();

        expect(() => {
            console.log('early');
        }).not.toThrow();
        // Nor does it complain, through the very console it is patching, that Colibri is missing.
        expect(originalWarn).not.toHaveBeenCalled();

        createColibri();
    });

    it('sends what was logged once Colibri is constructed, in order', () => {
        new RemoteLogger();
        console.log('first');
        console.warn('second');
        console.error('third');
        expect(emit).not.toHaveBeenCalled();

        createColibri();

        expect(forwarded()).toEqual([
            ['info', 'first'],
            ['warn', 'second'],
            ['error', 'third']
        ]);
    });

    it('keeps the first 100 lines and says how many more there were', () => {
        new RemoteLogger();
        for (let i = 0; i < 105; i++) console.log(`line ${i}`);

        createColibri();

        const lines = forwarded();
        expect(lines).toHaveLength(101);
        expect(lines[0]).toEqual(['info', 'line 0']);
        expect(lines[99]).toEqual(['info', 'line 99']);
        expect(lines[100][0]).toBe('warn');
        expect(lines[100][1]).toContain('5 more');
    });

    it('does not keep what was logged while disabled', () => {
        new RemoteLogger(false);
        console.log('hidden');

        createColibri();

        expect(forwarded()).toEqual([]);
    });
});

describe('RemoteLogger reentrancy', () => {
    // Anything that logs while a line is being forwarded - the socket, a getter that
    // JSON.stringify runs - must reach the console without being forwarded in turn, or one
    // line becomes an unbounded recursion.
    it('sends a line logged while forwarding to the console only', () => {
        const originalWarn = console.warn;
        createColibri();
        new RemoteLogger();
        emit.mockImplementation(() => {
            console.warn('logged from inside the socket');
        });

        expect(() => {
            console.log('outer');
        }).not.toThrow();

        expect(forwarded()).toEqual([['info', 'outer']]);
        expect(originalWarn).toHaveBeenCalledWith('logged from inside the socket');
    });

    it('sends a line logged while stringifying to the console only', () => {
        const originalLog = console.log;
        createColibri();
        new RemoteLogger();
        const noisy = {
            get value() {
                console.log('logged from a getter');
                return 1;
            }
        };

        console.info(noisy);

        expect(forwarded()).toHaveLength(1);
        expect(JSON.parse(String(forwarded()[0][1]))).toEqual({ value: 1 });
        expect(originalLog).toHaveBeenCalledWith('logged from a getter');
    });
});
