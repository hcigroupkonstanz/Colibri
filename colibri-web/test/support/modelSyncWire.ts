import type { Observable } from 'rxjs';
import { expect } from 'vitest';
import type { FakeSocket } from './fakeSocket';

// Mirrors socket.io: a message reaches every handler registered for its channel.
export const deliver = (socket: FakeSocket, channel: string, msg: { command: string; payload?: unknown }) => {
    for (const [event, handler] of [...socket.on.mock.calls, ...socket.once.mock.calls]) {
        if (event === channel) handler({ channel, ...msg });
    }
};

// The server's answer to the requests RegisterModelSync sent on 'colibri::reconnect' to mark the end
// of the answers before them: to all that are unanswered, or to the first `count`.
export const endOfAnswers = (socket: FakeSocket, count = Infinity) => {
    for (const id of socket.endMarkers.splice(0, count)) {
        deliver(socket, 'colibri::reconnect', { command: 'model::update', payload: { id } });
    }
};

// The id of such a request, which is new every time.
export const endId: unknown = expect.any(String);

// One of those requests, as [command, payload].
export const endRequest = ['model::request', { id: endId, again: true }];

// Asking for every model, as [command, payload]: the request, and one of those after it.
export const everything = [['model::request', {}], endRequest];

export const latest = <T>(models$: Observable<T[]>): T[] => {
    let current: T[] = [];
    models$.subscribe(m => (current = m)).unsubscribe();
    return current;
};

// RegisterModelSync asks for every model on the next task, once the models registered in the same
// block of code have been asked for.
export const nextTask = () => new Promise(resolve => setTimeout(resolve, 0));
