import path = require('path');

// automatically load .env file
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config();

export const Config = {
    TCP_HOST: process.env.TCP_HOST || '0.0.0.0',
    TCP_PORT: Number(process.env.TCP_PORT || 9012),

    VOICE_HOST: process.env.VOICE_HOST || '0.0.0.0',
    VOICE_PORT: Number(process.env.VOICE_PORT || 9013),
    VOICE_SAMPLING_RATE: Number(process.env.VOICE_SAMPLING_RATE || 48000),
    VOICE_RECORDING: process.env.VOICE_RECORDING?.toLowerCase() === 'true',

    WEBSERVER_HOST: process.env.WEBSERVER_HOST || '0.0.0.0',
    WEBSERVER_PORT: Number(process.env.WEBSERVER_PORT || 9011),
    WEBSERVER_ROOT: path.join(
        __dirname,
        process.env.WEBSERVER_ROOT || '../ui/'
    ),

    BASE_URL: process.env.BASE_URL || '',

    DATA_ROOT: path.join(
        __dirname,
        process.env.DATA_ROOT || '../../data/'
    ),
};
