import { describe, it, expect } from 'vitest';
import { ADMIN_TOPICS, parseAdminMessage } from '../../src/server/modules/admin/admin-message.js';
import { parseModelQuery } from '../../src/server/modules/admin/topics/model-snapshot.js';
import { DEFAULT_MODELS_LIMIT, parseModelsQuery } from '../../src/server/modules/admin/topics/models-snapshot.js';

describe('parseAdminMessage', () => {
    describe('unsubscribe', () => {
        it('names the topic it is from', () => {
            for (const topic of ADMIN_TOPICS) {
                expect(parseAdminMessage('unsubscribe', { topic })).toStrictEqual({ kind: 'unsubscribe', topic });
            }
        });

        it('is from every topic without one, whatever else the payload is', () => {
            for (const body of [ {}, { request: 1 }, undefined, null, [ 'server' ], 'server', 7 ]) {
                expect(parseAdminMessage('unsubscribe', body)).toStrictEqual({ kind: 'unsubscribe', topic: undefined });
            }
        });

        it('is from no topic with an unknown one', () => {
            for (const topic of [ 'nope', 'Server', '', 1, null, [ 'server' ], { topic: 'server' } ]) {
                expect(parseAdminMessage('unsubscribe', { topic })).toStrictEqual({ kind: 'unsubscribe', topic: null });
            }
        });
    });

    describe('ignore', () => {
        it('gives no reason for a command the channel does not know', () => {
            for (const command of [ 'delete', 'Request', 'SUBSCRIBE', '', 'server' ]) {
                expect(parseAdminMessage(command, { topic: 'server' })).toStrictEqual({ kind: 'ignore' });
            }
        });

        it('gives the reason for a request or subscribe without a known topic', () => {
            for (const command of [ 'request', 'subscribe' ]) {
                for (const body of [ {}, { topic: 'nope' }, { topic: 1 }, undefined, [ 'server' ] ]) {
                    expect(parseAdminMessage(command, body)).toStrictEqual({ kind: 'ignore', reason: 'unknown topic' });
                }
            }
        });

        it('gives the reason for a subscribe to a request-only topic', () => {
            expect(parseAdminMessage('subscribe', { topic: 'latency', request: 1 }))
                .toStrictEqual({ kind: 'ignore', reason: '\'latency\' is request only' });
        });
    });

    describe('request and subscribe', () => {
        it('takes every topic as a request, and every one but latency as a subscribe', () => {
            for (const topic of ADMIN_TOPICS) {
                expect(parseAdminMessage('request', { topic })).toMatchObject({ kind: 'request', topic });
                expect(parseAdminMessage('subscribe', { topic })).toMatchObject({ kind: topic === 'latency' ? 'ignore' : 'subscribe' });
            }
        });

        it('carries the query of the topic and its JSON as the key', () => {
            const server = parseAdminMessage('subscribe', { topic: 'server', filter: 'x' });
            expect(server).toStrictEqual({
                kind: 'subscribe', topic: 'server', query: { topic: 'server' }, key: '{"topic":"server"}', request: null,
            });

            const modelsBody = { topic: 'models', app: 'a', channel: 'c', filter: 'f', offset: 4, limit: 7, request: 3 };
            const models = parseAdminMessage('request', modelsBody);
            const modelsQuery = { topic: 'models', models: parseModelsQuery(modelsBody) };
            expect(models).toStrictEqual({ kind: 'request', topic: 'models', query: modelsQuery, key: JSON.stringify(modelsQuery), request: 3 });

            const modelBody = { topic: 'model', app: 'a', channel: 'c', id: 'm1' };
            const model = parseAdminMessage('subscribe', modelBody);
            const modelQuery = { topic: 'model', model: parseModelQuery(modelBody) };
            expect(model).toStrictEqual({ kind: 'subscribe', topic: 'model', query: modelQuery, key: JSON.stringify(modelQuery), request: null });
        });

        it('gives two pages asking for the same thing the same key', () => {
            const first = parseAdminMessage('subscribe', { topic: 'models', app: 'a', request: 1 });
            const second = parseAdminMessage('request', { topic: 'models', app: 'a', limit: DEFAULT_MODELS_LIMIT, other: true, request: 9 });
            const third = parseAdminMessage('request', { topic: 'models', app: 'b' });

            expect(first).toMatchObject({ key: (second as { key: string }).key });
            expect(third).not.toMatchObject({ key: (first as { key: string }).key });
        });

        it('takes a request number only if it is a finite number', () => {
            const request = (value: unknown) => parseAdminMessage('request', { topic: 'clients', request: value });

            expect(request(0)).toMatchObject({ request: 0 });
            expect(request(-2.5)).toMatchObject({ request: -2.5 });
            for (const value of [ undefined, null, '1', [ 1 ], NaN, Infinity, -Infinity ]) {
                expect(request(value)).toMatchObject({ request: null });
            }
        });
    });
});
