// After this many bytes of messages written to a client since its last heartbeat, one more goes ahead
// of the next message, between the ticks' heartbeats.
// A client that sends nothing of its own stays connected by echoing heartbeats, and can echo only
// those it has read. Without these, the tick's next heartbeat queues behind everything written at
// once (the answer to a model::request for a large store, say) and a slow reader exceeds the idle
// timeout. With one per 64 KiB, a reader at 6.4 KiB/s or faster echoes within the default 10 s. A
// single message larger than this still has none inside it; see IdleWatch for those.
export const HEARTBEAT_EVERY_BYTES = 64 * 1024;
