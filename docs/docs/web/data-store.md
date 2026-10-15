---
sidebar_position: 6
title: Data Store
---

# Data Store

The data store keeps small amounts of data on the server, e.g. the color a player selected, the settings of a game
or the condition of a study. Unlike messages and synchronized objects, the data stays saved after all clients
disconnect, and also when the server restarts.

## Example: the player's color

```ts
import { GetRestApi, PutRestApi, toHexColor, toRgbaColor } from '@hcikn/colibri';

const playerName = 'Alex';
const avatar = document.getElementById('avatar')!;

async function loadColor() {
    const color = await GetRestApi(`color-${playerName}`);
    if (color) {
        avatar.style.backgroundColor = toHexColor(color);
    }
}

// Call this when the player selects a color, e.g. '#ff0000ff'.
async function selectColor(color: string) {
    avatar.style.backgroundColor = color;
    await PutRestApi(`color-${playerName}`, toRgbaColor(color));
}
```

`selectColor` colors the player's avatar and saves the color on the server under the name `color-<player name>`.
`loadColor` loads the saved color, so the player gets their color back in the next session. `GetRestApi` returns
`null` if the player has not selected a color yet. The color is saved as `[r, g, b, a]`, the format Unity uses, so
the same value also works in the `PlayerColor` sample of the [Unity data store](../unity/data-store.md). Other
clients see a new value the next time they call `GetRestApi`. It is not sent to them automatically.

- Values are saved per app name. Each value can be up to 5 MiB.
- Any JSON value works, e.g. an object, an array, a number or a string.
- Create the `Colibri` instance first. Without it, both functions return `undefined`.

Runnable sample: [rest-api](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/rest-api.ts)
(`npm run samples/rest-api`, see [Samples](./installation.md#samples)).

:::tip
To tell other clients that a value changed, send a [message](./messages.md) after saving it. They can then load
the new value.
:::

## Functions

You can use the data store through the `Colibri` instance or through wrapper functions. Both do the same:

| On the `Colibri` instance       | Wrapper function          | Does                        | Resolves to                                                    |
| ------------------------------- | ------------------------- | --------------------------- | -------------------------------------------------------------- |
| `getRestObject(key)`            | `GetRestApi(key)`         | Loads the value under `key` | The value, or `null` if there is none                          |
| `setRestObject(key, value)`     | `PutRestApi(key, value)`  | Saves or replaces the value | `true` if the server saved it, otherwise `false`               |
| `deleteRestObject(key)`         | `DeleteRestApi(key)`      | Deletes the value           | `true` if the server deleted it, `false` if there was no value |

The wrapper functions return `undefined`, with the console warning `Colibri not initialized yet! (Instance is null)`,
if there is no `Colibri` instance yet.

```ts
import { Colibri, DeleteRestApi, GetRestApi, PutRestApi } from '@hcikn/colibri';

const key = 'settings';
const data = { condition: 'B', rounds: 5 };

// through the Colibri instance
const colibri = Colibri.getInstance();
if (colibri) {
    await colibri.setRestObject(key, data); // true if stored
    const stored = await colibri.getRestObject(key); // null if nothing is stored under key
    await colibri.deleteRestObject(key); // true if deleted
}

// or through the wrapper functions
await PutRestApi(key, data);
const stored = await GetRestApi(key);
await DeleteRestApi(key);
```

## Values

- A value is any JSON value up to 5 MiB: an object, an array, a number, a string, a boolean or `null`.
- `undefined` is not JSON. `setRestObject(key, undefined)` stores nothing.
- A saved `null` and a missing value look the same: `getRestObject` returns `null` for both.
- Values are saved per app name. Clients with another app name cannot read them.
- Saving replaces the whole value. To change one field of a saved object, load it, change the field and save it
  again.

## Errors

- `getRestObject` returns `null` if there is no value under the key, or if the server answered with an error.
- `setRestObject` returns `false` if the server did not save the value, e.g. because it is larger than 5 MiB.
- `deleteRestObject` returns `false` if there was no value to delete.
- All three throw (the promise rejects, usually with a `TypeError`) if the server cannot be reached: a wrong address,
  the server is down, no network, or a page on `https://` that connects with `http://`
  ([TLS](./configuration.md#tls)). `setRestObject` also throws for a value that cannot be turned into JSON, such as
  an object that refers to itself.

Catch these errors where they matter:

```ts
try {
    const settings = await GetRestApi('settings');
} catch (error) {
    console.error('Could not reach the Colibri server', error);
}
```

## Keys

- Any text works as a key, including `/`, `#`, `?`, `%` and spaces.
- Spaces at the start and end of a key, and slashes at its start, are removed: `' /color '` is the same key as
  `'color'`.
- An empty key, `.` or `..` stores and finds nothing: `setRestObject` returns `false`, `getRestObject` returns `null`.

## Sharing values with Unity

Unity reads and writes the same values with its `Store` ([Unity data store](../unity/data-store.md)). A key addresses
the same value on both sides, as long as the app names match.

- Unity saves colors as `[r, g, b, a]`. Read them with `toHexColor` or `toRgbaColor`, as in the
  [example](#example-the-players-color).
- Unity saves `Vector2` as `[x, y]`, `Vector3` as `[x, y, z]` and `Quaternion` as `[x, y, z, w]`, the same as the web
  client uses. Values that Unity saved with Colibri 1 may have them as objects, e.g. `{ x: 1, y: 2, z: 3 }`.
- A Unity class is saved as a JSON object with its public fields and properties as keys.
- Unity also reads colors that the web saved as `'#RRGGBBAA'`.
