import { describe, it, expect } from 'vitest';
import {
    MAX_PROXY_V1_HEADER_LENGTH,
    MAX_PROXY_V2_DATA_LENGTH,
    ProxyHeaderError,
    readProxyHeader,
} from '../../src/server/modules/tcp/worker/proxy-protocol.js';
import { PROTOCOL_VERSION, encodeHandshakeFrame } from '../../src/server/modules/protocol/protocol.js';

const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const LOCAL = 0x20;
const PROXY = 0x21;
const TCP4 = 0x11;
const TCP6 = 0x21;
const UDP4 = 0x12;
const UNSPEC = 0x00;
const UNIX_STREAM = 0x31;

const v1 = (line: string): Buffer => Buffer.from(`${line}\r\n`, 'latin1');

const v2 = function (versionCommand: number, familyProtocol: number, data: Buffer): Buffer {
    const length = Buffer.alloc(2);
    length.writeUInt16BE(data.length);
    return Buffer.concat([V2_SIGNATURE, Buffer.from([versionCommand, familyProtocol]), length, data]);
};

const ports = (source: number, destination: number): Buffer => {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt16BE(source, 0);
    bytes.writeUInt16BE(destination, 2);
    return bytes;
};
const inet = (source: number[], destination: number[]): Buffer =>
    Buffer.concat([Buffer.from(source), Buffer.from(destination), ports(51234, 9212)]);
const inet6 = (source: string, destination: string): Buffer =>
    Buffer.concat([Buffer.from(source.replace(/:/g, ''), 'hex'), Buffer.from(destination.replace(/:/g, ''), 'hex'), ports(51234, 9212)]);

const handshake = encodeHandshakeFrame(PROTOCOL_VERSION, 'appA', 'quest-1');

describe('readProxyHeader', () => {
    describe('version 1', () => {
        it('reads the client\'s address from TCP4 and TCP6 headers', () => {
            const tcp4 = v1('PROXY TCP4 198.51.100.7 172.20.0.2 51234 9212');
            const tcp6 = v1('PROXY TCP6 2001:db8::7 2001:db8::1 51234 9212');

            expect(readProxyHeader(tcp4)).toEqual({ length: tcp4.length, sourceAddress: '198.51.100.7' });
            expect(readProxyHeader(tcp6)).toEqual({ length: tcp6.length, sourceAddress: '2001:db8::7' });
        });

        it('says how much of what follows is the header', () => {
            const header = v1('PROXY TCP4 198.51.100.7 172.20.0.2 51234 9212');

            expect(readProxyHeader(Buffer.concat([header, handshake]))).toEqual({ length: header.length, sourceAddress: '198.51.100.7' });
        });

        it('names no client for UNKNOWN, up to the longest header there is', () => {
            const longest = v1(`PROXY UNKNOWN ${'ffff:'.repeat(7)}ffff ${'ffff:'.repeat(7)}ffff 65535 65535`);
            expect(longest).toHaveLength(MAX_PROXY_V1_HEADER_LENGTH);

            expect(readProxyHeader(v1('PROXY UNKNOWN'))).toEqual({ length: 15, sourceAddress: undefined });
            expect(readProxyHeader(longest)).toEqual({ length: MAX_PROXY_V1_HEADER_LENGTH, sourceAddress: undefined });
        });

        it('waits for the rest of a header split anywhere', () => {
            const header = v1('PROXY TCP4 198.51.100.7 172.20.0.2 51234 9212');

            for (let length = 1; length < header.length; length++) {
                expect(readProxyHeader(header.subarray(0, length))).toBe('incomplete');
            }
            expect(readProxyHeader(header)).toEqual({ length: header.length, sourceAddress: '198.51.100.7' });
        });

        it.each([
            ['a missing port', 'PROXY TCP4 198.51.100.7 172.20.0.2 51234'],
            ['an extra field', 'PROXY TCP4 198.51.100.7 172.20.0.2 51234 9212 x'],
            ['a double space', 'PROXY TCP4  198.51.100.7 172.20.0.2 51234 9212'],
            ['an IPv6 address in TCP4', 'PROXY TCP4 2001:db8::7 172.20.0.2 51234 9212'],
            ['an IPv4 address in TCP6', 'PROXY TCP6 198.51.100.7 2001:db8::1 51234 9212'],
            ['a host name', 'PROXY TCP4 client.example.org 172.20.0.2 51234 9212'],
            ['a leading zero in an address', 'PROXY TCP4 198.51.100.007 172.20.0.2 51234 9212'],
            ['a port over 65535', 'PROXY TCP4 198.51.100.7 172.20.0.2 65536 9212'],
            ['a port with a leading zero', 'PROXY TCP4 198.51.100.7 172.20.0.2 051234 9212'],
            ['an unknown protocol', 'PROXY UDP4 198.51.100.7 172.20.0.2 51234 9212'],
            ['lower case', 'PROXY tcp4 198.51.100.7 172.20.0.2 51234 9212'],
        ])('refuses a header with %s', (_what, line) => {
            expect(() => readProxyHeader(v1(line))).toThrow(ProxyHeaderError);
        });

        it('refuses a header without a CRLF within 107 bytes, as soon as that is clear', () => {
            const unterminated = Buffer.from(`PROXY UNKNOWN ${'x'.repeat(MAX_PROXY_V1_HEADER_LENGTH)}`, 'latin1');

            expect(readProxyHeader(unterminated.subarray(0, MAX_PROXY_V1_HEADER_LENGTH - 1))).toBe('incomplete');
            expect(() => readProxyHeader(unterminated.subarray(0, MAX_PROXY_V1_HEADER_LENGTH))).toThrow('CRLF within 107 bytes');
            expect(() => readProxyHeader(unterminated)).toThrow(ProxyHeaderError);
            // One byte too long: the CRLF ends at byte 108.
            expect(() => readProxyHeader(v1(`PROXY UNKNOWN ${'x'.repeat(MAX_PROXY_V1_HEADER_LENGTH - 15)}`))).toThrow(ProxyHeaderError);
        });

        it('refuses a header ended by LF alone', () => {
            expect(() => readProxyHeader(Buffer.from(`PROXY TCP4 198.51.100.7 172.20.0.2 51234 9212\n${'x'.repeat(100)}`, 'latin1')))
                .toThrow(ProxyHeaderError);
        });
    });

    describe('version 2', () => {
        it('reads the client\'s address from a PROXY header over TCP and IPv4', () => {
            const header = v2(PROXY, TCP4, inet([198, 51, 100, 7], [172, 20, 0, 2]));

            expect(readProxyHeader(Buffer.concat([header, handshake]))).toEqual({ length: 28, sourceAddress: '198.51.100.7' });
        });

        it('reads the client\'s address from a PROXY header over TCP and IPv6, written as Node.js writes it', () => {
            const ipv6 = v2(PROXY, TCP6, inet6('2001:0db8:0000:0000:0000:0000:0000:0007', '2001:0db8:0000:0000:0000:0000:0000:0001'));
            const mapped = v2(PROXY, TCP6, inet6('0000:0000:0000:0000:0000:ffff:c633:6407', '0000:0000:0000:0000:0000:ffff:ac14:0002'));

            expect(readProxyHeader(ipv6)).toEqual({ length: 52, sourceAddress: '2001:db8::7' });
            expect(readProxyHeader(mapped)).toEqual({ length: 52, sourceAddress: '::ffff:198.51.100.7' });
        });

        it('passes over TLVs after the addresses', () => {
            const tlvs = Buffer.from([0x05, 0x00, 0x04, 0xde, 0xad, 0xbe, 0xef]);
            const header = v2(PROXY, TCP4, Buffer.concat([inet([198, 51, 100, 7], [172, 20, 0, 2]), tlvs]));

            expect(readProxyHeader(Buffer.concat([header, handshake]))).toEqual({ length: 16 + 12 + 7, sourceAddress: '198.51.100.7' });
        });

        it('names no client for LOCAL, or for what is not TCP over IPv4 or IPv6', () => {
            const local = v2(LOCAL, UNSPEC, Buffer.alloc(0));
            const localWithAddresses = v2(LOCAL, TCP4, inet([198, 51, 100, 7], [172, 20, 0, 2]));

            expect(readProxyHeader(local)).toEqual({ length: 16, sourceAddress: undefined });
            expect(readProxyHeader(localWithAddresses)).toEqual({ length: 28, sourceAddress: undefined });
            expect(readProxyHeader(v2(PROXY, UNSPEC, Buffer.alloc(0)))).toEqual({ length: 16, sourceAddress: undefined });
            expect(readProxyHeader(v2(PROXY, UDP4, inet([198, 51, 100, 7], [172, 20, 0, 2])))).toEqual({ length: 28, sourceAddress: undefined });
            expect(readProxyHeader(v2(PROXY, UNIX_STREAM, Buffer.alloc(216)))).toEqual({ length: 232, sourceAddress: undefined });
        });

        it('waits for the rest of a header split anywhere', () => {
            const header = v2(PROXY, TCP4, inet([198, 51, 100, 7], [172, 20, 0, 2]));

            for (let length = 1; length < header.length; length++) {
                expect(readProxyHeader(header.subarray(0, length))).toBe('incomplete');
            }
            expect(readProxyHeader(header)).toEqual({ length: 28, sourceAddress: '198.51.100.7' });
        });

        it('takes up to 4 KiB after the first 16 bytes, and refuses more before waiting for it', () => {
            const largest = v2(PROXY, TCP4, Buffer.concat([inet([198, 51, 100, 7], [172, 20, 0, 2]), Buffer.alloc(MAX_PROXY_V2_DATA_LENGTH - 12)]));
            const tooLarge = v2(PROXY, TCP4, Buffer.concat([inet([198, 51, 100, 7], [172, 20, 0, 2]), Buffer.alloc(MAX_PROXY_V2_DATA_LENGTH - 11)]));

            expect(readProxyHeader(largest)).toEqual({ length: 16 + MAX_PROXY_V2_DATA_LENGTH, sourceAddress: '198.51.100.7' });
            expect(() => readProxyHeader(tooLarge.subarray(0, 16))).toThrow(`${MAX_PROXY_V2_DATA_LENGTH + 1} bytes after the first 16`);
        });

        it.each([
            ['version 1', Buffer.from([0x11, TCP4])],
            ['version 3', Buffer.from([0x31, TCP4])],
            ['command 2', Buffer.from([0x22, TCP4])],
            ['address family 4', Buffer.from([PROXY, 0x41])],
            ['protocol 3', Buffer.from([PROXY, 0x13])],
        ])('refuses %s', (_what, versionAndFamily) => {
            const header = Buffer.concat([V2_SIGNATURE, versionAndFamily, Buffer.from([0, 12]), inet([198, 51, 100, 7], [172, 20, 0, 2])]);

            expect(() => readProxyHeader(header)).toThrow(ProxyHeaderError);
        });

        it('refuses addresses cut short', () => {
            expect(() => readProxyHeader(v2(PROXY, TCP4, Buffer.alloc(11)))).toThrow('too few for the IPv4 addresses');
            expect(() => readProxyHeader(v2(PROXY, TCP6, Buffer.alloc(35)))).toThrow('too few for the IPv6 addresses');
        });
    });

    describe('a connection without a header', () => {
        it.each([
            ['a v3 handshake', handshake],
            ['a TLS ClientHello', Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01])],
            ['a Colibri 1.x handshake', Buffer.from('\0\0\0h\0', 'latin1')],
            ['a P that is not PROXY', Buffer.from('PRIVATE', 'latin1')],
            ['the start of the version 2 signature, then something else', Buffer.from([0x0d, 0x0a, 0x0d, 0x0b])],
        ])('is told apart from one by %s', (_what, bytes) => {
            expect(readProxyHeader(bytes)).toBe('none');
        });

        // A v3 frame starts with its length, u32 LE, at most MAX_FRAME_LENGTH (0x500000).
        it('is told apart from one by the 4th byte of a v3 frame at the latest', () => {
            expect(readProxyHeader(Buffer.from([0x0d, 0x0a, 0x0d]))).toBe('incomplete');
            expect(readProxyHeader(Buffer.from([0x0d, 0x0a, 0x0d, 0x00]))).toBe('none');
            expect(readProxyHeader(Buffer.from('PRO', 'latin1'))).toBe('incomplete');
            expect(readProxyHeader(Buffer.from('PRO\0', 'latin1'))).toBe('none');
        });

        it('is not told apart from one before it has sent anything', () => {
            expect(readProxyHeader(Buffer.alloc(0))).toBe('incomplete');
        });
    });
});
