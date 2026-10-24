import type { ModelQuery } from './topics/model-snapshot.js';
import { parseModelQuery } from './topics/model-snapshot.js';
import type { ModelsQuery } from './topics/models-snapshot.js';
import { parseModelsQuery } from './topics/models-snapshot.js';
import { fieldsOf } from './topics/query-fields.js';

export const ADMIN_TOPICS = ['server', 'clients', 'models', 'model', 'latency'] as const;
export type AdminTopic = typeof ADMIN_TOPICS[number];

// Request only: the latency history is up to MAX_LATENCY_HISTORY_SAMPLES samples, and
// colibri::latency brings the new ones every second.
const REQUEST_ONLY_TOPICS: ReadonlySet<AdminTopic> = new Set([ 'latency' ]);

const isTopic = function (value: unknown): value is AdminTopic {
    return typeof value === 'string' && (ADMIN_TOPICS as readonly string[]).includes(value);
};

// What one page asked for: a topic, with its query for the two that take one.
export type Query =
    | { topic: 'server' | 'clients' | 'latency' }
    | { topic: 'models'; models: ModelsQuery }
    | { topic: 'model'; model: ModelQuery };

const parseQuery = function (topic: AdminTopic, body: unknown): Query {
    switch (topic) {
        case 'models':
            return { topic, models: parseModelsQuery(body) };
        case 'model':
            return { topic, model: parseModelQuery(body) };
        default:
            return { topic };
    }
};

export type AdminMessage =
    // undefined (no topic) drops every subscription, for a page that is going away; null (unknown
    // topic) drops none.
    | { kind: 'unsubscribe'; topic: AdminTopic | undefined | null }
    // The reason goes to the debug log; none for a command the channel does not know.
    | { kind: 'ignore'; reason?: string }
    // key is equal for two pages asking for the same thing. request is the page's request number,
    // null if it is missing or invalid.
    | { kind: 'request' | 'subscribe'; topic: AdminTopic; query: Query; key: string; request: number | null };

/** Turns an admin page's message (`command`, payload `body`) into what it asks for; never throws. */
export const parseAdminMessage = function (command: string, body: unknown): AdminMessage {
    const fields = fieldsOf(body);
    const topic = fields.topic;

    if (command === 'unsubscribe') {
        if (topic === undefined) return { kind: 'unsubscribe', topic: undefined };
        return { kind: 'unsubscribe', topic: isTopic(topic) ? topic : null };
    }
    if (command !== 'request' && command !== 'subscribe') return { kind: 'ignore' };
    if (!isTopic(topic)) return { kind: 'ignore', reason: 'unknown topic' };
    if (command === 'subscribe' && REQUEST_ONLY_TOPICS.has(topic)) return { kind: 'ignore', reason: `'${topic}' is request only` };

    const query = parseQuery(topic, body);
    return {
        kind: command,
        topic,
        query,
        key: JSON.stringify(query),
        request: typeof fields.request === 'number' && Number.isFinite(fields.request) ? fields.request : null,
    };
};
