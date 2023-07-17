import { Subject } from 'rxjs';
import * as io from 'socket.io-client';

export interface Message {
    channel: string,
    command: string,
    payload: any
};

const messageSubject = new Subject<Message>();
export const Messages = messageSubject.asObservable();

const location = window.location.hostname;
const client = io.connect(location + ':8001');

client.onAny((channel, msg) => {
    if (msg.command === 'rpcRequest') {
        const result = CallRpc(msg.channel, msg.payload['parameters']);
        client.emit(msg.channel, {
            group: 'TODO',
            command: 'rpcAnswer',
            payload: {
                result,
                rpcId: msg.payload['rpcId']
            }
        });
    } else {
        messageSubject.next({
            channel,
            command: msg.command,
            payload: msg.payload
        });
    }
});


///////////////////////////
/// Default communication
///////////////////////////
export const SendMessage = (channel: string, payload: any) => {
    client.emit(channel, {
        group: 'TODO',
        payload
    });
};


//////////////////
/// RPC
//////////////////
type rpcMethod = (payload: any) => any;
const rpcMethods: {[method: string]: rpcMethod } = {};
export const RegisterRpc = (method: string, fn: rpcMethod): void => {
    rpcMethods[method] = fn;
}

export const SendRpc = async (method: string, payload: any): Promise<any> => {
    // TODO
    return null;
}

const CallRpc = (method: string, payload: any): any => {
    if (rpcMethods[method])
        return rpcMethods[method](payload);
    else {
        console.error(`Unknown rpc method ${method}`);
        return 'error';
    }
}


// for debugging
(window as any).SendMessage = SendMessage;
messageSubject.subscribe(console.log);


// TODO. maybe transmit this via handshake?
client.emit('group', {
    command: 'set',
    group: 'TODO',
    payload: { empty: 'TODO: should be empty' }
});

///////////////////////////
/// Model Sync
///////////////////////////

interface ModelMessage {
    command: 'modelUpdate' | 'modelDelete';
    payload: any;
}

interface ModelRegistration {
    name: string;
    onUpdate: (modelData: any) => void;
    onDelete: (modelData: any) => void;
    registrationData?: any;
}


export class SyncService {

    public sendCommand(channel: string, valueType: 'bool', value: any): void {
        this.socket.emit(channel, {
            command: valueType,
            payload: value
        });
    }

    public registerModel(registration: ModelRegistration): Promise<void> {
        // receive updates
        this.socket.on(`${registration.name}Model`, (msg: ModelMessage) => {
            if (msg.command === 'modelUpdate') {
                registration.onUpdate(msg.payload);
            }
            if (msg.command === 'modelDelete') {
                registration.onDelete(msg.payload);
            }
        });

        // initial data fetch
        return new Promise<void>((resolve, reject) => {
            this.socket.once(`${registration.name}ModelInit`, (msg: ModelMessage) => {
                for (const data of msg.payload) {
                    registration.onUpdate(data);
                }
                resolve();
            });
            this.socket.emit(`${registration.name}Model`, { command: 'modelFetch', payload: registration.registrationData });
        });
    }

    public updateModel(name: string, model: any): void {
        this.socket.emit(`${name}Model`, {
            command: 'modelUpdate',
            payload: model
        });
    }

    public deleteModel(name: string, modelId: any): void {
        this.socket.emit(`${name}Model`, {
            command: 'modelDelete',
            payload: modelId
        });
    }
}

