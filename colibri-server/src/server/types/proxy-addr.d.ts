// proxy-addr ships no types. This declares the two functions used here, not @types/proxy-addr.
declare module 'proxy-addr' {
    /**
     * Whether `address` is a trusted proxy. `hop` is 0 for the socket peer and counts up through
     * X-Forwarded-For from the right.
     */
    type TrustFunction = (address: string, hop: number) => boolean;

    interface ForwardedRequest {
        headers: { 'x-forwarded-for'?: string };
        socket: { remoteAddress?: string };
    }

    /**
     * The client address: the right-most X-Forwarded-For entry that `trust` does not trust, or the
     * peer's own address if the peer is not trusted. If all are trusted, the left-most address.
     */
    function proxyaddr(req: ForwardedRequest, trust: TrustFunction): string;

    namespace proxyaddr {
        /**
         * Builds a trust function from IP addresses, CIDR ranges or the named ranges loopback,
         * linklocal and uniquelocal. Throws a TypeError on the first entry that is none of these.
         */
        function compile(trust: string | string[]): TrustFunction;
    }

    export = proxyaddr;
}
