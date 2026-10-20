import * as net from 'net';

// PROXY protocol: a proxy sends a header naming the real client ahead of everything else on each
// connection it opens. v1 is a text line (nginx `proxy_protocol on;` in a stream server), v2 is
// binary (HAProxy, cloud load balancers).
// https://github.com/haproxy/haproxy/blob/master/doc/proxy-protocol.txt
//
// Neither can be mistaken for the start of a connection without a header: read as a frame length,
// the first 4 bytes of either exceed MAX_FRAME_LENGTH; TLS starts with 0x16, Colibri 1.x with a NUL byte.

// "PROXY ", then TCP4, TCP6 or UNKNOWN, then up to the CRLF.
const V1_SIGNATURE = Buffer.from('PROXY ', 'latin1');
const CRLF = Buffer.from('\r\n', 'latin1');

// Longest v1 header per the spec, CRLF included: "PROXY UNKNOWN" with two maximum-length IPv6 addresses and ports.
export const MAX_PROXY_V1_HEADER_LENGTH = 107;

const V2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
// Signature, version and command, address family and protocol, length of the rest.
const V2_FIXED_LENGTH = 16;
const V2_VERSION = 2;
const V2_LOCAL = 0x0;
const V2_PROXY = 0x1;
const V2_AF_INET = 0x1;
const V2_AF_INET6 = 0x2;
const V2_AF_UNIX = 0x3;
const V2_STREAM = 0x1;
const V2_DGRAM = 0x2;
// Source and destination address, then source and destination port.
const V2_INET_ADDRESS_LENGTH = 4 + 4 + 2 + 2;
const V2_INET6_ADDRESS_LENGTH = 16 + 16 + 2 + 2;

// Limit for what follows the fixed 16 bytes: addresses plus TLVs (extras such as TLS details or a
// connection id). The format allows 64 KiB; this caps how much a peer can make the server buffer
// while it waits for the header.
export const MAX_PROXY_V2_DATA_LENGTH = 4096;

const DECIMAL_PORT = /^(0|[1-9][0-9]{0,4})$/;

// Malformed header; the message says how.
export class ProxyHeaderError extends Error {}

export interface ProxyHeader {
    // Bytes the header takes at the start of the connection.
    length: number;
    // Undefined for a connection the proxy opened itself (v1 UNKNOWN, v2 LOCAL, e.g. health checks)
    // and for anything but TCP over IPv4 or IPv6; the socket's remote address applies then.
    sourceAddress: string | undefined;
}

// Whether one of the two is a prefix of the other.
const startsLike = function (bytes: Buffer, signature: Buffer): boolean {
    const length = Math.min(bytes.length, signature.length);
    return bytes.subarray(0, length).equals(signature.subarray(0, length));
};

const isPort = (field: string | undefined): boolean => field !== undefined && DECIMAL_PORT.test(field) && Number(field) <= 65535;

const readV1 = function (bytes: Buffer): ProxyHeader | 'incomplete' {
    const end = bytes.subarray(0, MAX_PROXY_V1_HEADER_LENGTH).indexOf(CRLF);
    if (end === -1) {
        if (bytes.length < MAX_PROXY_V1_HEADER_LENGTH) return 'incomplete';
        throw new ProxyHeaderError(`a version 1 header has to end with CRLF within ${MAX_PROXY_V1_HEADER_LENGTH} bytes`);
    }

    const length = end + CRLF.length;
    const line = bytes.toString('latin1', 0, end);
    const fields = line.split(' ');
    const protocol = fields[1];
    if (protocol === 'UNKNOWN') return { length, sourceAddress: undefined };
    if (protocol !== 'TCP4' && protocol !== 'TCP6') {
        throw new ProxyHeaderError(`unknown protocol in version 1 header ${JSON.stringify(line)}`);
    }

    const [, , source, destination, sourcePort, destinationPort] = fields;
    const isAddress = protocol === 'TCP4' ? net.isIPv4 : net.isIPv6;
    if (fields.length !== 6 || !isAddress(source ?? '') || !isAddress(destination ?? '') || !isPort(sourcePort) || !isPort(destinationPort)) {
        throw new ProxyHeaderError(`malformed version 1 header ${JSON.stringify(line)}`);
    }
    return { length, sourceAddress: source };
};

const formatIPv6 = function (bytes: Buffer): string {
    const groups: string[] = [];
    for (let offset = 0; offset < 16; offset += 2) groups.push(bytes.readUInt16BE(offset).toString(16));
    // Canonical form, as in socket.remoteAddress (::1, ::ffff:192.0.2.1).
    return new net.SocketAddress({ address: groups.join(':'), family: 'ipv6' }).address;
};

const readV2 = function (bytes: Buffer): ProxyHeader | 'incomplete' {
    if (bytes.length < V2_FIXED_LENGTH) return 'incomplete';

    const version = bytes[12]! >> 4;
    const command = bytes[12]! & 0x0f;
    const family = bytes[13]! >> 4;
    const transport = bytes[13]! & 0x0f;
    const dataLength = bytes.readUInt16BE(14);
    if (version !== V2_VERSION) {
        throw new ProxyHeaderError(`a version 2 signature with version ${version}`);
    }
    if (command !== V2_LOCAL && command !== V2_PROXY) {
        throw new ProxyHeaderError(`unknown command ${command} in version 2 header`);
    }
    if (family > V2_AF_UNIX || transport > V2_DGRAM) {
        throw new ProxyHeaderError(`unknown address family or protocol 0x${bytes[13]!.toString(16).padStart(2, '0')} in version 2 header`);
    }
    if (dataLength > MAX_PROXY_V2_DATA_LENGTH) {
        throw new ProxyHeaderError(`a version 2 header of ${dataLength} bytes after the first 16, more than the ${MAX_PROXY_V2_DATA_LENGTH} accepted`);
    }

    const length = V2_FIXED_LENGTH + dataLength;
    if (bytes.length < length) return 'incomplete';
    if (command === V2_LOCAL || transport !== V2_STREAM) return { length, sourceAddress: undefined };

    const data = bytes.subarray(V2_FIXED_LENGTH, length);
    if (family === V2_AF_INET || family === V2_AF_INET6) {
        const ipv4 = family === V2_AF_INET;
        if (dataLength < (ipv4 ? V2_INET_ADDRESS_LENGTH : V2_INET6_ADDRESS_LENGTH)) {
            throw new ProxyHeaderError(`${dataLength} bytes are too few for the ${ipv4 ? 'IPv4' : 'IPv6'} addresses of a version 2 header`);
        }
        return { length, sourceAddress: ipv4 ? Array.from(data.subarray(0, 4)).join('.') : formatIPv6(data.subarray(0, 16)) };
    }
    // AF_UNSPEC or AF_UNIX: no client IP.
    return { length, sourceAddress: undefined };
};

// Parses the header at the start of a connection from the bytes received so far. 'incomplete' while
// it is undecided, 'none' once the bytes cannot be a PROXY header. Throws ProxyHeaderError if the
// header is malformed or longer than accepted.
export const readProxyHeader = function (bytes: Buffer): ProxyHeader | 'incomplete' | 'none' {
    if (bytes.length === 0) return 'incomplete';
    if (startsLike(bytes, V1_SIGNATURE)) return bytes.length < V1_SIGNATURE.length ? 'incomplete' : readV1(bytes);
    if (startsLike(bytes, V2_SIGNATURE)) return bytes.length < V2_SIGNATURE.length ? 'incomplete' : readV2(bytes);
    return 'none';
};
