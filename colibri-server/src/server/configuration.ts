import path = require('path');

// automatically load .env file
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

export const Config = {
    TCP_PORT: Number(process.env.TCP_PORT || 9012),
    VOICE_PORT: Number(process.env.VOICE_PORT || 9013),

    WEBSERVER_PORT: Number(process.env.WEBSERVER_PORT || 9011),
    WEBSERVER_ROOT: path.join(
        __dirname,
        process.env.WEBSERVER_ROOT || '../ui/'
    ),
    BASE_URL: process.env.BASE_URL || '',

    DATA_ROOT: path.join(
        __dirname,
        process.env.WEBSERVER_ROOT || '../../data/'
    ),
};
