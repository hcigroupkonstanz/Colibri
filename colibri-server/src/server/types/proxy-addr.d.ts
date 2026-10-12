// proxy-addr ships no types, and @types/proxy-addr would be one more package for the two functions
// used here.
declare module 'proxy-addr' {
    // Whether the peer at `address`, `hop` proxies away from the server, is a trusted proxy.
    type TrustFunction = (address: string, hop: number) => boolean;

    // What proxy-addr reads of a request: its X-Forwarded-For header and the address of its peer.
    interface ForwardedRequest {
        headers: { 'x-forwarded-for'?: string };
        socket: { remoteAddress?: string };
    }

    // The address of the client the request is for: the right-most X-Forwarded-For entry that
    // `trust` does not trust, or the peer's own address if the peer is not trusted.
    function proxyaddr(req: ForwardedRequest, trust: TrustFunction): string;

    namespace proxyaddr {
        // Throws a TypeError for an entry that is neither an IP address, a CIDR range nor one of
        // the named ranges loopback, linklocal and uniquelocal.
        function compile(trust: string | string[]): TrustFunction;
    }

    export = proxyaddr;
}
