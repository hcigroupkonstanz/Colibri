import { describe, it, expect } from 'vitest';
import { AppIndex } from '../../src/server/modules/core/app-index.js';

describe('AppIndex', () => {
    it('returns the new member count from add and creates the app on first use', () => {
        const index = new AppIndex<string>();

        expect(index.has('appA')).toBe(false);
        expect(index.add('appA', 'a')).toBe(1);
        expect(index.add('appA', 'b')).toBe(2);
        expect(index.add('appB', 'a')).toBe(1);

        expect(index.has('appA')).toBe(true);
        expect(index.size).toBe(2);
    });

    it('does not count a member added twice again', () => {
        const index = new AppIndex<string>();
        index.add('appA', 'a');

        expect(index.add('appA', 'a')).toBe(1);
    });

    it('returns the members left from remove and deletes the app once it is empty', () => {
        const index = new AppIndex<string>();
        index.add('appA', 'a');
        index.add('appA', 'b');

        expect(index.remove('appA', 'a')).toBe(1);
        expect(index.has('appA')).toBe(true);
        expect(index.remove('appA', 'b')).toBe(0);
        expect(index.has('appA')).toBe(false);
        expect(index.get('appA')).toBeUndefined();
        expect(index.size).toBe(0);
    });

    it('returns undefined when removing from an app without an entry', () => {
        const index = new AppIndex<string>();
        index.add('appA', 'a');

        expect(index.remove('appB', 'a')).toBeUndefined();
        expect(index.get('appA')).toEqual(new Set([ 'a' ]));
    });

    it('leaves the app alone when removing a member it does not have', () => {
        const index = new AppIndex<string>();
        index.add('appA', 'a');

        expect(index.remove('appA', 'other')).toBe(1);
        expect(index.get('appA')).toEqual(new Set([ 'a' ]));
    });

    it('lists the members of an app in the order they were added', () => {
        const index = new AppIndex<string>();
        for (const id of [ 'c', 'a', 'b' ]) index.add('appA', id);
        index.add('appB', 'z');

        expect(Array.from(index.get('appA') ?? [])).toEqual([ 'c', 'a', 'b' ]);

        index.remove('appA', 'a');
        index.add('appA', 'a');
        expect(Array.from(index.get('appA') ?? [])).toEqual([ 'c', 'b', 'a' ]);
    });

    it('keeps object members by identity', () => {
        const index = new AppIndex<{ id: string }>();
        const first = { id: 'x' };
        const lookalike = { id: 'x' };
        index.add('appA', first);
        index.add('appA', lookalike);

        expect(index.get('appA')?.size).toBe(2);
        expect(index.remove('appA', first)).toBe(1);
        expect(index.get('appA')?.has(lookalike)).toBe(true);
    });

    it('empties every app on clear', () => {
        const index = new AppIndex<string>();
        index.add('appA', 'a');
        index.add('appB', 'b');

        index.clear();

        expect(index.size).toBe(0);
        expect(index.has('appA')).toBe(false);
        expect(index.get('appB')).toBeUndefined();
    });

    describe('hasRecipients', () => {
        it('is false for an app without members', () => {
            const index = new AppIndex<string>();

            expect(index.hasRecipients('appA')).toBe(false);
            expect(index.hasRecipients('appA', 'a')).toBe(false);
        });

        it('is true for an app with members when nobody is excluded', () => {
            const index = new AppIndex<string>();
            index.add('appA', 'a');

            expect(index.hasRecipients('appA')).toBe(true);
        });

        it('is false when the only member is the excluded one', () => {
            const index = new AppIndex<string>();
            index.add('appA', 'a');

            expect(index.hasRecipients('appA', 'a')).toBe(false);
        });

        it('is true when the only member is not the excluded one', () => {
            const index = new AppIndex<string>();
            index.add('appA', 'a');

            expect(index.hasRecipients('appA', 'other')).toBe(true);
        });

        it('is true when the excluded member has company', () => {
            const index = new AppIndex<string>();
            index.add('appA', 'a');
            index.add('appA', 'b');

            expect(index.hasRecipients('appA', 'a')).toBe(true);
        });

        it('tells the apps apart', () => {
            const index = new AppIndex<string>();
            index.add('appA', 'a');

            expect(index.hasRecipients('appB', 'x')).toBe(false);
            expect(index.hasRecipients('appB')).toBe(false);
        });
    });
});
