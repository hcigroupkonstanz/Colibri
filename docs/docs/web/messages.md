---
sidebar_position: 3
title: Send/Receive Messages
---

# Send/Receive Messages

Messages tell the other clients that something happened, e.g. that a round starts, a button was pressed or a
participant finished a task. Each message has a channel name and a value. Every client of the app that listens on
the channel receives it, web and Unity alike. Messages are not stored: for values that should last, use
[synchronized objects](./syncmodel.md) or the [data store](./data-store.md).

## Sending and receiving

For sending simple messages of events and commands you can use `Sync.send*`. Each message has a channel name.

```ts
const myNumber = 5;
Sync.sendNumber('myChannel', myNumber);
```

A client receives the messages of every channel it listens to:

```ts
function onMyChannel(myNumber: number) {
    // This code is executed whenever
    // a number is received on 'myChannel'
}

Sync.receiveNumber('myChannel', onMyChannel);
```

## Example: starting a game round

```ts
import { Sync } from '@hcikn/colibri';

function onStartRound(round: number) {
    console.log(`Round ${round} starts`);
    // reset the scores, start the timer, ...
}

// Register before anything is sent. Messages without a listener are dropped.
Sync.receiveNumber('startRound', onStartRound);

// Reaches all other clients with the same app name, not this one.
export function startRound(round: number) {
    Sync.sendNumber('startRound', round);
    onStartRound(round);
}
```

The script listens on the channel `startRound` for numbers. One player calls `startRound`, e.g. from a button,
which sends the round number to all other clients, web and Unity. On each of them, Colibri calls `onStartRound`,
which starts the round. A client does not receive its own messages, so `startRound` also calls `onStartRound`
directly to start the round on the sending client too.

:::note
The [Unity version](../unity/messages.md) of this example receives the round as `int`. A web client sends every
number as `float`, so to combine the two, the Unity script must listen with `Sync.Receive<float>`
([Numbers](#numbers)).
:::

- Channel and type must match on both sides.
- A listener stays registered until `Sync.unregister`.

Runnable sample: [broadcast](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/broadcast.ts)
(`npm run samples/broadcast`, see [Samples](./installation.md#samples)).

## Types

| Type in Unity | Send             | Receive             | Value                                                  |
| ------------- | ---------------- | ------------------- | ------------------------------------------------------ |
| `bool`        | `sendBool`       | `receiveBool`       | `boolean`                                              |
| `int`, `float` | `sendNumber`    | `receiveNumber`     | `number`                                               |
| `string`      | `sendString`     | `receiveString`     | `string`                                               |
| `Vector2`     | `sendVector2`    | `receiveVector2`    | `[x, y]`                                               |
| `Vector3`     | `sendVector3`    | `receiveVector3`    | `[x, y, z]`                                            |
| `Quaternion`  | `sendQuaternion` | `receiveQuaternion` | `[x, y, z, w]`                                         |
| `Color`       | `sendColor`      | `receiveColor`      | `ColorValue`: `[r, g, b, a]`, each 0 to 1, or `'#RRGGBBAA'` ([Colors](#colors)) |
| JSON          | `sendJson`       | `receiveJson`       | an object, such as `{ name: 'Alex', score: 3 }`        |

Each type except JSON also has an array form, which sends and receives an array of the values:

| Send                  | Receive                  | Value                 |
| --------------------- | ------------------------ | --------------------- |
| `sendBoolArray`       | `receiveBoolArray`       | `boolean[]`           |
| `sendNumberArray`     | `receiveNumberArray`     | `number[]`            |
| `sendStringArray`     | `receiveStringArray`     | `string[]`            |
| `sendVector2Array`    | `receiveVector2Array`    | `[x, y][]`            |
| `sendVector3Array`    | `receiveVector3Array`    | `[x, y, z][]`         |
| `sendQuaternionArray` | `receiveQuaternionArray` | `[x, y, z, w][]`      |
| `sendColorArray`      | `receiveColorArray`      | `ColorValue[]`        |

```ts
Sync.sendVector3Array('path', [
    [0, 0, 0],
    [1, 0, 2]
]);
Sync.receiveVector3Array('path', points => console.log(`${points.length} points`));
```

`sendJson` sends an object. To send a list of objects, wrap it in an object:

```ts
Sync.sendJson('answers', { items: [{ question: 1, answer: 'yes' }] });
```

Unity uses its own types for vectors, quaternions and colors. On the web they are arrays.

### Numbers

JavaScript has only one number type, so every number is sent as `float`. Unity must receive it with
`Sync.Receive<float>`, not `Sync.Receive<int>`. A Unity listener for `int` never gets numbers from a web client.

`sendInt` and `sendFloat` are other names for `sendNumber`, named after Unity's types. `sendIntArray` and
`sendFloatArray` are other names for `sendNumberArray`. They also send `float`.

The other way round works: `receiveNumber` and `receiveNumberArray` receive both `int` and `float` from Unity.

### Colors

Unity sends a color as the text `'#RRGGBBAA'`, the web client as `[r, g, b, a]` with each part from 0 to 1. A
`receiveColor` listener gets either form, typed `ColorValue`. Convert it to the form you need with `toHexColor` or
`toRgbaColor`:

```ts
import { Sync, toHexColor, toRgbaColor } from '@hcikn/colibri';

Sync.receiveColor('myChannel', color => {
    element.style.background = toHexColor(color); // '#ff0000ff', whoever sent it
    const [r, g, b, a] = toRgbaColor(color); // ...or 0-1 components
});
```

- `toHexColor` returns `'#rrggbbaa'`, which CSS understands.
- `toRgbaColor` returns `[r, g, b, a]`, each from 0 to 1. It also reads the short forms `'#RGB'` and `'#RGBA'`, and
  `'#RRGGBB'` without alpha.
- For a value that is not a color, both warn in the console and return opaque black instead of throwing.

`sendColor` takes both forms, so `Sync.sendColor('tint', '#ff0000ff')` and `Sync.sendColor('tint', [1, 0, 0, 1])`
send the same color.

## Registering and unregistering

You may register listeners before `new Colibri()`. They start receiving once the client exists. A `Sync.send*`
call before `new Colibri()` is dropped with the console warning `Colibri not initialized yet! (Instance is null)`.

A listener stays registered until you remove it with `Sync.unregister`. Pass the same function you registered:

```ts
import { Sync } from '@hcikn/colibri';

const onValue = (value: boolean) => {
    // called for every bool received on 'myChannel'
};

Sync.receiveBool('myChannel', onValue);
Sync.unregister('myChannel', onValue);
```

:::tip
To remove a listener later, keep it in a variable, as above. A function written directly in the
`receive*` call cannot be unregistered.
:::

## Limitations

- **Messages are not stored.** The server passes them on and forgets them. A client receives only what is sent while
  its listener is registered and it is connected. A client that joins later, or reconnects, misses earlier messages.
  For a state that late joiners need, use [synchronized objects](./syncmodel.md) or the
  [data store](./data-store.md).
- **Not to the sender.** A message reaches the other clients of the app, not the client that sent it.
- **Channel and type must match.** A `sendString` on `myChannel` does not reach a `receiveNumber` on `myChannel`.
- **Do not send in every frame.** By default, the server accepts up to 1000 messages and object updates per second
  from one client, with short bursts of up to 2000. Above that, it drops the client's messages and delays its object
  updates. The latest value of every synchronized property still arrives. The server's log then shows a warning that names
  the client. This limit catches send loops that run out of control, e.g. a `Sync.send*` in every
  `requestAnimationFrame`. The server's administrator can change it ([server configuration](../server/configuration.md)).
