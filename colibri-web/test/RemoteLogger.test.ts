import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
    type Mock,
} from 'vitest';
import { RemoteLogger } from '../src/RemoteLogger';
import { SendMessage } from '../src/Colibri';

vi.mock('../src/Colibri', () => ({
    SendMessage: vi.fn(),
}));

const sendMessage = SendMessage as unknown as Mock;

type ConsoleMethod = 'debug' | 'log' | 'info' | 'warn' | 'error';
let originalConsole: Record<ConsoleMethod, Console[ConsoleMethod]>;

beforeEach(() => {
    originalConsole = {
        debug: console.debug,
        log: console.log,
        info: console.info,
        warn: console.warn,
        error: console.error,
    };
    sendMessage.mockClear();
});

afterEach(() => {
    console.debug = originalConsole.debug;
    console.log = originalConsole.log;
    console.info = originalConsole.info;
    console.warn = originalConsole.warn;
    console.error = originalConsole.error;
});

describe('RemoteLogger console patching', () => {
    it.each([
        ['debug', 'debug'],
        ['log', 'info'],
        ['info', 'info'],
        ['warn', 'warn'],
        ['error', 'error'],
    ] as const)(
        'console.%s still calls the original and forwards as level "%s"',
        (method, level) => {
            const original = vi.fn();

            (console as any)[method] = original;

            new RemoteLogger();

            (console as any)[method]('hello', 42);

            expect(original).toHaveBeenCalledWith('hello', 42);
            expect(sendMessage).toHaveBeenCalledWith(
                'log',
                level,
                expect.any(String),
            );
        },
    );
});

describe('RemoteLogger enable/disable', () => {
    it('does not forward when constructed with enabled=false', () => {
        new RemoteLogger(false);
        console.log('hidden');
        expect(sendMessage).not.toHaveBeenCalled();
    });

    it('disable() stops forwarding and enable() resumes it', () => {
        const logger = new RemoteLogger();

        logger.disable();
        console.log('hidden');
        expect(sendMessage).not.toHaveBeenCalled();

        logger.enable();
        console.log('visible');
        expect(sendMessage).toHaveBeenCalledWith('log', 'info', 'visible');
    });
});

describe('RemoteLogger message stringification', () => {
    it('stringifies an Error as its message plus stack', () => {
        new RemoteLogger();
        const err = new Error('boom');
        console.error(err);

        const [, , message] = sendMessage.mock.calls[0];
        expect(message).toContain('boom');
        expect(message).toContain(err.stack);
    });

    it('passes plain strings through unchanged', () => {
        new RemoteLogger();
        console.log('hello world');

        const [, , message] = sendMessage.mock.calls[0];
        expect(message).toBe('hello world');
    });

    it('pretty-prints plain objects as indented JSON', () => {
        new RemoteLogger();
        console.log({ a: 1, b: 'two' });

        const [, , message] = sendMessage.mock.calls[0];
        expect(JSON.parse(message)).toEqual({ a: 1, b: 'two' });
        expect(message).toContain('\n');
    });

    it('does not throw on circular references', () => {
        new RemoteLogger();

        const obj: any = { a: 1 };
        obj.self = obj;

        expect(() => console.log(obj)).not.toThrow();

        const [, , message] = sendMessage.mock.calls[0];
        expect(() => JSON.parse(message)).not.toThrow();
    });
});
