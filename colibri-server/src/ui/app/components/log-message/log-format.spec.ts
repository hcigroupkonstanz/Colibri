import { LogMessage } from '../../services';
import { appColor, highlight, isAddress, matchesSearch, messageText, sourceOf } from './log-format';

const message = (overrides: Partial<LogMessage>): LogMessage => ({
    id: '1',
    origin: 'ClientLogger',
    level: 2,
    message: 'm',
    group: 'hook',
    created: 1000,
    first: 1000,
    count: 0,
    metadata: {},
    ...overrides
});

describe('log-format', () => {
    it('takes the client\'s name off the front of its line, as the page shows it in a column', () => {
        expect(messageText(message({ message: '[127.0.0.1] Scene loaded', metadata: { clientName: '127.0.0.1' } }))).toBe('Scene loaded');
        expect(messageText(message({ message: '[other] Scene loaded', metadata: { clientName: '127.0.0.1' } }))).toBe('[other] Scene loaded');
        expect(messageText(message({ message: '[127.0.0.1] Scene loaded' }))).toBe('[127.0.0.1] Scene loaded');
    });

    it('names the app and client of a client\'s line, and the server part of every line', () => {
        expect(sourceOf(message({ metadata: { clientApp: 'demo', clientName: 'Quest', clientId: 'x' } })))
            .toEqual({ app: 'demo', client: 'Quest', server: 'hook/ClientLogger' });
        expect(sourceOf(message({ group: 'networking', origin: 'SocketIO' })))
            .toEqual({ app: undefined, client: undefined, server: 'networking/SocketIO' });
        // what ClientLogger writes for a client without an app
        expect(sourceOf(message({ metadata: { clientApp: 'UNKNOWN', clientName: 'UNKNOWN' } })).app).toBeUndefined();
    });

    it('tells a web client\'s name, its address, from a name an app chose', () => {
        expect([ '127.0.0.1', '172.20.0.1', '::1', '::ffff:10.0.0.5' ].every(isAddress)).toBe(true);
        expect([ 'Quest', 'ud-0', 'deadbeef', '1.2.3', 'cafe:Tablet' ].some(isAddress)).toBe(false);
    });

    it('gives an app the same colour every time', () => {
        expect(appColor('vr-sorting-study')).toBe(appColor('vr-sorting-study'));
        expect(appColor('load-app-0')).not.toBe(appColor('load-app-1'));
    });

    it('finds the lower-case search text in the message or the source', () => {
        const line = message({ message: '[Quest] Failed to load Asset', metadata: { clientApp: 'demo-app', clientName: 'Quest' } });
        expect(matchesSearch(line, 'asset')).toBe(true);
        expect(matchesSearch(line, 'demo-app')).toBe(true);
        expect(matchesSearch(line, 'clientlogger')).toBe(true);
        expect(matchesSearch(line, 'scene')).toBe(false);
        expect(matchesSearch(message({ metadata: { clientId: 'AysXA7fAe' } }), 'aysxa7')).toBe(true);
        expect(matchesSearch(message({ reconnect: true }), '')).toBe(false);
    });

    it('splits a text around every match of the search text, whatever its case', () => {
        expect(highlight('Error: error', 'error')).toEqual([
            { text: 'Error', match: true },
            { text: ': ', match: false },
            { text: 'error', match: true }
        ]);
        expect(highlight('no match', 'x')).toEqual([ { text: 'no match', match: false } ]);
        expect(highlight('text', '')).toEqual([ { text: 'text', match: false } ]);
    });
});
