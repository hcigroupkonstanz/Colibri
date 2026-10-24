import { hasEmptyJsonBody, hasRestMediaType } from '../http/web-server.js';
import { REST_MEDIA_TYPE } from '../protocol/protocol.js';
import type { StoreDatabase } from './store-database.js';
import type { StoreQuota } from './store-quota.js';
import type { RequestHandler } from 'express';
import { Router } from 'express';

// What the store routes need from the RestAPI that owns them. The store is opened in init(), so it
// is asked for at every request. logWarning keeps the RestAPI as the lines' origin.
interface StoreRouterCallbacks {
    store(): StoreDatabase;
    now(): number;
    logWarning(msg: string): void;
}

interface AppParams {
    app: string;
}

interface ValueParams {
    app: string;
    value: string;
}

const listApps = function (callbacks: StoreRouterCallbacks): RequestHandler {
    return (req, res) => {
        // Return all available apps
        res.status(200).json(callbacks.store().apps());
    };
};

const listNames = function (callbacks: StoreRouterCallbacks): RequestHandler<AppParams> {
    return (req, res) => {
        // If app not exist return an error
        if (!callbacks.store().hasApp(req.params.app)) {
            res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
        } else {
            // Return all available values of the app
            res.status(200).json(callbacks.store().names(req.params.app));
        }
    };
};

const getValue = function (callbacks: StoreRouterCallbacks): RequestHandler<ValueParams> {
    return (req, res) => {
        // If app not exist return an error
        if (!callbacks.store().hasApp(req.params.app)) {
            res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
        } else {
            const json = callbacks.store().get(req.params.app, req.params.value);
            // If value not exist return an error
            if (json === undefined) {
                res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
            } else {
                // Return data of value
                res.status(200).json(JSON.parse(json));
            }
        }
    };
};

const putValue = function (quota: StoreQuota, callbacks: StoreRouterCallbacks): RequestHandler<ValueParams, unknown, unknown> {
    return (req, res) => {
        // Only a body in the store's media type is parsed. application/json, form data and a body
        // without a Content-Type are refused rather than stored as whatever they parse to.
        if (!hasRestMediaType(req)) {
            const error = `Value with name ${req.params.value} not saved: send the value as JSON, with Content-Type: ${REST_MEDIA_TYPE}`;
            callbacks.logWarning(`PUT /api/store/${req.params.app}/${req.params.value} answered 415: ${error}`);
            res.status(415).json({ error });
            return;
        }
        // express.json() leaves req.body undefined for no body at all and makes {} of an empty JSON
        // body. Both clients always send a JSON body. An empty body is told from `{}` by its raw
        // length, as a chunked request has no Content-Length.
        if (req.body === undefined || hasEmptyJsonBody(req)) {
            const error = `Value with name ${req.params.value} not saved: send the value as a JSON body`;
            callbacks.logWarning(`PUT /api/store/${req.params.app}/${req.params.value} answered 400: ${error}`);
            res.status(400).json({ error });
            return;
        }

        const json = JSON.stringify(req.body);
        if (quota.wouldExceedMaxBytes(req.params.app, req.params.value, json)) {
            const error = `Value with name ${req.params.value} not saved: the data store is full `
                + `(STORE_MAX_MB ${quota.maxBytes / (1024 * 1024)})`;
            quota.warnFull(error);
            res.status(507).json({ error });
            return;
        }

        const created = callbacks.store().put(req.params.app, req.params.value, json, callbacks.now()) === 'created';
        // Return successful result with the sended data
        res.status(created ? 201 : 200).json({ result: 'Value with name ' + req.params.value + ' saved successfully', data: req.body });
    };
};

const deleteApp = function (callbacks: StoreRouterCallbacks): RequestHandler<AppParams> {
    return (req, res) => {
        // If app not exist return an error
        if (!callbacks.store().hasApp(req.params.app)) {
            res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
        } else {
            // Delete the app
            callbacks.store().deleteApp(req.params.app);
            // Return successful result
            res.status(200).json({ result: 'App with name ' + req.params.app + ' deleted successfully' });
        }
    };
};

const deleteValue = function (callbacks: StoreRouterCallbacks): RequestHandler<ValueParams> {
    return (req, res) => {
        // If app not exist return an error
        if (!callbacks.store().hasApp(req.params.app)) {
            res.status(404).json({ error: 'App with name ' + req.params.app + ' not found' });
        } else if (!callbacks.store().delete(req.params.app, req.params.value)) {
            // If value not exist return an error
            res.status(404).json({ error: 'Value with name ' + req.params.value + ' not found' });
        } else {
            // Return successful result
            res.status(200).json({ result: 'Value with name ' + req.params.value + ' deleted successfully' });
        }
    };
};

// The RestAPI's routes under /api/store: list, read, write and delete the values of each app.
export const storeRouter = function (quota: StoreQuota, callbacks: StoreRouterCallbacks): Router {
    return Router()
        .get('/', listApps(callbacks))
        .get('/:app', listNames(callbacks))
        .get('/:app/:value', getValue(callbacks))
        .put('/:app/:value', putValue(quota, callbacks))
        .delete('/:app', deleteApp(callbacks))
        .delete('/:app/:value', deleteValue(callbacks));
};
