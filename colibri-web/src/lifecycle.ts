import type { Colibri } from './Colibri';

/*
 *  Internal, not exported from index.ts. Lets RegisterModelSync and RemoteLogger, which can run
 *  before `new Colibri()`, hook into an instance's life.
 *
 *  Only a type is imported from Colibri, so the modules do not depend on each other at runtime.
 *  Callers check Colibri.getInstance(false) first and only queue when there is none.
 */

type InstanceAction = (colibri: Colibri) => void;

const awaitingInstance: InstanceAction[] = [];

/** Runs `action` with the instance once `new Colibri()` has constructed it. Returns a function that unqueues it. */
export const whenColibriCreated = (action: InstanceAction): (() => void) => {
    awaitingInstance.push(action);
    return () => {
        const index = awaitingInstance.indexOf(action);
        if (index >= 0) awaitingInstance.splice(index, 1);
    };
};

/** Runs everything {@link whenColibriCreated} queued, in order. Called by the Colibri constructor. */
export const colibriCreated = (colibri: Colibri): void => {
    for (const action of awaitingInstance.splice(0)) {
        // A throwing action must neither stop the others nor escape from `new Colibri()`.
        try {
            action(colibri);
        } catch (error) {
            console.error('Colibri: a registration made before new Colibri() failed to attach.', error);
        }
    }
};

// Per instance: an action is bound to its connection, and a WeakMap lets both go with the instance.
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

/** Runs `action` on each connect of `colibri` after its first, when what the server relayed in between has been missed. */
export const onColibriReconnected = (colibri: Colibri, action: InstanceAction): void => {
    addAction(reconnectActions, colibri, action);
};

/** Runs everything {@link onColibriReconnected} registered for `colibri`, in order. Called by Colibri. */
export const colibriReconnected = (colibri: Colibri): void => {
    runActions(reconnectActions, colibri, 'Colibri: catching up after a reconnect failed.');
};

/**
 * Runs `action` whenever `colibri` loses its connection. Until the next connect, sends wait in
 * Socket.IO's buffer and go out ahead of anything a catch-up sends.
 */
export const onColibriDisconnected = (colibri: Colibri, action: InstanceAction): void => {
    addAction(disconnectActions, colibri, action);
};

/** Runs everything {@link onColibriDisconnected} registered for `colibri`, in order. Called by Colibri. */
export const colibriDisconnected = (colibri: Colibri): void => {
    runActions(disconnectActions, colibri, 'Colibri: handling a disconnect failed.');
};

const lastHeard = new WeakMap<Colibri, number>();

/** Notes that `colibri` just received something from the server. Called by Colibri. */
export const colibriHeardFrom = (colibri: Colibri): void => {
    lastHeard.set(colibri, Date.now());
};

/**
 * When `colibri` last received anything from the server (`Date.now()`), or undefined if never.
 * The server's 100 ms latency ping keeps this fresh on a working connection, so after an outage it
 * is when the connection actually died; Socket.IO notices a connection that died without closing much later.
 */
export const lastHeardFrom = (colibri: Colibri): number | undefined => lastHeard.get(colibri);
