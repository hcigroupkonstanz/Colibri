---
sidebar_position: 5
title: SyncModel
---

# SyncModel

`SyncModel` synchronizes the properties of your own classes between clients, e.g. a score, a selection or the state
of an experiment. It is the web counterpart of Unity's [`SyncBehaviour`](../unity/syncbehaviour.md), and both sync
with each other. Unlike [messages](./messages.md), synchronized objects keep their state: a client that joins later
gets the current values.

## Example: players with a score

```ts
import { RegisterModelSync, SyncModel, Synced } from '@hcikn/colibri';

class Player extends SyncModel<Player> {
    @Synced()
    accessor score = 0;
}

const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });

players$.subscribe(players => {
    console.log(players.map(p => `${p.id}: ${p.score}`));
});

const me = new Player(`player-${Date.now()}`);
registerPlayer(me);
me.score = 10;
```

`Player` inherits from `SyncModel<Player>`. `@Synced()` marks `score` for syncing: when one client changes it, it
changes on all other clients. `RegisterModelSync` returns `players$`, an [RxJS](https://rxjs.dev/guide/observable)
Observable of all players, and `registerPlayer`. `players$` emits the list whenever a player is added, changed or
deleted, also by another client. `registerPlayer` starts syncing a new player. Its id must be unique across all
clients.

Runnable sample: [model-sync](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/model-sync.ts)
(`npm run samples/model-sync`, see [Samples](./installation.md#samples)).

## Synced properties

Declare each synced property with `accessor` and mark it with `@Synced()`:

```ts
import { SyncModel, Synced } from '@hcikn/colibri';

export class Participant extends SyncModel<Participant> {
    @Synced()
    accessor name = '';

    @Synced()
    accessor age = 0;

    @Synced('billingAddress')
    accessor address = '';

    // not synced: only this client has it
    selected = false;
}
```

- Without `accessor`, `@Synced()` does not compile.
- `@Synced()` needs TypeScript's standard decorators, the default since TypeScript 5.0. Leave
  `experimentalDecorators` unset or `false` in `tsconfig.json`.
- `@Synced('billingAddress')` syncs the property under another name, here `billingAddress` instead of `address`.
  Use it when the name on the other clients differs from yours.
- Properties without `@Synced()` stay on this client.
- Colibri creates the objects of other clients with `new Participant(id)`. If your class has its own constructor,
  it must work with the id as its only argument.

A synced property holds a value that can be written as JSON. To sync with Unity, use these types:

| Unity `[Sync]` type | Web value                                                         |
| ------------------- | ----------------------------------------------------------------- |
| `bool`              | `boolean`                                                         |
| `int`, `float`      | `number`                                                          |
| `string`            | `string`                                                          |
| `Vector2`           | `[x, y]`                                                          |
| `Vector3`           | `[x, y, z]`                                                       |
| `Quaternion`        | `[x, y, z, w]`                                                    |
| `Color`             | `ColorValue`. Unity sends `'#RRGGBBAA'` ([Colors](./messages.md#colors)) |
| arrays of these     | arrays                                                            |

## Registering the class

```ts
const [players$, registerPlayer] = RegisterModelSync<Player>({ name: 'player', type: Player });
```

`name` is the channel the objects sync on. All clients that sync these objects, web and Unity, must use the same
name.

:::warning[Always pass name]
Without `name`, the channel is the class name in lower case. A minified production build renames your classes, so
two builds of your app, or a minified build and Unity, stop syncing without an error. Colibri warns only if the class
name looks minified (two characters or fewer, or with a `$` in it).
:::

Call `RegisterModelSync` once per channel, e.g. at the top level of a module, and share what it returns. In React,
do not call it inside a component, which runs on every render ([Limitations](#limitations)).

## Syncing with Unity's SyncBehaviour

To sync with a Unity [`SyncBehaviour`](../unity/syncbehaviour.md):

- Set `name` to the Unity class name in lower case, e.g. `'player'` for the Unity class `Player`.
- If the Unity component has a `ModelId`, add `_<ModelId>`, e.g. `'player_Red'` for the `ModelId` `Red`.
- Property names are compared in lower case, so `@Synced() accessor score` matches Unity's `[Sync] public int Score`.
- A property that the other side has, but your class does not declare, is ignored with the console warning
  `Unknown property <property> in <class>`. Add it to your class, or check the spelling.

The Unity `Player` from the [Unity documentation](../unity/syncbehaviour.md) and the web `Player` above sync with
each other.

## The list of objects

The Observable that `RegisterModelSync` returns (`players$` above) lists all synchronized objects of the class: the
ones this client registered and the ones from other clients.

- It emits the current list right away when you subscribe.
- It emits again when an object is added or deleted, or when another client changes one.
- The objects in the list are live: their properties always have the latest values.

To change an object from another client, assign a new value to a synced property. Colibri sends it to all other
clients:

```ts
let players: Player[] = [];
players$.subscribe(list => {
    players = list;
});

// Call this e.g. when a button is clicked.
function addPoint(playerId: string) {
    const player = players.find(p => p.id === playerId);
    if (player) {
        player.score += 1;
    }
}
```

:::warning
Do not change synced properties inside the `subscribe` callback itself. A change can make the list emit again, which
runs your callback again.
:::

:::tip
Assign a new value to send a change. Changing an array or object in place, e.g. `me.items.push(item)`, is not
noticed. Assign a new array instead: `me.items = [...me.items, item]`.
:::

## Registering instances

A new object is not synchronized until you register it:

```ts
const me = new Player('player-alex'); // not synchronized yet
registerPlayer(me); // synchronized with the other clients from now on
```

The id identifies the object on every client and must be unique. Use a fixed id, e.g. the participant's id in a study,
if the object should keep its values when the page is reloaded.

When you register an object, Colibri first asks the server for an object with the same id:

- **If the server has one**, its values replace the values of your new object. This happens if another client created
  it, or if this page created it and was reloaded while another client stayed connected. Changes you make after
  `registerPlayer` are sent on top and kept.
- **Otherwise**, your object is sent in full.

Your object is in the list right away, with the values from its constructor. The server's values arrive a moment
later, so a UI bound to the list may briefly show the defaults.

If the list already has an object with the same id, e.g. a copy from the server, your object replaces it. The old one
stops syncing. If it was registered by this client too, Colibri warns. Registering the same object again does
nothing.

You may call `RegisterModelSync` and register objects before `new Colibri()`. Colibri syncs them once the client
exists.

## Reconnects

When the connection drops, Colibri reconnects by itself and catches up: it asks the server for all objects again
and applies what changed during the outage. You do not have to do anything.

- **Changes during the outage:** changes you make while disconnected are sent after the reconnect.
- **The server forgets objects.** The server keeps synchronized objects in memory only, per app name. It forgets them
  when it restarts and when the last client of the app disconnects, for example during an outage of a lone client.
  After the reconnect, your client sends the objects it registered again. Objects of other clients come back only
  from a client that still has them.
- **Deleted objects:** if another client deleted an object while you were disconnected, it disappears after the
  reconnect only if your client registered it and the delete is at most 10 minutes old (the server setting
  `MODEL_TOMBSTONE_SECONDS`, see the [server configuration](../server/configuration.md)). Other objects stay in the list.

### Changes lost in a dropped connection

A connection that dies without closing, e.g. when Wi-Fi drops out, is noticed only after up to about 45 seconds.
Changes sent in this time never reach the server.

Colibri recognizes most of these lost changes after the reconnect: if the server shows a property with a value it had
on this client in the 10 seconds before the drop, Colibri keeps your newer value and sends it again. A value your
client never had comes from another client and is applied.

This does not cover every case:

- Lost changes are sent again only for objects this client registered. For other objects, the server's value wins.
- A property that changed very often just before the drop, more than about 8 times within a tenth of a second, e.g.
  during a fast drag on a slow connection, may not be recognized. The server's value is then applied.
- If another client sets a property back to a value it had on this client in the 10 seconds before the drop, this
  looks like a lost change, and your value replaces it.

## Limitations

- **No delete for other clients.** The web client cannot delete an object for the other clients. `delete()` only
  stops syncing it on this client. The object stays on the server and on all other clients. An object that another
  client, such as Unity, deletes disappears from your list.
- **One `RegisterModelSync` per channel.** Two `RegisterModelSync` calls with the same `name` on one page do not see
  each other's changes. Call it once per channel and share what it returns.
- **Not stored permanently.** The server forgets synchronized objects when it restarts or when the last client of the
  app disconnects. For values that must last, use the [data store](./data-store.md).
- **Change from one client at a time.** If two clients change the same property at the same moment, the last change
  to reach the server wins.
