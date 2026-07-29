import { afterEach, describe, expect, it, vi } from 'vitest';
import { SyncModel } from '../src/SyncModel';
import { Synced } from '../src/Synced';

interface UserData {
    name: string;
    address: string;
}

// Exposes the private/protected internals the tests below reach into,
// without resorting to `any`.
interface SyncModelInternals {
    __syncedProperties?: Record<string, string | symbol>;
    onModelChanges: (prop: string) => void;
}

// Concrete fixture: `address` has a custom wire-name so we can prove the
// local-key vs. wire-name asymmetry. Wire-name is lowercased: 'billingaddress'.
class User extends SyncModel<UserData> {
    @Synced() accessor name = 'default-name';
    @Synced('billingAddress') accessor address = 'default-address';
}

describe('SyncModel', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('constructor', () => {
        it('sets the id', () => {
            const user = new User('user-1');
            expect(user.id).toBe('user-1');
        });
    });

    describe('registerSyncedProperty', () => {
        it('creates a non-enumerable per-instance __syncedProperties map', () => {
            const user = new User('user-1');

            const descriptor = Object.getOwnPropertyDescriptor(
                user,
                '__syncedProperties'
            );
            expect(descriptor).toBeDefined();
            expect(descriptor?.enumerable).toBe(false);

            // Not enumerable => absent from Object.keys and JSON.stringify.
            expect(Object.keys(user)).not.toContain('__syncedProperties');
            expect(JSON.stringify(user)).not.toContain('__syncedProperties');
        });

        it('maps wire-names to local keys (lowercased custom name)', () => {
            const user = new User('user-1');

            const synced = (user as unknown as SyncModelInternals)
                .__syncedProperties;

            expect(synced).toEqual({
                name: 'name',
                billingaddress: 'address'
            });
        });

        it('is per-instance: separate instances have distinct maps', () => {
            const a = new User('a');
            const b = new User('b');

            expect(
                (a as unknown as SyncModelInternals).__syncedProperties
            ).not.toBe(
                (b as unknown as SyncModelInternals).__syncedProperties
            );
        });
    });

    describe('toJson', () => {
        it('returns { id, ...lowercased-synced-names }', () => {
            const user = new User('user-1');
            user.name = 'Alice';
            user.address = '123 Main St';

            expect(user.toJson()).toEqual({
                id: 'user-1',
                name: 'Alice',
                billingaddress: '123 Main St'
            });
        });

        it('filters the attributes whitelist by LOCAL key, not wire-name', () => {
            const user = new User('user-1');
            user.address = '123 Main St';

            // Passing the local key 'address' includes the property, whose
            // OUTPUT key is the wire-name 'billingaddress'. This proves the
            // asymmetry: filter input is the local key, output key is the
            // wire-name.
            expect(user.toJson(['address'])).toEqual({
                id: 'user-1',
                billingaddress: '123 Main St'
            });

            // Passing the wire-name 'billingaddress' does NOT match, so the
            // property is excluded entirely.
            expect(user.toJson(['billingaddress'])).toEqual({
                id: 'user-1'
            });
        });
    });

    describe('update', () => {
        it('applies mapped props keyed by wire-name', () => {
            const user = new User('user-1');

            user.update({
                name: 'Bob',
                billingaddress: '456 Oak Ave'
            } as never);

            expect(user.name).toBe('Bob');
            expect(user.address).toBe('456 Oak Ave');
        });

        it('skips an `id` key in the updates payload', () => {
            const user = new User('user-1');

            user.update({ id: 'hacked', name: 'Carol' } as never);

            expect(user.id).toBe('user-1');
            expect(user.name).toBe('Carol');
        });

        it('console.warn on an unknown key instead of throwing', () => {
            const user = new User('user-1');
            const warnSpy = vi
                .spyOn(console, 'warn')
                .mockImplementation(() => undefined);

            expect(() => {
                user.update({ bogus: 'x' } as never);
            }).not.toThrow();

            expect(warnSpy).toHaveBeenCalledTimes(1);
            expect(warnSpy).toHaveBeenCalledWith(
                'Unknown property bogus in User'
            );
        });

        it('suppresses modelChanges emissions while applying (finally resets flag)', () => {
            const user = new User('user-1');
            const emissions: string[] = [];
            user.modelChanges.subscribe(key => emissions.push(key));

            user.update({ name: 'Dave' });

            // Setter emission suppressed during update.
            expect(emissions).toEqual([]);
            // Flag reset by the finally block.
            expect(user.applyingRemoteUpdate).toBe(false);

            // Local set after update still emits normally.
            user.name = 'Eve';
            expect(emissions).toEqual(['name']);
        });
    });

    describe('delete', () => {
        it('completes modelChanges and lands no further emissions', () => {
            const user = new User('user-1');
            const emissions: string[] = [];
            let completed = false;
            user.modelChanges.subscribe({
                next: key => emissions.push(key),
                complete: () => {
                    completed = true;
                }
            });

            user.delete();
            expect(completed).toBe(true);

            // After completion, next() is a no-op; a local set emits nothing.
            user.name = 'ignored';
            expect(emissions).toEqual([]);
        });
    });

    describe('onModelChanges', () => {
        it('emits the given key on modelChanges when called directly', () => {
            const user = new User('user-1');
            const emissions: string[] = [];
            user.modelChanges.subscribe(key => emissions.push(key));

            // Protected in TypeScript, but reachable from within a subclass or
            // (as here) via a direct cast - this is the manual-emission escape
            // hatch subclasses get alongside the @Synced-driven emissions.

            (user as unknown as SyncModelInternals).onModelChanges('manual');

            expect(emissions).toEqual(['manual']);
        });
    });
});
