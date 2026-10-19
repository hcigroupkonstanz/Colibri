import { Colibri, RegisterSyncTransforms, SyncTransform, type Vector3 } from '@hcikn/colibri';
import { colibriAddress, colibriApp, colibriPort, rl } from './common';

/**
 *  Shows and moves the objects of colibri-unity's SyncTransform component. Run it next to the
 *  SyncTransform sample in Unity, with the same app name there, or in a second terminal to see two
 *  web clients move the same objects.
 */
void (async () => {
    new Colibri(await colibriApp(), await colibriAddress(), await colibriPort());

    // The Unity sample syncs its placed objects without a ModelId, and creates cubes and spheres
    // at runtime with the ModelIds 'cube' and 'sphere'. Each ModelId has a channel of its own.
    const channels = ['', 'cube', 'sphere'];
    const lists = new Map<string, SyncTransform[]>();

    let registerTransform: ((transform: SyncTransform) => void) | undefined;
    for (const modelId of channels) {
        const [transforms$, register] = RegisterSyncTransforms(modelId);
        if (modelId === '') registerTransform = register;

        // The list emits on every update, many times a second while an object moves in Unity, so
        // only objects that appear or disappear are printed here. 'list' prints the current state.
        transforms$.subscribe(transforms => {
            const before = new Set((lists.get(modelId) ?? []).map(t => t.id));
            const now = new Set(transforms.map(t => t.id));
            for (const t of transforms) if (!before.has(t.id)) console.log(`+ ${describe(modelId, t)}`);
            for (const id of before) if (!now.has(id)) console.log(`- ${id} was deleted`);
            lists.set(modelId, transforms);
        });
    }

    const all = () => [...lists.entries()].flatMap(([modelId, transforms]) => transforms.map(t => ({ modelId, t })));
    const find = (id: string) => all().find(entry => entry.t.id === id || entry.t.id.startsWith(id))?.t;

    const vector = (parts: string[]): Vector3 | undefined => {
        const numbers = parts.map(Number);
        return numbers.length === 3 && numbers.every(n => !Number.isNaN(n)) ? (numbers as Vector3) : undefined;
    };

    // Assigning a new value to a member sends it to all other clients, web and Unity.
    const change = (usage: string, id: string, apply: (transform: SyncTransform) => boolean) => {
        const transform = find(id);
        if (!transform || !apply(transform)) {
            console.log(`Usage: ${usage}`);
        }
    };

    const commands: Record<string, ((args: string[]) => void) | undefined> = {
        list: () => {
            const entries = all();
            if (entries.length === 0) {
                console.log('No objects yet. Start the SyncTransform sample in Unity.');
            }
            for (const { modelId, t } of entries) {
                console.log(describe(modelId, t));
            }
        },
        move: ([id = '', ...xyz]) => {
            change('move <id> <x> <y> <z>', id, transform => {
                const position = vector(xyz);
                if (position) transform.position = position;
                return position !== undefined;
            });
        },
        scale: ([id = '', ...xyz]) => {
            change('scale <id> <x> <y> <z>', id, transform => {
                const scale = vector(xyz);
                if (scale) transform.scale = scale;
                return scale !== undefined;
            });
        },
        hide: ([id = '']) => {
            change('hide <id>', id, transform => {
                transform.active = false;
                return true;
            });
        },
        show: ([id = '']) => {
            change('show <id>', id, transform => {
                transform.active = true;
                return true;
            });
        },
        // A Unity client builds a copy only with a SyncTransformManager for objects without a ModelId.
        create: ([id = '', ...xyz]) => {
            const position = vector(xyz);
            if (!id || !position || !registerTransform) {
                console.log('Usage: create <id> <x> <y> <z>');
                return;
            }
            const transform = new SyncTransform(id);
            transform.position = position;
            registerTransform(transform);
        },
        delete: ([id = '']) => {
            const transform = find(id);
            if (!id || !transform) {
                console.log('Usage: delete <id>');
                return;
            }
            // Deletes it for every client: Unity destroys the GameObject.
            transform.delete();
        },
        exit: () => {
            rl.close();
            process.exit();
        }
    };

    console.log(' ');
    console.log('Commands, with the start of an id:');
    console.log('  list                      show all objects');
    console.log('  move <id> <x> <y> <z>     move an object');
    console.log('  scale <id> <x> <y> <z>    scale an object');
    console.log('  hide <id>, show <id>      hide or show an object');
    console.log('  create <id> <x> <y> <z>   create an object from the web');
    console.log('  delete <id>               delete an object for every client');
    console.log('  exit');
    console.log(' ');

    for (;;) {
        const answer = await new Promise<string>(resolve => {
            rl.question('> ', resolve);
        });
        const [command, ...args] = answer.trim().split(/\s+/);
        if (!command) continue;
        const run = commands[command];
        if (run) {
            run(args);
        } else {
            console.log(`Unknown command '${command}'`);
        }
    }
})();

function describe(modelId: string, t: SyncTransform) {
    const round = (values: number[]) => values.map(v => Math.round(v * 100) / 100).join(', ');
    const kind = modelId ? ` (${modelId})` : '';
    return `${t.id}${kind}: ${t.active ? 'shown' : 'hidden'}, position [${round(t.position)}], scale [${round(t.scale)}]`;
}
