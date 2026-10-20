export const enum LogLevel {
    Error,
    Warn,
    Info,
    Debug
}

export type Metadata = { [key: string]: string | number | boolean };

// Tags routine connection lines. WebLog hides them while the admin UI's Connections switch is off.
// Warnings and errors about a connection are not tagged, so they stay visible.
export const CONNECTION_METADATA_KEY = 'connection';

// One object for all connection lines. outputMsg does not copy metadata, so nothing may write to it.
export const CONNECTION_LINE: Metadata = Object.freeze({ [CONNECTION_METADATA_KEY]: true });

export interface LogMessage {
    origin: string;
    level: LogLevel;
    message: string;
    group: string;
    created: Date;
    metadata: Metadata;
}
