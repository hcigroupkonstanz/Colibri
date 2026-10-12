import { describe, it, expect } from 'vitest';
import { Serializable } from '../../src/server/modules/core/serializable.js';

interface ExampleModel {
    x: number;
    y: number;
}

class ExampleEntity extends Serializable<ExampleModel> {
    private _x = 0;
    private _y = 0;

    public get x(): number { return this._x; }
    public set x(v: number) { this._x = v; this.onModelChanges('x'); }
    public get y(): number { return this._y; }
    public set y(v: number) { this._y = v; this.onModelChanges('y'); }
}

describe('Serializable', () => {
    it('update() assigns properties and skips "id"', () => {
        const entity = new ExampleEntity('entity-1');
        entity.update({ x: 5, y: 7 }, 'test');

        expect(entity.x).toBe(5);
        expect(entity.y).toBe(7);
        expect(entity.id).toBe('entity-1');
    });

    it('toJson() auto-detects "_"-prefixed attributes when none are given', () => {
        const entity = new ExampleEntity('entity-1');
        entity.update({ x: 1, y: 2 }, 'test');

        expect(entity.toJson()).toEqual({ id: 'entity-1', x: 1, y: 2 });
    });

    it('toJson() only serializes explicitly requested attributes', () => {
        const entity = new ExampleEntity('entity-1');
        entity.update({ x: 1, y: 2 }, 'test');

        expect(entity.toJson(['x'])).toEqual({ id: 'entity-1', x: 1 });
    });
});
