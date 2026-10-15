---
sidebar_position: 3
title: Send/Receive Messages
---

# Send/Receive Messages

Messages send events and commands from one client to all other clients of your app, e.g. "start the next round",
"the user selected object 3" or "show the questionnaire". Each message has a channel name and a value. Clients
receive the messages of every channel they listen to.

Messages are not stored. A client receives only the messages that arrive while it listens. To keep a state that
clients joining later also get, use [SyncBehaviour](./syncbehaviour.md) or the [data store](./data-store.md).

## Sending

`Sync.Send` sends a value on a channel, from anywhere in your code:

```csharp
float myNumber = 5f;
Sync.Send("myChannel", myNumber);
```

The server forwards the message to all other clients with the same app name, web and Unity. The sender itself does
not receive it.

## Receiving

`Sync.Receive` registers a listener for a channel and a type:

```csharp
void Start()
{
    Sync.Receive<float>("myChannel", OnMyChannel);
}

private void OnMyChannel(float myNumber)
{
    // This code is executed whenever
    // a float is received on "myChannel"
}
```

Colibri calls listeners on the main thread, so you can use any Unity API in them.

## Example: starting a game round

```csharp
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class RoundControl : MonoBehaviour
{
    // Register before anything is sent. Messages without a listener are dropped.
    void Start()
    {
        Sync.Receive<int>("startRound", OnStartRound);
    }

    void OnStartRound(int round)
    {
        Debug.Log($"Round {round} starts");
        // reset the scores, start the timer, ...
    }

    // Reaches all other clients with the same app name, not this one.
    public void StartRound(int round)
    {
        Sync.Send("startRound", round);
        OnStartRound(round);
    }
}
```

In `Start`, the script listens on the channel `startRound` for `int` values. One player calls `StartRound`, e.g. from
a UI button, which sends the round number to all other clients. On each of them, Colibri calls `OnStartRound`, which
starts the round. A client does not receive its own messages, so `StartRound` also calls `OnStartRound` directly to
start the round on the sending client too.

## Rules

- Channel and type must match on both sides. A `float` sent on `myChannel` reaches only listeners registered with
  `Sync.Receive<float>("myChannel", …)`. See [Type mismatches](#type-mismatches).
- Register the listener before anything is sent. Messages that arrive while nobody listens are lost.
- A client never receives its own messages.
- Several listeners can listen on the same channel, also for different types.
- Messages from one client arrive in the order it sent them.

## Supported types

`bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color` and arrays of these, e.g. `int[]` or
`Vector3[]`. For anything else, send JSON as described below.

A `Sync.Receive` with any other type logs an error that names the supported types:
`Colibri: cannot receive '<type>' on channel '<channel>' - supported types are …`.

## Sending other types as JSON

To send other data, send a `JToken` from Newtonsoft JSON, e.g. a `JObject`, and receive it as `JToken`:

```csharp
using HCIKonstanz.Colibri.Synchronization;
using Newtonsoft.Json.Linq;
using UnityEngine;

public class JsonExample : MonoBehaviour
{
    void Start()
    {
        Sync.Receive<JToken>("myJson", OnMyJson);
    }

    public void SendExample()
    {
        Sync.Send("myJson", new JObject
        {
            { "attribute1", "example" },
            { "attribute2", 5 }
        });
    }

    private void OnMyJson(JToken jtoken)
    {
        string attribute1 = jtoken["attribute1"].Value<string>();
        int attribute2 = jtoken["attribute2"].Value<int>();
    }
}
```

### Your own classes

Newtonsoft JSON converts your own classes, with or without `[Serializable]`. It sends their public fields and
properties:

```csharp
public class ExampleClass
{
    public int Id;
    public string Name;
}
```

```csharp
public void SendExample()
{
    ExampleClass exampleObject = new ExampleClass { Id = 1234, Name = "Charly Sharp" };
    Sync.Send("example", JToken.FromObject(exampleObject));
}

private void OnExample(JToken jtoken)
{
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>();
}
```

Newtonsoft JSON cannot convert a `Vector3`, `Quaternion` or `Color` inside your class. `JToken.FromObject` then
throws a `JsonSerializationException`, for a `Vector3` with the message
`Self referencing loop detected for property 'normalized'`. Pass `ColibriJson.Serializer` on both sides. It converts
`Vector2`, `Vector3`, `Vector4`, `Quaternion` and `Color` to arrays of their components and back:

```csharp
using HCIKonstanz.Colibri.Synchronization; // ColibriJson

public void SendExample(ExampleClass exampleObject)
{
    Sync.Send("example", JToken.FromObject(exampleObject, ColibriJson.Serializer));
}

private void OnExample(JToken jtoken)
{
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>(ColibriJson.Serializer);
}
```

Or build the `JObject` yourself with Colibri's conversion methods `ToJson()`, `ToVector2()`, `ToVector3()`,
`ToQuaternion()` and `ToColor()`:

```csharp
using HCIKonstanz.Colibri.Synchronization; // ToJson(), ToVector3(), ...

public void Spawn()
{
    Sync.Send("spawn", new JObject
    {
        { "Id", 1234 },
        { "Position", transform.position.ToJson() }
    });
}

private void OnSpawn(JToken jtoken)
{
    Vector3 position = jtoken["Position"].ToVector3();
}
```

A `Vector3`, `Quaternion` or `Color` that you send directly with `Sync.Send` needs none of this. Colibri converts
it.

:::note
On IL2CPP builds with a *Managed Stripping Level* above *Minimal*, Unity may remove members of classes that only
Newtonsoft JSON uses. See [Meta Quest and Android](./configuration.md#meta-quest-and-android).
:::

## Removing listeners

Listeners that are methods of a `MonoBehaviour` script are removed automatically when the script or its
GameObject is destroyed. Colibri never calls a listener of a destroyed object.

Disabling a script does not remove its listeners. To stop listening while the object lives on, call
`Sync.Unregister` with the same channel, type and method:

```csharp
void OnEnable()
{
    Sync.Receive<float>("myChannel", OnMyChannel);
}

void OnDisable()
{
    Sync.Unregister<float>("myChannel", OnMyChannel);
}
```

Colibri cannot tell when `static` methods and methods of plain C# objects (classes that are not a Unity object) are
no longer needed. Remove such listeners with `Sync.Unregister`.

If a listener throws an exception, Colibri logs it and still calls the other listeners of the message.

## Type mismatches

When a message arrives on a channel whose listeners expect a different type, Colibri drops it and warns once per
channel and type:

```
Colibri: a float arrived on channel 'chat', but the listener registered there expects string. The message was dropped, …
```

Send and receive the same type on a channel. Channels on which this client has no listener at all are ignored
without a warning, because every client receives all messages of its app.

## Messages from web clients

Web clients use the same channels and types, so Unity and web clients can exchange messages. See
[Send/Receive Messages](../web/messages.md) for the web side.

- JavaScript has only one number type, so web clients send every number as `float`, also with `sendInt`. Receive
  numbers from web clients with `Sync.Receive<float>`, not `Sync.Receive<int>`.
- Web clients may send a color as `[r, g, b, a]`. A `Color` listener in Unity accepts this too.

## Connection and outages

Colibri connects to the server when your code first calls `Sync.Send` or `Sync.Receive`, or when a
[SyncBehaviour](./syncbehaviour.md) starts. If the connection drops, Colibri reconnects by itself, first after
0.5 s, then with growing delays up to 10 s.

Messages sent while the connection is down are kept and sent in order after the reconnect:

- Colibri keeps up to 256 messages. Beyond that, it drops the oldest and warns once per outage:
  `Colibri: more than 256 messages are waiting for the connection to come back, so the oldest are being dropped.`
- Changes of synchronized objects do not count toward the 256. Changes of one object are merged into one update.
- In total, at most 10 000 messages wait, also on a network too slow for the traffic. Beyond that, Colibri drops
  the oldest messages first, then the oldest changes of synchronized objects, and warns once per connection:
  `Colibri: more than 10000 messages are waiting to be sent…`.

Received messages are handed to your listeners in `Update`. While the app is paused, e.g. a Quest with the headset
taken off, or an Editor in the background without [Run In Background](./configuration.md#run-in-background), they
wait. Colibri keeps reading them meanwhile, so the server keeps the client connected.

- Beyond 1000 waiting messages, Colibri merges the updates of each synchronized object, so your code sees only the
  newest state of each object for that time.
- Beyond 10 000, it drops the oldest messages first.
- The console warns once per connection: `Colibri: … received messages waited for Update, which did not run for a while…`.

To show the connection state in your app, see [Connection state in code](./troubleshooting.md#connection-state-in-code).

:::note
By default, the server accepts up to 1000 messages and object updates per second from one client, with short bursts
of up to 2000. Beyond that, it drops the client's messages and delays its object updates. This only catches runaway send loops, e.g.
`Sync.Send` in every `Update` of many objects. See the server's [configuration](../server/configuration.md).
:::
