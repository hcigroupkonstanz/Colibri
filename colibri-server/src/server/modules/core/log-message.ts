export const enum LogLevel {
    Error,
    Warn,
    Info,
    Debug
}

export type Metadata = { [key: string]: string | number | boolean };

export interface LogMessage {
    origin: string;
    level: LogLevel;
    message: string;
    group: string;
    created: Date;
    metadata: Metadata;
}
