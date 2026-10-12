import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Subject } from 'rxjs';
import { ConnectionState, ModelRow, Reconnect, SocketIOService } from '../../services';
import { DELETED_SHOWN, HIGHLIGHT_LIMIT, MODELS_PAGE_SIZE, ModelsComponent, jsonParts } from './models.component';

const model = (id: string, overrides: Partial<ModelRow> = {}): ModelRow => ({
    app: 'demo', channel: 'scene', id, fields: 3, bytes: 120, updatedAt: 1000, ...overrides
});

describe('ModelsComponent', () => {
    let channel: Subject<{ command: string; payload: unknown }>;
    let emit: ReturnType<typeof vi.fn>;

    const asked = (topic: string) => emit.mock.calls.filter(call => call[2]?.topic === topic && call[1] !== 'unsubscribe').at(-1);
    const answer = (topic: string, payload: object) =>
        channel.next({ command: topic, payload: { request: asked(topic)![2].request, at: 61_000, ...payload } });
    const list = (models: ModelRow[], extra: object = {}) => answer('models', {
        query: { app: '', channel: '', filter: '', offset: 0, limit: MODELS_PAGE_SIZE },
        channels: [ { app: 'demo', channel: 'scene', models: models.length, deleted: 1 } ],
        channelsTotal: 1,
        models,
        total: models.length,
        deleted: [ { app: 'demo', channel: 'scene', id: 'gone', deletedAt: 31_000 } ],
        deletedTotal: 1,
        tombstoneSeconds: 600,
        ...extra
    });

    const open = async (url: string) => {
        const harness = await RouterTestingHarness.create();
        const component = await harness.navigateByUrl(url, ModelsComponent);
        TestBed.flushEffects();
        return { harness, component };
    };

    beforeEach(() => {
        channel = new Subject();
        emit = vi.fn();

        TestBed.configureTestingModule({
            providers: [
                provideRouter([ { path: 'models', component: ModelsComponent } ]),
                {
                    provide: SocketIOService,
                    useValue: {
                        listen: () => channel.asObservable(),
                        emit,
                        reconnected$: new Subject<Reconnect>().asObservable(),
                        state: signal<ConnectionState>('connected'),
                        lostAt: signal<number | null>(null)
                    }
                }
            ]
        });
    });

    it('asks once for the app, channel, filter and page in the address, every second when live', async () => {
        const { harness } = await open('/models?app=demo&channel=scene&q=piece&page=3');
        expect(asked('models')).toEqual([ 'colibri::admin', 'request', {
            topic: 'models', app: 'demo', channel: 'scene', filter: 'piece', offset: 2 * MODELS_PAGE_SIZE, limit: MODELS_PAGE_SIZE, request: expect.any(Number)
        } ]);
        // no model open, nothing asked for it
        expect(asked('model')).toBeUndefined();

        await harness.navigateByUrl('/models?live=1');
        TestBed.flushEffects();
        expect(asked('models')?.[1]).toBe('subscribe');
    });

    it('lists a page of models with their size and age, and the ids deleted lately', async () => {
        const { harness, component } = await open('/models');
        list([ model('a', { updatedAt: 1000 }), model('b', { bytes: null, truncated: true }) ]);
        harness.detectChanges();

        expect(component.rows().map(row => [ row.id, row.size, row.age ])).toEqual([ [ 'a', '120 B', '1 min' ], [ 'b', null, '1 min' ] ]);
        expect(component.deleted().map(row => [ row.id, row.age ])).toEqual([ [ 'gone', '30 s' ] ]);
        expect(component.summary()).toBe('2 in 1 channel of 1 app');
        const root = harness.routeNativeElement!;
        // a cut id cannot be looked up: no link
        expect([ ...root.querySelectorAll('.models-table td.c-id') ].map(td => td.querySelector('a') !== null)).toEqual([ true, false ]);
        expect(root.querySelector('.models-table a.id')?.getAttribute('href')).toBe('/models?model=a&modelApp=demo&modelChannel=scene');
        // the whole id and channel on hover, where the column cuts them short; the cut tag in the
        // same line as the id, which keeps it in view
        expect([ ...root.querySelectorAll('.models-table .id') ].map(id => id.getAttribute('title'))).toEqual([ 'a', 'b' ]);
        expect(root.querySelector('.models-table td.c-channel')?.getAttribute('title')).toBe('demo / scene');
        expect(root.querySelector('.models-table .id-line .tag')?.textContent).toBe('cut');
    });

    it('shows the open model\'s value, and what became of one deleted', async () => {
        const { harness, component } = await open('/models?model=m1&modelApp=demo&modelChannel=scene');
        expect(asked('model')?.[2]).toEqual({ topic: 'model', app: 'demo', channel: 'scene', id: 'm1', request: expect.any(Number) });

        answer('model', { app: 'demo', channel: 'scene', id: 'm1', found: true, fields: 1, bytes: 20, updatedAt: 1000, json: '{\n  "id": "m1",\n  "on": true\n}', truncated: false });
        harness.detectChanges();
        expect(harness.routeNativeElement!.querySelector('.json')?.textContent).toBe('{\n  "id": "m1",\n  "on": true\n}');
        expect(component.modelAge()).toBe('1 min');

        answer('model', { app: 'demo', channel: 'scene', id: 'm1', found: false, deletedAt: 59_000 });
        harness.detectChanges();
        expect(harness.routeNativeElement!.querySelector('.gone')?.textContent?.trim()).toMatch(/^Deleted 2 s ago, at /);
    });

    it('spans the page until a model is open, and shows the newest deleted ids until asked for all', async () => {
        const { harness } = await open('/models');
        const deleted = Array.from({ length: DELETED_SHOWN + 5 }, (_, i) => ({ app: 'demo', channel: 'scene', id: `d${i}`, deletedAt: 31_000 }));
        list([ model('a') ], { deleted, deletedTotal: deleted.length });
        harness.detectChanges();
        const root = harness.routeNativeElement!;

        expect(root.querySelector('.models')?.classList.contains('open')).toBe(false);
        expect(root.querySelector('.detail')).toBeNull();
        expect(root.querySelectorAll('.deleted-table tbody tr')).toHaveLength(DELETED_SHOWN);

        const more = root.querySelector<HTMLButtonElement>('.more-deleted')!;
        expect(more.textContent?.trim()).toBe(`Show all ${DELETED_SHOWN + 5}`);
        more.click();
        harness.detectChanges();
        expect(root.querySelectorAll('.deleted-table tbody tr')).toHaveLength(DELETED_SHOWN + 5);
    });

    it('moves the focus to the opened model, and back to its row when it closes', async () => {
        const { harness } = await open('/models');
        list([ model('a'), model('b') ]);
        harness.detectChanges();

        // as below 1100px, where the list goes and the link that had the focus with it
        await harness.navigateByUrl('/models?model=b&modelApp=demo&modelChannel=scene');
        TestBed.tick();
        expect(document.activeElement?.id).toBe('model-title');

        // and the Back button that closes it
        await harness.navigateByUrl('/models');
        TestBed.tick();
        expect(document.activeElement?.getAttribute('data-key')).toBe('demo\nscene\nb');
    });

    it('downloads a value cut at 512 KiB as text, named as partial', async () => {
        const { harness, component } = await open('/models?model=m1&modelApp=demo&modelChannel=scene');
        const created: Blob[] = [];
        const names: string[] = [];
        const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => { created.push(blob as Blob); return 'blob:x'; });
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });

        answer('model', { app: 'demo', channel: 'scene', id: 'm1', found: true, fields: 1, bytes: 600_000, updatedAt: 1000, json: '{\n  "id": "m1",\n  "text": "xx', truncated: true });
        harness.detectChanges();
        expect(harness.routeNativeElement!.querySelector('.facts .btn')?.textContent?.trim()).toBe('Download start');
        component.downloadModel();

        answer('model', { app: 'demo', channel: 'scene', id: 'm1', found: true, fields: 1, bytes: 20, updatedAt: 1000, json: '{\n  "id": "m1"\n}', truncated: false });
        component.downloadModel();

        expect(names).toEqual([ 'demo-scene-m1-partial.txt', 'demo-scene-m1.json' ]);
        expect(created.map(blob => blob.type)).toEqual([ 'text/plain', 'application/json' ]);
        click.mockRestore();
        createObjectURL.mockRestore();
    });

    it('offers the last page when the page asked for is past the end', async () => {
        const { harness, component } = await open('/models?page=9');
        list([], { total: 120, query: { app: '', channel: '', filter: '', offset: 400, limit: MODELS_PAGE_SIZE } });
        harness.detectChanges();
        expect(component.empty()).toBe('Page 9 is past the end.');

        expect(harness.routeNativeElement!.querySelector('.empty button')?.textContent).toBe('Last page');
        await component.setPage(component.pages());

        expect(component.page()).toBe(3);
    });
});

describe('jsonParts', () => {
    it('tells keys, strings, numbers and literals apart', () => {
        const parts = jsonParts('{\n  "id": "a:b",\n  "n": -1.5e3,\n  "ok": null\n}');
        expect(parts.filter(part => part.kind).map(part => [ part.kind, part.text ])).toEqual([
            [ 'key', '"id"' ], [ 'string', '"a:b"' ], [ 'key', '"n"' ], [ 'number', '-1.5e3' ], [ 'key', '"ok"' ], [ 'literal', 'null' ]
        ]);
        expect(parts.map(part => part.text).join('')).toBe('{\n  "id": "a:b",\n  "n": -1.5e3,\n  "ok": null\n}');
    });

    it('leaves a long value plain', () => {
        const json = `"${'x'.repeat(HIGHLIGHT_LIMIT)}"`;
        expect(jsonParts(json)).toEqual([ { text: json, kind: null } ]);
    });
});
