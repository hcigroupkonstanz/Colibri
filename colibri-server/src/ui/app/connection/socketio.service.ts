/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NgZone, inject, signal } from '@angular/core';
import type { Observable } from 'rxjs';
import { Subject, throttleTime } from 'rxjs';
import * as io from 'socket.io-client';

/** `connecting` until the first connection, `reconnecting` after it is lost. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

export interface ChannelMessage {
    command: string;
    payload: unknown;
}

export interface Reconnect {
    /** When the connection was lost. */
    lostAt: number;
    /** When it was back. */
    at: number;
}

@Injectable({
    providedIn: 'root'
})
export class SocketIOService {
    private readonly zone = inject(NgZone);

    private readonly socket: io.Socket<any, any>;
    private readonly listeners: { [name: string]: Subject<ChannelMessage> } = {};
    // Throttled empty zone.run() that triggers change detection after socket events.
    // Only needed while zone.js change detection is active.
    private readonly changeTrigger$ = new Subject<void>();

    private readonly _state = signal<ConnectionState>('connecting');
    public readonly state = this._state.asReadonly();

    private readonly _lostAt = signal<number | null>(null);
    /** When the connection was lost, while it is. */
    public readonly lostAt = this._lostAt.asReadonly();

    private readonly reconnectSource = new Subject<Reconnect>();
    /**
     * Emits each time the connection is back after a loss. Subscribers re-request their data: the
     * server forgets a client's subscriptions when its connection drops.
     */
    public readonly reconnected$ = this.reconnectSource.asObservable();

    public constructor() {
        // Keep in step with PROTOCOL_VERSION (src/server/modules/protocol/protocol.ts). The
        // server only warns on a mismatch from the admin UI, but it does so on every connect.
        this.socket = io.connect('', { query: { app: 'colibri', version: '2' } });

        this.socket.on('connect', () => {
            const lostAt = this._lostAt();
            this._state.set('connected');
            this._lostAt.set(null);
            if (lostAt !== null) {
                this.reconnectSource.next({ lostAt, at: Date.now() });
            }
            this.changeTrigger$.next();
        });

        this.socket.on('disconnect', (reason: string) => {
            this._state.set('reconnecting');
            this._lostAt.set(Date.now());
            // socket.io-client does not retry after a server-initiated disconnect.
            if (reason === 'io server disconnect') {
                this.socket.connect();
            }
            this.changeTrigger$.next();
        });

        this.changeTrigger$
            .pipe(throttleTime(50, undefined, { leading: true, trailing: true }))
            // eslint-disable-next-line no-empty-function
            .subscribe(() => this.zone.run(() => {}));
    }


    public listen(channel: string): Observable<ChannelMessage> {
        if (!this.listeners[channel]) {
            const msgStream = new Subject<ChannelMessage>();
            this.listeners[channel] = msgStream;

            this.socket.on(channel, (msg: ChannelMessage) => {
                msgStream.next({ command: msg.command, payload: msg.payload });
                this.changeTrigger$.next();
            });
        }

        return this.listeners[channel].asObservable();
    }

    public emit(channel: string, command: string, payload?: unknown): void {
        this.socket.emit(channel, {
            command,
            payload
        });
    }
}
