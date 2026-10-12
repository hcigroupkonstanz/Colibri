import type { Colibri } from './Colibri';

/*
 *  Hooks into the life of a Colibri instance, for the rest of the library.
 *
 *  Internal, and deliberately not exported from index.ts. RegisterModelSync and RemoteLogger
 *  can be called before `new Colibri()`, and this is how they find out when it happens - and how
 *  RegisterModelSync finds out about a disconnect, after which it holds its own models' changes
 *  back, and a reconnect, after which it has catching up to do. It also asks when an instance last
 *  heard from the server, which tells it when a connection that died without closing stopped
 *  working.
 *
 *  Only a type is imported from Colibri, so the two modules do not depend on each other at
 *  runtime. That is also why nothing here checks whether an instance already exists: callers
 *  ask Colibri.getInstance(false) first and only queue when there is none.
 */

type InstanceAction = (colibri: Colibri) => void;

const awaitingInstance: InstanceAction[] = [];

/**
 * Queues `action` to run with the instance as soon as `new Colibri()` has constructed one.
 * Returns a function that unqueues it again.
 */
export const whenColibriCreated = (action: InstanceAction): (() => void) => {
    awaitingInstance.push(action);
    return () => {
        const index = awaitingInstance.indexOf(action);
        if (index >= 0) awaitingInstance.splice(index, 1);
    };
};

/** Runs, in order, everything {@link whenColibriCreated} queued. Called by the Colibri constructor. */
export const colibriCreated = (colibri: Colibri): void => {
    for (const action of awaitingInstance.splice(0)) {
        // One failing action must not take the others down with it, nor turn into an exception
        // out of `new Colibri()` that has nothing to do with the arguments it was given.
        try {
            action(colibri);
        } catch (error) {
            console.error('Colibri: a registration made before new Colibri() failed to attach.', error);
        }
    }
};

// Per instance, not global: an action is bound to the connection it catches up, and a WeakMap
// lets both go once the instance does.
const reconnectActions = new WeakMap<Colibri, InstanceAction[]>();
const disconnectActions = new WeakMap<Colibri, InstanceAction[]>();

const addAction = (actions: WeakMap<Colibri, InstanceAction[]>, colibri: Colibri, action: InstanceAction) => {
    const forInstance = actions.get(colibri);
    if (forInstance) forInstance.push(action);
    else actions.set(colibri, [action]);
};

const runActions = (actions: WeakMap<Colibri, InstanceAction[]>, colibri: Colibri, failure: string) => {
    for (const action of actions.get(colibri) ?? []) {
        try {
            action(colibri);
        } catch (error) {
            console.error(failure, error);
        }
    }
};

/**
 * Runs `action` every time `colibri` reconnects: on each connect after its first, which is when
 * whatever the server relayed in the meantime has been missed.
 */
export const onColibriReconnected = (colibri: Colibri, action: InstanceAction): void => {
    addAction(reconnectActions, colibri, action);
};

/** Runs, in order, everything {@link onColibriReconnected} registered for `colibri`. Called by Colibri. */
export const colibriReconnected = (colibri: Colibri): void => {
    runActions(reconnectActions, colibri, 'Colibri: catching up after a reconnect failed.');
};

/**
 * Runs `action` every time `colibri` loses its connection. Until the next connect, whatever is sent
 * waits in Socket.IO's buffer, which sends it on that connect ahead of anything a catch-up sends.
 */
export const onColibriDisconnected = (colibri: Colibri, action: InstanceAction): void => {
    addAction(disconnectActions, colibri, action);
};

/** Runs, in order, everything {@link onColibriDisconnected} registered for `colibri`. Called by Colibri. */
export const colibriDisconnected = (colibri: Colibri): void => {
    runActions(disconnectActions, colibri, 'Colibri: handling a disconnect failed.');
};

const lastHeard = new WeakMap<Colibri, number>();

/** Notes that `colibri` has just received something from the server. Called by Colibri. */
export const colibriHeardFrom = (colibri: Colibri): void => {
    lastHeard.set(colibri, Date.now());
};

/**
 * When `colibri` last received anything from the server (as `Date.now()`), or undefined if it never
 * has. While the connection works that is never much more than 100 ms ago, since the server's
 * latency probe comes that often: Socket.IO itself may take most of a minute to notice that a
 * connection died without closing, and this is when it actually stopped working.
 */
export const lastHeardFrom = (colibri: Colibri): number | undefined => lastHeard.get(colibri);
