import { describe, expect, it, vi } from 'vitest';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';

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
                },
            };
            const fakeContext = {
                kind: 'method',
                name: 'x',
                addInitializer: () => undefined,
            };

            expect(() =>
                decorator(fakeTarget as any, fakeContext as any),
            ).toThrow('@Synced() must decorate an `accessor` member');
        });
    });

    describe('local set emission', () => {
        it('emits the LOCAL key synchronously on modelChanges when set locally', () => {
            const person = new Person('p1');
            const emissions: string[] = [];
            person.modelChanges.subscribe((key) => emissions.push(key));

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
            person.modelChanges.subscribe((key) => emissions.push(key));

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

            expect((animal as any).__syncedProperties).toEqual({
                legs: 'legs',
            });

            expect((dog as any).__syncedProperties).toEqual({
                legs: 'legs',
                breed: 'breed',
            });

            expect(animal.toJson()).toEqual({ id: 'animal-1', legs: 4 });
            expect(animal.toJson()).not.toHaveProperty('breed');

            expect(dog.toJson()).toEqual({
                id: 'dog-1',
                legs: 4,
                breed: 'unknown',
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
                person.modelChanges$.subscribe((keys) => buffered.push(keys));

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
