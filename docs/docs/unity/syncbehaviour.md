---
sidebar_position: 5
title: SyncBehaviour
---

# SyncBehaviour

`SyncBehaviour` synchronizes the fields and properties of your own scripts between clients, e.g. a score, a
selection or the state of an experiment. Like [SyncTransform](./synctransform.md), it also creates and deletes the
objects on the other clients, and clients that join later get the current state. It suits data models, e.g. in a
model-view-controller architecture.

The SyncBehaviour sample shows a model with several synchronized members.

## Example: player scores

```csharp
using HCIKonstanz.Colibri.Synchronization;

public class Player : SyncBehaviour<Player>
{
    [Sync]
    public int Score;

    // Awake and OnDestroy must be overridden and call the base method.
    // With a plain `void Awake()` the object never syncs.
    protected override void Awake()
    {
        base.Awake();
        // your code
    }

    // Without base.OnDestroy(), destroying the object does not delete it on the other clients.
    protected override void OnDestroy()
    {
        base.OnDestroy();
        // your code
    }
}
```

```csharp
using HCIKonstanz.Colibri.Synchronization;

public class PlayerManager : SyncBehaviourManager<Player>
{
}
```

`Player` inherits from `SyncBehaviour<Player>` instead of `MonoBehaviour`. `[Sync]` marks `Score` for syncing: when
one client changes it, it changes on all other clients. Colibri checks the `[Sync]` members for changes every
frame, so a plain assignment such as `Score += 10;` is enough. `PlayerManager` needs no code. When another client
creates a `Player`, the manager creates the copy on this client from its `Template`.

## Setting up

1. Write the model script. It inherits from `SyncBehaviour<T>`, where `T` is the class itself, e.g.
   `Player : SyncBehaviour<Player>`.
2. Write the manager script. It inherits from `SyncBehaviourManager<T>` with the same `T` and needs no code. If it
   needs `Start`, `OnEnable` or `OnDestroy`, override them and call the base method, e.g.
   `protected override void Start() { base.Start(); … }`.
3. Make a prefab with the model script.
4. Add the manager script to the scene, e.g. on an empty GameObject, and set its `Template` to the prefab.

For objects placed in the scene, give each one a fixed `Id` in the Inspector, e.g. `player-1`. All clients must load
the object with the same `Id`. An object with an empty `Id` gets a new random `Id` when it starts. That is right for
objects you create at runtime with `Instantiate`, but not for placed objects: each client would have its own object.

- The `Template` can also be an inactive object in the scene. An active one would sync as an object of its own.
- The manager creates the copies at the top level of the scene hierarchy. It activates each copy, so the copy runs
  `Awake`, and then applies the synchronized values.
- An object can have more than one synced component, e.g. a `SyncTransform` on the head and on each hand of an
  avatar. Leave their `Id` empty. The components on the object's top GameObject share its `Id`, and a component on a
  child adds its path, e.g. `<Id>/LeftHand`. Set the manager's `Template` to a component on the top GameObject.
- Without a matching manager in the scene, the console warns
  `No generic Colibri SyncManager found (without ModelId) - synchronization of newly created objects may be restricted`.
- By the way: `SyncTransform` is also a `SyncBehaviour`, and `[SyncTransformManager]` is its manager.

## Sync members

`[Sync]` marks fields and properties to synchronize. They can be public or private:

```csharp
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class MyClass : SyncBehaviour<MyClass>
{
    [Sync]
    public string MyString = "123";

    [Sync]
    private Vector3 Position
    {
        get { return transform.localPosition; }
        set { transform.localPosition = value; }
    }
}
```

- Supported types: `bool`, `int`, `float`, `string`, `Vector2`, `Vector3`, `Quaternion`, `Color`, `JObject` and
  arrays of these, except `JObject`.
- A property needs both a getter and a setter. A field must not be `readonly`.
- Member names are compared without regard to case. Two `[Sync]` members whose names differ only in case are an
  error.
- To sync an object of your own class, sync a `JObject`. Convert with
  `JObject.FromObject(value, ColibriJson.Serializer)` and back with `ToObject<MyType>(ColibriJson.Serializer)`. See
  [Sending other types as JSON](./messages.md#sending-other-types-as-json).
- An array or `JObject` is compared by its contents: changing an element in place is sent, and assigning an equal
  one is not. A `Color` is compared as it is sent, with 8 bits a channel.
- A member with an unsupported type, or one that breaks these rules, is reported at startup:
  `Colibri: cannot synchronize '<class>.<member>' …`. Follow the message.

:::tip
On IL2CPP builds, e.g. for Meta Quest, Colibri reads `[Sync]` fields with reflection, which allocates memory every
frame for value types such as `int` or `Vector3`. Properties do not. With many synchronized objects, use properties,
as `SyncTransform` does.
:::

## Awake and OnDestroy

A `SyncBehaviour` registers in `Awake` and unregisters in `OnDestroy`. To use these methods in your script, override
them and call the base method, as in the [example](#example-player-scores).

A plain `void Awake()` or `void OnDestroy()` hides the base method. Only the compiler warning CS0114 reports it.
Without `base.Awake()`, the object never syncs. Without `base.OnDestroy()`, destroying it does not delete it on the
other clients.

`base.Awake()` reads every `[Sync]` member once:

- Set up whatever your `[Sync]` getters read, such as a cached component, before `base.Awake()`.
- On objects placed in the scene or created on this client, a `[Sync]` member set after `base.Awake()` counts as a
  change ([Server state](#server-state)). To take the server's state instead, set initial values before
  `base.Awake()` or in the Inspector.
- A copy that a manager creates for another client's object takes the values of that object, whatever its `Awake`
  sets.

```csharp
protected override void Awake()
{
    // set up what your [Sync] getters read, such as a cached component
    myRenderer = GetComponent<Renderer>();
    base.Awake();
    // your code
}
```

## ModelId

A manager creates every object of its type from its one `Template`. For two different prefabs of the same type,
e.g. a red and a blue `Player` prefab, give each prefab its own `ModelId` and add one manager per prefab, each with
its prefab as `Template`. Objects with a `ModelId` are handled only by the manager whose `Template` has the same
`ModelId`. If two managers handle the same `ModelId`, the console warns
`Warning: Multiple instances of '…' detected with overlapping ModelID. …`.

## ModelCreated and ModelDestroyed

`SyncBehaviour<T>.ModelCreated` and `SyncBehaviour<T>.ModelDestroyed` are events raised when an object of type `T`
starts (`Awake`) and is destroyed. They cover objects placed in the scene, objects created on this client and copies
created by the manager. Subscribe with `+=` and unsubscribe with `-=`, e.g. to keep a list of all players:

```csharp
using System.Collections.Generic;
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Scoreboard : MonoBehaviour
{
    private readonly List<Player> players = new List<Player>();

    private void OnEnable()
    {
        SyncBehaviour<Player>.ModelCreated += OnPlayerCreated;
        SyncBehaviour<Player>.ModelDestroyed += OnPlayerDestroyed;
    }

    // Without -=, Colibri keeps calling the handlers of a destroyed Scoreboard.
    private void OnDisable()
    {
        SyncBehaviour<Player>.ModelCreated -= OnPlayerCreated;
        SyncBehaviour<Player>.ModelDestroyed -= OnPlayerDestroyed;
    }

    private void OnPlayerCreated(SyncBehaviour<Player> model)
    {
        players.Add((Player)model);
    }

    private void OnPlayerDestroyed(SyncBehaviour<Player> model)
    {
        players.Remove((Player)model);
    }
}
```

`ModelCreated` is raised before a copy receives the values of the other client's object. Read the values later,
e.g. in `Update`.

## Server state

The server stores each object's state and sends it to clients that join later. When the app's last client
disconnects, the server discards the state.

- An object asks the server for its state in `Awake` and gets it a round trip later, or once connected.
- Members changed before the answer arrives, e.g. in `Start`, keep their values. These replace the server's values
  on the server and on all other clients.
- All other members take the server's values, not the values from the scene or prefab.
- So a script that changes a `[Sync]` member in `Start` changes it for everyone whenever a client starts. Set
  starting values in the scene or prefab instead.

### After a reconnect

After the connection drops and comes back, each object asks the server for its state again to get the changes made
meanwhile.

- Changes made by other clients during the outage are applied. So are deletes.
- Changes made on this client during the outage are sent after the reconnect.
- If the server forgot the object, because it restarted or the app's last client disconnected, the client sends
  the object's full state again. A single client whose connection drops is the app's last client.
- A change or delete made just as the connection drops can get lost. Colibri notices this after the reconnect in
  most cases and sends it again, once.

:::note
The server remembers deletes for 10 minutes by default. If another client deleted an object longer ago while this
client was away, this client creates the object again.
:::

## Send rate

A synchronized object (`SyncTransform` or any other `SyncBehaviour`) sends at most 30 updates per second by
default. Without a limit, a moving object sends in every frame, 72 to 120 times per second on a headset. Dozens of
headsets at that rate overload a server and a Wi-Fi network.

- A single change is sent in the frame in which it is made.
- Faster changes are collected. Their latest values are sent together when the interval (1/30 s) ends.
- Values in between are never sent, so a `[Sync]` setter on another client does not see every value. Use
  [messages](./messages.md) for events that must all arrive.
- `SetActive` and destroying an object are sent at once.
- Pending changes are sent at once when the app pauses or loses focus, e.g. on a Quest when the headset is taken
  off, the system menu opens or the user leaves the app.
- When the app quits or Play mode ends, Colibri tries to send pending changes, but the connection closes at the same
  time.
- A value from another client replaces a pending local change of the same member, so all copies end up with the
  same value.

Change the limit in *Window → Colibri Configuration → Optional Config → Max Send Rate (Hz)*, or at runtime:

```csharp
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class FastSync : MonoBehaviour
{
    void Start()
    {
        SyncSettings.MaxSendRate = 60; // updates per second per synchronized object; 0 = no limit
    }
}
```

- A value set in code applies until the app quits or Play mode ends. It does not change the configuration.
- A negative value throws an `ArgumentOutOfRangeException`.
- `0` turns the limit off: an object sends an update in every frame in which it changes.

## Web clients

`SyncModel` is the web counterpart of `SyncBehaviour`, and both sync with each other. On the web, use the Unity
class name in lower case as the model name, e.g. `'player'` for `Player`, plus `_<ModelId>` if the `ModelId` is set.
Member names are compared in lower case, so `score` on the web matches `Score` in Unity. See
[SyncModel](../web/syncmodel.md).

## Limitations

- Update each member from one client at a time. Concurrent updates from several clients make it jump between their
  values.
- The server discards all objects when the app's last client disconnects. Use the [data store](./data-store.md)
  for data that must outlive a session.
- Values between two updates are not sent ([Send rate](#send-rate)).
