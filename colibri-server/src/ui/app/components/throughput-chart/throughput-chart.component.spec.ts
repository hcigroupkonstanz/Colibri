import * as d3 from 'd3';
import { ClientRow, ClientsSnapshot } from '../../services';
import { Sample, StackRow, addSample, edgeShown, historySamples, latestTotal, stackInput, withHistory } from './throughput-chart.component';

const sample = (at: number, clients: Record<string, { app?: string; in: number | null; out: number | null }>): Sample => ({
    at,
    clients: new Map(Object.entries(clients).map(([ id, rate ]) => [ id, { app: 'demo', color: `#${id}`, ...rate } ]))
});

describe('addSample', () => {
    it('keeps the samples of the last 122 s', () => {
        const samples = [ sample(0, {}), sample(5_000, {}), sample(100_000, {}) ];
        expect(addSample(samples, sample(125_000, {})).map(s => s.at)).toEqual([ 5_000, 100_000, 125_000 ]);
    });
});

describe('the rate history of a first snapshot', () => {
    const row = (id: string, history: [number, number][] | undefined, rates: { in: number | null; out: number | null }): ClientRow => ({
        id, app: 'demo', name: id, transport: 'tcp', version: '2', tls: false, tlsAtProxy: false, address: '10.0.0.5', connectedAt: 0,
        latency: null, limit: null, held: 0, ...rates, ...(history ? { history } : {})
    });
    const snapshot = (clients: ClientRow[]): ClientsSnapshot => ({ request: 1, at: 5_000_000, clients, total: clients.length, adminPages: 1 });

    it('stands for one sample a second before the snapshot, with the clients each second had', () => {
        const samples = historySamples(snapshot([
            row('a', [ [ 1, 10 ], [ 2, 20 ], [ 3, 30 ] ], { in: 4, out: 40 }),
            row('b', [ [ 7, 70 ] ], { in: 8, out: 80 })
        ]), 200_000, id => `#${id}`);

        expect(samples.map(s => [ s.at, Object.fromEntries([ ...s.clients ].map(([ id, rate ]) => [ id, [ rate.in, rate.out, rate.color ] ])) ])).toEqual([
            [ 197_000, { a: [ 1, 10, '#a' ] } ],
            [ 198_000, { a: [ 2, 20, '#a' ] } ],
            [ 199_000, { a: [ 3, 30, '#a' ], b: [ 7, 70, '#b' ] } ]
        ]);
    });

    it('fills the window at once, and the live rates carry on from it, a missing one kept as before', () => {
        const first = snapshot([ row('a', Array.from({ length: 122 }, (_, i) => [ i, 2 * i ]), { in: 122, out: 244 }) ]);
        let samples = addSample(withHistory([], historySamples(first, 200_000, () => '#a')), sample(200_000, { a: { in: 122, out: 244 } }));
        samples = addSample(samples, sample(201_000, { a: { in: null, out: null } }));

        const { rows } = stackInput(samples, 'in', '');
        // the oldest dropped as the chart moved on a second
        expect(rows[0]).toEqual({ at: 79_000, gap: false, values: { a: 1 } });
        expect(rows).toHaveLength(123);
        expect(rows.some(r => r.gap)).toBe(false);
        expect(rows.slice(-3).map(r => r.values['a'])).toEqual([ 121, 122, 122 ]);
    });

    it('takes the place of the samples it covers, after a reconnect, and keeps those before it', () => {
        const before = [ sample(1_000, {}), sample(2_000, {}), sample(3_000, {}) ];
        const history = [ sample(2_500, {}), sample(3_500, {}) ];
        expect(withHistory(before, history).map(s => s.at)).toEqual([ 1_000, 2_000, 2_500, 3_500 ]);
        expect(withHistory(before, []).map(s => s.at)).toEqual([ 1_000, 2_000, 3_000 ]);
    });
});

describe('stackInput', () => {
    it('stacks the clients of one app in the order they first appear, 0 for a client not there', () => {
        const { rows, series } = stackInput([
            sample(1_000, { a: { in: 30, out: 60 }, x: { app: 'other', in: 900, out: 900 } }),
            sample(2_000, { a: { in: 31, out: 62 }, b: { in: 5, out: 7 } }),
            sample(3_000, { b: { in: 6, out: 8 } })
        ], 'in', 'demo');

        expect(series).toEqual([ { id: 'a', color: '#a' }, { id: 'b', color: '#b' } ]);
        expect(rows.map(row => row.values)).toEqual([ { a: 30 }, { a: 31, b: 5 }, { b: 6 } ]);
    });

    it('counts the messages sent to the clients for Out, and every app without a filter', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 30, out: 60 }, x: { app: 'other', in: 1, out: 2 } }) ], 'out', '');
        expect(rows[0].values).toEqual({ a: 60, x: 2 });
    });

    it('keeps a client\'s last rate through a second the server had none, and 0 before its first', () => {
        const { rows } = stackInput([
            sample(1_000, { a: { in: null, out: null } }),
            sample(2_000, { a: { in: 20, out: 40 } }),
            sample(3_000, { a: { in: null, out: null } })
        ], 'in', '');
        expect(rows.map(row => row.values['a'])).toEqual([ 0, 20, 20 ]);
    });

    it('breaks the areas where the snapshots paused', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 1, out: 1 } }), sample(2_000, { a: { in: 1, out: 1 } }), sample(9_000, { a: { in: 1, out: 1 } }) ], 'in', '');
        expect(rows.map(row => [ row.at, row.gap ])).toEqual([ [ 1_000, false ], [ 2_000, false ], [ 5_500, true ], [ 9_000, false ] ]);
    });
});

describe('stackInput colours', () => {
    it('gives a client its newest colour, in the place it first had', () => {
        const recolour = (at: number, colors: Record<string, string>): Sample => ({
            at, clients: new Map(Object.entries(colors).map(([ id, color ]) => [ id, { app: 'demo', color, in: 1, out: 1 } ]))
        });
        const { series } = stackInput([ recolour(1_000, { a: 'red', b: 'blue' }), recolour(2_000, { a: 'blue', b: 'red' }) ], 'in', '');
        expect(series).toEqual([ { id: 'a', color: 'blue' }, { id: 'b', color: 'red' } ]);
    });
});

describe('latestTotal', () => {
    it('sums the newest row, with the rates carried forward', () => {
        const { rows } = stackInput([ sample(1_000, { a: { in: 30, out: 1 }, b: { in: 12, out: 1 } }), sample(2_000, { a: { in: null, out: null }, b: { in: 10, out: 1 } }) ], 'in', '');
        expect(latestTotal(rows)).toBe(40);
        expect(latestTotal([])).toBeNull();
    });
});

describe('edgeShown', () => {
    const layer = (heights: number[], gapAt = -1) => heights.map((h, i) => Object.assign([ 5, 5 + h ], { data: { at: i, gap: i === gapAt, values: {} } })) as unknown as d3.Series<StackRow, string>;

    it('draws a layer\'s edge where it has height and one point either side, so a client joins and leaves', () => {
        expect(edgeShown(layer([ 0, 0, 0, 4, 4, 0, 0, 0 ]))).toEqual([ false, false, true, true, true, true, false, false ]);
    });

    it('draws no edge for a client sending nothing, or across a pause', () => {
        expect(edgeShown(layer([ 0, 0, 0 ]))).toEqual([ false, false, false ]);
        expect(edgeShown(layer([ 3, 3, 0, 3 ], 2))).toEqual([ true, true, false, true ]);
    });
});
