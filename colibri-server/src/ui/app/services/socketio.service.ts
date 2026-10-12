/* eslint-disable @typescript-eslint/no-explicit-any */
import { Injectable, NgZone, inject, signal } from '@angular/core';
import { Subject, Observable, throttleTime } from 'rxjs';
import * as io from 'socket.io-client';

/** `connecting` until the first connection, `reconnecting` after it is lost. */
export type ConnectionState = 'connecting' | 'connected' | 'reconnecting';

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
    private zone = inject(NgZone);

    private socket: io.Socket<any, any>;
    private listeners: { [name: string]: Subject<any> } = {};
    // coalesces NgZone re-entry from bursty socket events; only needed while zone.js CD is active
    private readonly changeTrigger$ = new Subject<void>();

    private readonly _state = signal<ConnectionState>('connecting');
    public readonly state = this._state.asReadonly();

    private readonly _lostAt = signal<number | null>(null);
    /** When the connection was lost, while it is. */
    public readonly lostAt = this._lostAt.asReadonly();

    private readonly reconnectSource = new Subject<Reconnect>();
    /**
     * Each time the connection is back after it was lost. The server may have restarted, and it
     * forgets a client's subscriptions when it goes, so whatever was asked for is asked again.
     */
    public readonly reconnected$ = this.reconnectSource.asObservable();

    constructor() {
        // Must match PROTOCOL_VERSION in src/server/modules/networking/protocol.ts. The admin
        // UI is exempt from the disconnect-on-mismatch check (it ships with the server, so it
        // can only ever be out of step by mistake), but a stale value here still logs a
        // warning on every page load.
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
            // Socket.IO retries by itself unless the server closed the connection on purpose.
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


    public listen(channel: string): Observable<any> {
        if (!this.listeners[channel]) {
            const msgStream = new Subject<any>();
            this.listeners[channel] = msgStream;

            this.socket.on(channel, (msg: any) => {
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
