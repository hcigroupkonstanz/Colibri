import type { Metadata } from '../core/log-message.js';

// For a line about one client: the admin UI shows its app, and lists the line when it shows only
// that app.
export const aboutClient = function (client: { app: string; name: string; id: string }): Metadata {
    return { clientApp: client.app, clientName: client.name, clientId: client.id };
};
