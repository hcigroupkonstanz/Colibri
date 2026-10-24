import type { Colibri } from '../Colibri';

// Channel for the askForEnd requests, the same one colibri-unity uses after a reconnect. It never has models.
export const END_CHANNEL = 'colibri::reconnect';

let endRequests = 0;

// Requests an id nobody has, on a channel without models, and returns it. The server answers one
// client's requests in order, so the bare-id answer marks the end of the answers to earlier requests.
export const askForEnd = (colibri: Colibri) => {
    const id = `colibri-web-${++endRequests}`;
    colibri.sendMessage(END_CHANNEL, 'model::request', { id, again: true });
    return id;
};
