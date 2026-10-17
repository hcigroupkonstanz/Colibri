import { describe, expect, it, vi } from 'vitest';
import { SyncModel } from '../src/SyncModel';
import { Synced, synced } from '../src/Synced';

// Exposes the private `__syncedProperties` map the tests below reach into,
// without resorting to `any`.
interface SyncModelInternals {
    __syncedProperties?: Record<string, string | symbol>;
}

interface PersonData {
    age: number;
}

class Person extends SyncModel<PersonData> {
    @Synced() accessor age = 0;
}

interface AnimalData {
    legs: number;
}

class Animal extends SyncModel<AnimalData> {
    @Synced() accessor legs = 4;
}

class Dog extends Animal {
    @Synced() accessor breed = 'unknown';
}

describe('Synced', () => {
    describe('kind guard', () => {
        it('throws the exact message when context.kind !== "accessor"', () => {
            const decorator = Synced();
            const fakeTarget = {
                get() {
                    return undefined;
                },
                set() {
                    /* noop */
                }
            };
            const fakeContext = {
                kind: 'method',
                name: 'x',
                addInitializer: () => undefined
            };

            expect(() =>
                decorator(
                    fakeTarget as unknown as ClassAccessorDecoratorTarget<SyncModel<unknown>, unknown>,
                    fakeContext as unknown as ClassAccessorDecoratorContext<SyncModel<unknown>>
                )
            ).toThrow('@Synced() must decorate an `accessor` member');
        });
    });

    describe('local set emission', () => {
        it('emits the LOCAL key synchronously on modelChanges when set locally', () => {
            const person = new Person('p1');
            const emissions: string[] = [];
            person.modelChanges.subscribe(key => emissions.push(key));

            person.age = 42;

            // Synchronous emission of the local key (not a lowercased wire-name).
            expect(emissions).toEqual(['age']);
            expect(person.age).toBe(42);
        });
    });

    describe('instance isolation', () => {
        it('keeps backing values fully isolated between instances', () => {
            const a = new Person('a');
            const b = new Person('b');

            a.age = 10;
            b.age = 20;

            expect(a.age).toBe(10);
            expect(b.age).toBe(20);

            a.age = 99;
            expect(a.age).toBe(99);
            expect(b.age).toBe(20);
        });
    });

    describe('applyingRemoteUpdate suppression', () => {
        it('does not emit while applyingRemoteUpdate is true', () => {
            const person = new Person('p1');
            const emissions: string[] = [];
            person.modelChanges.subscribe(key => emissions.push(key));

            person.applyingRemoteUpdate = true;
            person.age = 7;
            expect(emissions).toEqual([]);
            expect(person.age).toBe(7);

            // Once cleared, emissions resume.
            person.applyingRemoteUpdate = false;
            person.age = 8;
            expect(emissions).toEqual(['age']);
        });
    });

    describe('subclass registration', () => {
        it('registers the subclass member without leaking into a parent-class instance', () => {
            const animal = new Animal('animal-1');
            const dog = new Dog('dog-1');

            expect((animal as unknown as SyncModelInternals).__syncedProperties).toEqual({
                legs: 'legs'
            });

            expect((dog as unknown as SyncModelInternals).__syncedProperties).toEqual({
                legs: 'legs',
                breed: 'breed'
            });

            expect(animal.toJson()).toEqual({ id: 'animal-1', legs: 4 });
            expect(animal.toJson()).not.toHaveProperty('breed');

            expect(dog.toJson()).toEqual({
                id: 'dog-1',
                legs: 4,
                breed: 'unknown'
            });
        });
    });

    // Bonus: the buffered modelChanges$ dedups within its 1ms window.
    describe('modelChanges$ (buffered/deduped)', () => {
        it('dedups repeated keys emitted within the 1ms buffer window', () => {
            vi.useFakeTimers();
            try {
                const person = new Person('p1');
                const buffered: string[][] = [];
                person.modelChanges$.subscribe(keys => buffered.push(keys));

                person.age = 1;
                person.age = 2; // same key 'age' again within the window

                vi.advanceTimersByTime(1);

                expect(buffered).toEqual([['age']]);
            } finally {
                vi.useRealTimers();
            }
        });
    });
});

// synced(): the same, for plain JavaScript, called in the constructor.
describe('synced()', () => {
    interface CubeData {
        x: number;
        posY: number;
        color: string;
    }

    class Cube extends SyncModel<CubeData> {
        declare x: number;
        declare posY: number;
        declare color: string;

        constructor(id: string) {
            super(id);
            synced(this, { x: 0, posY: 1, color: 'red' }, { posY: 'y' });
        }
    }

    const internals = (model: SyncModel<unknown>) => (model as unknown as SyncModelInternals).__syncedProperties;

    it('syncs each property under its name lowercased, or the name given', () => {
        const cube = new Cube('c1');

        expect(internals(cube)).toEqual({ x: 'x', y: 'posY', color: 'color' });
        expect(cube.toJson()).toEqual({ id: 'c1', x: 0, y: 1, color: 'red' });
    });

    it('reports a change by its local name, and applies a remote update without reporting it', () => {
        const cube = new Cube('c1');
        const changes: string[] = [];
        cube.modelChanges.subscribe(change => changes.push(change));

        cube.posY = 5;
        cube.update({ x: 3, y: 7 } as Partial<CubeData>);

        expect(changes).toEqual(['posY']);
        expect([cube.x, cube.posY]).toEqual([3, 7]);
        expect(cube.toJson(['posY'])).toEqual({ id: 'c1', y: 7 });
    });

    it('works next to @Synced() members', () => {
        class Labelled extends SyncModel<unknown> {
            @Synced() accessor label = 'a';
            declare size: number;

            constructor(id: string) {
                super(id);
                synced(this, { size: 2 });
            }
        }

        expect(new Labelled('l1').toJson()).toEqual({ id: 'l1', label: 'a', size: 2 });
    });

    it.each([
        ['id', { id: 'x' }],
        ['delete', { delete: 1 }],
        ['label', { label: 'b' }]
    ])("refuses '%s', which is a member already, naming it", (key, values) => {
        class Labelled extends SyncModel<unknown> {
            @Synced() accessor label = 'a';
        }

        expect(() => {
            synced(new Labelled('l1'), values);
        }).toThrow(`synced(): '${key}' is already a member of Labelled`);
    });

    it('refuses a property synced twice, and a start value of undefined', () => {
        const cube = new Cube('c1');

        expect(() => {
            synced(cube, { x: 1 });
        }).toThrow("synced(): 'x' is already a member of Cube");
        expect(() => {
            synced(cube, { size: undefined });
        }).toThrow("synced(): 'size' has no start value");
    });
});
