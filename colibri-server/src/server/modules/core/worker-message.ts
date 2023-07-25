export interface WorkerMessage {
    channel: string;
    content: { [key: string]: unknown };
}
