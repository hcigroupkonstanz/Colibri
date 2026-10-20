import { afterEach, describe, expect, it } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { filter, timeout } from 'rxjs/operators';
import { createClient, createSingletonWithPeer, disconnectAll, nextMessage, uniqueApp } from './helpers';
import { RegisterModelSync } from '../src/ModelSynchronization';
import { SyncModel } from '../src/SyncModel';
import { Synced, synced } from '../src/Synced';

afterEach(() => {
    disconnectAll();
});

class Note extends SyncModel<Note> {
    @Synced() accessor text = '';
}

// Plain JavaScript would write the same class without the `declare` lines.
class Cube extends SyncModel<Cube> {
    declare x: number;
    declare color: string;

    constructor(id: string) {
        super(id);
        synced(this, { x: 0, color: 'red' });
    }
}

describe('delete() for every client', () => {
    it('deletes a model on the server and for every other client', async () => {
        const app = uniqueApp('web-delete');
        const channel = uniqueApp('notes');
        const { peer } = await createSingletonWithPeer(app);
        const [notes$, registerNote] = RegisterModelSync({ name: channel, type: Note });

        const created = nextMessage(peer, { channel, command: 'model::update' });
        const note = new Note('n1');
        note.text = 'hello';
        registerNote(note);
        await created;

        const deleted = nextMessage(peer, { channel, command: 'model::delete' });
        note.delete();

        expect((await deleted).payload).toEqual({ id: 'n1' });
        expect(await firstValueFrom(notes$)).toEqual([]);

        // The server remembers the delete: a late update for the id goes nowhere, and a client
        // that joins now is told of no such model.
        const late = await createClient(app);
        const relayed = nextMessage(late, { channel, command: 'model::update' }, 500).then(
            () => true,
            () => false
        );
        peer.sendMessage(channel, 'model::update', { id: 'n1', text: 'late' });
        expect(await relayed).toBe(false);

        const answer = nextMessage(late, { channel, command: 'model::update' }, 500).then(
            msg => msg.payload,
            () => undefined
        );
        late.sendMessage(channel, 'model::request');
        expect(await answer).toBeUndefined();
    });
});

describe('synced() for plain JavaScript', () => {
    it('syncs a model declared with synced() like one with @Synced()', async () => {
        const app = uniqueApp('web-synced');
        const channel = uniqueApp('cubes');
        const { peer } = await createSingletonWithPeer(app);
        const [cubes$, registerCube] = RegisterModelSync({ name: channel, type: Cube });

        const created = nextMessage(peer, { channel, command: 'model::update' });
        const cube = new Cube('c1');
        registerCube(cube);
        expect((await created).payload).toEqual({ id: 'c1', x: 0, color: 'red' });

        const changed = nextMessage(peer, { channel, command: 'model::update' });
        cube.x = 2;
        expect((await changed).payload).toEqual({ id: 'c1', x: 2 });

        peer.sendMessage(channel, 'model::update', { id: 'c1', color: 'blue' });
        const updated = await firstValueFrom(
            cubes$.pipe(
                filter(cubes => cubes[0]?.color === 'blue'),
                timeout(2000)
            )
        );
        expect(updated[0]?.x).toBe(2);
    });
});
