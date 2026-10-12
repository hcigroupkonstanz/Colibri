export const enum LogLevel {
    Error,
    Warn,
    Info,
    Debug
}

export type Metadata = { [key: string]: string | number | boolean };

// The metadata key of a routine connect or disconnect line, which the admin UI's Connections switch
// hides (see WebLog). A warning or an error about a connection is not tagged, and stays visible.
export const CONNECTION_METADATA_KEY = 'connection';

// The metadata of such a line about no client in particular.
export const CONNECTION_LINE: Metadata = Object.freeze({ [CONNECTION_METADATA_KEY]: true });

export interface LogMessage {
    origin: string;
    level: LogLevel;
    message: string;
    group: string;
    created: Date;
    metadata: Metadata;
}
