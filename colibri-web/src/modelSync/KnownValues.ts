import type { SyncModel } from '../SyncModel';
import { toJsonOf } from './syncModelMethods';

// History kept per field to spot changes lost in a dead connection (see keepKnown, lostChanges).
// An earlier value counts only if it was still current within KNOWN_VALUES_MS before the outage:
// a change sent before that has arrived for certain.
const KNOWN_VALUES_KEPT = 8;
const KNOWN_VALUES_MS = 10_000;

interface KnownValue {
    json: string;
    at: number;
    sent: boolean; // sent by this client, otherwise shown by the server
}

export class KnownValues<T extends SyncModel<T>> {
    // Per own model and field name (as sent), the values the field had, oldest first: the last one the
    // server showed, then those sent since that keepKnown keeps.
    private readonly knownValues = new WeakMap<T, Map<string, KnownValue[]>>();

    public constructor(private readonly now: () => number) {}

    // Records `fields` as sent by this client if `heardAt` (when it last heard from the server) is given,
    // otherwise as shown by the server, which replaces the history. Undefined fields are not sent at
    // all, so they are skipped.
    public remember(model: T, fields: Partial<T>, heardAt?: number): void {
        let known = this.knownValues.get(model);
        if (!known) this.knownValues.set(model, (known = new Map<string, KnownValue[]>()));
        const at = this.now();
        for (const [key, field] of Object.entries(fields)) {
            const json = JSON.stringify(field) as string | undefined;
            if (key === 'id' || json === undefined) continue;
            const value = { json, at, sent: heardAt !== undefined };
            known.set(
                key,
                heardAt === undefined ? [value] : this.keepKnown([...(known.get(key) ?? []), value], heardAt)
            );
        }
    }

    // Fields of an own model that an update in the reconnect round shows with a value from before this
    // client's last change: that change never reached the server (Socket.IO loses what is sent into a
    // dead connection until its ping timeout). Applied, the update would revert it on this client only,
    // so the value is kept and sent again. Any other value is applied: one the field never had is another
    // client's, and so is one shown again after this client's last change. The outage counts from
    // lastHeardBeforeOutage, since Socket.IO notices it late.
    public lostChanges(model: T, modelData: Partial<T>, held: string[], lastHeardBeforeOutage: number): string[] {
        const known = this.knownValues.get(model);
        if (!known) return [];
        const since = lastHeardBeforeOutage - KNOWN_VALUES_MS;
        const heldKeys = new Set(held.length > 0 ? Object.keys(toJsonOf(model, held)) : []);
        const current = toJsonOf(model) as Record<string, unknown>;
        return Object.entries(modelData)
            .filter(([key, value]) => {
                const values = known.get(key) ?? [];
                const last = values.at(-1);
                if (!last?.sent || heldKeys.has(key) || !(key in current)) return false;
                const json = JSON.stringify(value) as string | undefined;
                const earlier = values.filter((_, i) => i + 1 < values.length && values[i + 1].at >= since);
                return (
                    json !== last.json &&
                    earlier.some(v => v.json === json) &&
                    // Nothing to send when this client has what the server has anyway.
                    JSON.stringify(current[key]) !== json
                );
            })
            .map(([key]) => key);
    }

    // Trims a field's values (oldest first) to the latest KNOWN_VALUES_KEPT up to `heardAt`, the first
    // KNOWN_VALUES_KEPT after it, and the newest. The server's latency ping comes every 100 ms, so the
    // connection died about when `heardAt` was: the last value that reached the server was sent around
    // then, and later ones went into the dead link, where only the newest counts.
    private keepKnown(values: KnownValue[], heardAt: number): KnownValue[] {
        const split = values.findIndex(v => v.at > heardAt);
        if (split < 0) return values.slice(-KNOWN_VALUES_KEPT);
        const after = values.slice(split);
        const newest = after.slice(KNOWN_VALUES_KEPT).slice(-1);
        return [...values.slice(0, split).slice(-KNOWN_VALUES_KEPT), ...after.slice(0, KNOWN_VALUES_KEPT), ...newest];
    }
}
