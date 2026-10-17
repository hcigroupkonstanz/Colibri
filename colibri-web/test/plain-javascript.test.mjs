// A SyncModel in plain JavaScript, with synced() instead of the @Synced() decorator: no TypeScript
// syntax in this file, so that it stays what a plain-JavaScript project writes.
import { describe, expect, it } from 'vitest';
import { SyncModel, synced } from '../src/index.ts';

class Cube extends SyncModel {
    constructor(id) {
        super(id);
        synced(this, { x: 0, y: 0, color: 'red' });
    }

    moveRight() {
        this.x += 1;
    }
}

describe('a SyncModel in plain JavaScript', () => {
    it('syncs the properties synced() declares, and keeps the class its methods', () => {
        const cube = new Cube('cube-1');
        const changes = [];
        cube.modelChanges.subscribe(change => changes.push(change));

        cube.moveRight();
        cube.color = 'blue';
        cube.update({ y: 4 });

        expect(changes).toEqual(['x', 'color']);
        expect(cube.toJson()).toEqual({ id: 'cube-1', x: 1, y: 4, color: 'blue' });
    });
});
