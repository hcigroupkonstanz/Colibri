import type * as net from 'net';

// How long a socket this server has ended (a refusal, or a framing error) may stay half-open
// waiting for the peer's FIN before it is destroyed. Ending first rather than destroying is what
// lets the refusal frame reach the client; this bounds what a peer that never closes its side
// can hold on to.
export const CLOSE_GRACE_MILLIS = 5000;

// Ended rather than destroyed, so the client sees the connection closed, not reset. Whatever else it
// sends is read and dropped, so that its own close is seen.
export const endRefused = function (socket: net.Socket): void {
    socket.resume();
    socket.end();
    const grace = setTimeout(() => socket.destroy(), CLOSE_GRACE_MILLIS);
    grace.unref();
    socket.once('close', () => clearTimeout(grace));
};
