// After this many bytes of messages written to a client since its last heartbeat, it is sent one
// more ahead of the next message, between the ticks' heartbeats.
//
// A client that sends nothing of its own is kept connected by echoing heartbeats, and it can echo
// only those it has read. Everything written at once, the answer to a model::request for a large
// store say, used to have no heartbeat in it: the tick's next one queued behind all of it. On a
// slow link such a client, reading all along, went quiet for longer than the idle timeout and was
// disconnected, and asked for the whole store again when it reconnected. With a heartbeat every
// 64 KiB it echoes one at least every 10 s down to about 6.4 KiB/s. A single message larger than
// this still has none inside it; see DEFAULT_IDLE_TIMEOUT_MILLIS for those.
export const HEARTBEAT_EVERY_BYTES = 64 * 1024;
