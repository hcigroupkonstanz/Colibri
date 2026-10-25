import { describe, expect, it } from 'vitest';
import { compareWithShown, judgeConfirmation } from '../../src/modelSync/Confirmations';

describe('compareWithShown', () => {
    it('is undefined when every sent field is shown as sent', () => {
        expect(compareWithShown({ id: 'a', x: 1, name: 'one' }, { id: 'a', x: 1, name: 'one' })).toBeUndefined();
    });

    it('is undefined when only the id and undefined fields were sent', () => {
        expect(compareWithShown({ id: 'a', gone: undefined }, {})).toBeUndefined();
    });

    it('lists a field the server showed with another value, with the JSON of both', () => {
        const compared = compareWithShown({ id: 'a', x: 2 }, { id: 'a', x: 1 });

        expect([...(compared?.sent ?? [])]).toEqual([['x', '2']]);
        expect([...(compared?.replaced ?? [])]).toEqual([['x', '1']]);
    });

    it('lists a field the server did not show, replacing nothing', () => {
        const compared = compareWithShown({ id: 'a', x: 2 }, { id: 'a' });

        expect([...(compared?.sent ?? [])]).toEqual([['x', '2']]);
        expect(compared?.replaced.has('x')).toBe(true);
        expect(compared?.replaced.get('x')).toBeUndefined();
    });

    it('compares objects and null by their JSON', () => {
        const compared = compareWithShown(
            { id: 'a', pos: { x: 1, y: 2 }, same: { z: 3 }, cleared: null },
            { id: 'a', pos: { x: 1, y: 3 }, same: { z: 3 }, cleared: 'text' }
        );

        expect([...(compared?.sent ?? [])]).toEqual([
            ['pos', '{"x":1,"y":2}'],
            ['cleared', 'null']
        ]);
        expect([...(compared?.replaced ?? [])]).toEqual([
            ['pos', '{"x":1,"y":3}'],
            ['cleared', '"text"']
        ]);
    });

    it('skips the id and fields JSON cannot represent', () => {
        const compared = compareWithShown({ id: 'b', fn: () => 1, gone: undefined, x: 1 }, { id: 'a' });

        expect([...(compared?.sent ?? [])]).toEqual([['x', '1']]);
    });

    it('keeps the order of the sent fields', () => {
        const compared = compareWithShown({ id: 'a', c: 1, a: 2, b: 3 }, {});

        expect([...(compared?.sent.keys() ?? [])]).toEqual(['c', 'a', 'b']);
        expect([...(compared?.replaced.keys() ?? [])]).toEqual(['c', 'a', 'b']);
    });

    it('takes a shown field that is undefined as a field with no value to replace', () => {
        const compared = compareWithShown({ id: 'a', x: 1 }, { x: undefined });

        expect([...(compared?.sent ?? [])]).toEqual([['x', '1']]);
        expect(compared?.replaced.get('x')).toBeUndefined();
    });

    it('does not change its arguments', () => {
        const sent = { id: 'a', x: 2 };
        const shown = { id: 'a', x: 1 };

        compareWithShown(sent, shown);

        expect(sent).toEqual({ id: 'a', x: 2 });
        expect(shown).toEqual({ id: 'a', x: 1 });
    });
});

describe('judgeConfirmation', () => {
    const confirmation = (
        sent: [string, string][],
        replaced: [string, string | undefined][],
        shown: [string, unknown][]
    ) => ({ sent: new Map(sent), replaced: new Map(replaced), props: [], shown: new Map(shown), end: 'end' });

    it('has nothing to say about a field shown as sent', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', '1']], [['x', 2]]));

        expect(verdict).toEqual({ theirs: { id: 'a' }, again: [] });
    });

    it('sends again a field that no update showed', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', '1']], []));

        expect(verdict).toEqual({ theirs: { id: 'a' }, again: ['x'] });
    });

    it('sends again a field that was shown with the value it replaced', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', '1']], [['x', 1]]));

        expect(verdict).toEqual({ theirs: { id: 'a' }, again: ['x'] });
    });

    it('applies a field that was shown with another value', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', '1']], [['x', 3]]));

        expect(verdict).toEqual({ theirs: { id: 'a', x: 3 }, again: [] });
    });

    it('applies another value for a field the server had no value for', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', undefined]], [['x', 3]]));

        expect(verdict).toEqual({ theirs: { id: 'a', x: 3 }, again: [] });
    });

    it('sends again a field that was shown as undefined', () => {
        const verdict = judgeConfirmation('a', confirmation([['x', '2']], [['x', '1']], [['x', undefined]]));

        expect(verdict).toEqual({ theirs: { id: 'a' }, again: ['x'] });
    });

    it('compares objects by their JSON', () => {
        const verdict = judgeConfirmation(
            'a',
            confirmation(
                [
                    ['same', '{"z":1}'],
                    ['other', '{"z":2}']
                ],
                [
                    ['same', '{"z":0}'],
                    ['other', '{"z":0}']
                ],
                [
                    ['same', { z: 1 }],
                    ['other', { z: 3 }]
                ]
            )
        );

        expect(verdict).toEqual({ theirs: { id: 'a', other: { z: 3 } }, again: [] });
    });

    it('judges every sent field and ignores shown fields that were not sent', () => {
        const verdict = judgeConfirmation(
            'a',
            confirmation(
                [
                    ['arrived', '1'],
                    ['lost', '2'],
                    ['theirs', '3'],
                    ['missing', '4']
                ],
                [
                    ['arrived', '0'],
                    ['lost', '0'],
                    ['theirs', '0'],
                    ['missing', '0']
                ],
                [
                    ['arrived', 1],
                    ['lost', 0],
                    ['theirs', 9],
                    ['unrelated', 5]
                ]
            )
        );

        expect(verdict.again).toEqual(['lost', 'missing']);
        expect(Object.keys(verdict.theirs)).toEqual(['id', 'theirs']);
        expect(verdict.theirs).toEqual({ id: 'a', theirs: 9 });
    });

    it('does not change the confirmation', () => {
        const confirmed = confirmation([['x', '2']], [['x', '1']], [['x', 3]]);

        judgeConfirmation('a', confirmed);

        expect([...confirmed.sent]).toEqual([['x', '2']]);
        expect([...confirmed.replaced]).toEqual([['x', '1']]);
        expect([...confirmed.shown]).toEqual([['x', 3]]);
    });
});
