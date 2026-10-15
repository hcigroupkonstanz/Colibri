---
sidebar_position: 4
title: SyncTransform
---

# SyncTransform

`SyncTransform` keeps the position, rotation, scale and visibility of an object the same on all clients, without
any code, e.g. for a shared 3D object that one user moves and all others see. Clients that join later get the
current state. When one client creates or destroys the object, it is also created or destroyed on the other
clients.

The SyncTransform sample shows objects placed in the scene and objects created at runtime.

## Getting started

1. Add the `SyncTransform` component to a GameObject in your scene.
2. Click *Generate ID* in the `SyncTransform`'s Inspector. The `Id` connects the object to its copies on the other
   clients, so every client must load the object with the same `Id`.
3. Add the `[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/` to the scene once. For objects placed
   in the scene, it needs no `Template`.

Now, when you move, rotate, scale, hide or show the object on one client, it changes on all other clients too.

:::warning
An object placed in the scene with an empty `Id` gets a new random `Id` each time a client starts. Each client then
has its own object, and they do not sync. If you duplicate an object, the copy keeps the same `Id`. The console
then warns `Scene contains multiple overlapping SyncTransform IDs!`. Click *Generate ID* on the copy.
:::

Without a manager in the scene, the console warns
`No generic Colibri SyncManager found (without ModelId) - synchronization of newly created objects may be restricted`.
The manager makes sure the server has the full state of each object, so that clients joining later get it.

## What is synchronized

| Setting | Default | Description |
|---|---|---|
| `SyncActive` | on | Sync whether the object is active (`activeSelf`) |
| `SyncPosition` | on | Sync the position |
| `SyncRotation` | on | Sync the rotation |
| `SyncScale` | on | Sync the scale (always `localScale`) |
| `UseLocalTransform` | off | Sync `localPosition` and `localRotation` instead of `position` and `rotation`, e.g. for an object whose parent is placed differently on each client |

A switched-off value stays local. The client neither sends it nor applies it.

## Server state and late joiners

The server stores the state of each object and sends it to clients that join later. When the app's last client
disconnects, the server discards the state, so the next session starts with the scene as you built it.

When a client starts, each object asks the server for its state:

- Values the client changes before the answer arrives, e.g. in `Start`, keep their values. They replace the
  server's values on the server and on all other clients.
- All other values take the server's values, not the values from the scene or prefab.
- So a script that moves an object in `Start` moves it for everyone whenever a client starts. Set starting
  positions in the scene instead.

This applies to every [SyncBehaviour](./syncbehaviour.md#server-state). See there also for what happens after a
reconnect.

## Showing, hiding and deleting

- `SetActive(false)` hides the copies on the other clients, and `SetActive(true)` shows them. Only the object's own
  active state (`activeSelf`) is synced. Deactivating a parent has no effect on the other clients. With
  `SyncActive` off, the active state stays local.
- Disabling only the `SyncTransform` component pauses syncing without hiding anything. Changes made meanwhile are
  sent when you enable it again.
- Destroying the object, or unloading its scene, e.g. by loading another scene, deletes it on the server and on all
  other clients.
- After any client loads the scene again, its objects sync again between all clients that load the scene from then
  on. A client that kept the scene open lost its copies with the delete. It gets them back only by loading the scene
  again, or from a manager whose `Template` creates them ([Objects created at runtime](#objects-created-at-runtime)).
- Leaving Play mode, quitting or killing the app deletes nothing. The objects stay on the server until the app's
  last client disconnects.

## Physics

For an object with a `Rigidbody`, only one client calculates the physics. The other clients follow its position.

- Enable `PhysicsAuthority` on the `SyncTransform` of the client that should calculate the physics. Enabling it on
  one client disables it on all others.
- If `PhysicsAuthority` is enabled in the scene or prefab, the first client gets the authority.
- Set `isKinematic` on the `SyncTransform`, not on the `Rigidbody`. The `SyncTransform` overwrites the `Rigidbody`'s
  value.
- On the other clients, the `Rigidbody` stays kinematic and follows the client with the authority.
- Until the server's state arrives, the `Rigidbody` stays kinematic, so a client that joins later starts from the
  shared position. An object created at runtime on this client is simulated at once, since the server has no state
  for it yet.
- If no server answers within 5 s, the objects are simulated anyway and the console warns once per session:
  `Colibri: no connection to a server for 5 s, so placed SyncTransforms with a Rigidbody and PhysicsAuthority ticked are simulated without the server's state; …`.
  When a server answers later, the positions these objects reached replace the shared ones on all clients. Start
  the server before the clients.

## Objects created at runtime

To sync objects that you create at runtime with `Instantiate`:

1. Add the `[SyncTransformManager]` prefab from `Packages/Colibri/Prefabs/` to the scene.
2. Set its `Template` to the prefab of the object.
3. In the prefab, set `ModelId` to a name for this prefab, e.g. `cube`, and leave `Id` empty.

When a client instantiates the prefab, the object gets a new `Id`. The manager on the other clients creates a copy
from its `Template` and syncs it. Destroying the object destroys the copies.

- Add one manager for each prefab, each with its own `ModelId`. Objects with a `ModelId` are handled only by the
  manager whose `Template` has the same `ModelId`.
- Placed objects without a `ModelId` are handled by a manager whose `Template` has no `ModelId` or that has no
  `Template`.
- The `Template` can also be an inactive object in the scene. An active one would sync as an object of its own.
- The manager creates the copies at the top level of the scene hierarchy.
- If two managers handle the same `ModelId`, the console warns
  `Warning: Multiple instances of '…' detected with overlapping ModelID. …`.
- If a manager without a `Template` receives an object it does not have, it warns once:
  `Colibri: '…' received model '…' on channel '…', which is not in this scene, and has no Template to build it from. …`.

## Web clients

Web clients can list, read and move the objects of `SyncTransform` and create objects of their own. Positions,
rotations and scales are in Unity's coordinates. See [SyncTransform](../web/synctransform.md) for the web side.

An object that a web client creates appears in Unity only if a manager there has a `Template` with the matching
`ModelId`.

## Limitations

These apply to every [SyncBehaviour](./syncbehaviour.md).

- Move an object from one client at a time. Concurrent updates from several clients make it jitter.
- Each object sends at most 30 updates per second by default. See [Send rate](./syncbehaviour.md#send-rate).
- The server discards all objects when the app's last client disconnects.
