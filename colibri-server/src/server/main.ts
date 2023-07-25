/* eslint-disable @typescript-eslint/no-unused-vars */

import * as _ from 'lodash';
import * as colibri from './modules';
import { Config } from './configuration';

// Better TypeScript error messages
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('source-map-support').install();

/**
 * Debugging
 */

// Unlimited stacktrace depth (due to RxJS)
Error.stackTraceLimit = Infinity;

// Print console errors in GUI
// const redirectConsole = new colibri.RedirectConsole();
const dataStore = new colibri.DataStore();


/**
 *    Servers
 */
const webServer = new colibri.WebServer(Config.WEBSERVER_PORT, Config.WEBSERVER_ROOT);
const voiceServer = new colibri.VoiceServer(Config.DATA_ROOT);

const unityServer = new colibri.UnityServerProxy();
const socketioServer = new colibri.SocketIOServer();
const connectionPool = new colibri.ConnectionPool(unityServer, socketioServer);


/**
 *    APIs
 */
const restApi = new colibri.RestAPI(Config.DATA_ROOT, webServer);

/**
 *    Plumbing
 */
const unityLog = new colibri.UnityClientLogger(unityServer);
const webLog = new colibri.WebLog(socketioServer);
const modelsync = new colibri.ModelSynchronization(connectionPool, dataStore);
const broadcaster = new colibri.Broadcaster(connectionPool);

/**
 *    Startup
 */

const startup = async () => {
    for (const service of colibri.Service.Current) {
        await service.init();
    }

    const httpServer = webServer.start();
    socketioServer.start(httpServer);
    unityServer.start(Config.UNITY_PORT);
    voiceServer.start(Config.VOICE_PORT);
};

startup();
