---
sidebar_position: 4
title: SyncTransform
---

# SyncTransform

`SyncTransform` gives the web the objects of Unity's [`SyncTransform`](../unity/synctransform.md) component: their
position, rotation, scale and visibility, e.g. to show a shared 3D object on a web page or to move it from there.

## Reading the objects

```ts
import { RegisterSyncTransforms } from "@hcikn/colibri";

const [transforms$] = RegisterSyncTransforms();

transforms$.subscribe((transforms) => {
  for (const transform of transforms) {
    console.log(
      transform.id,
      transform.position,
      transform.rotation,
      transform.scale,
      transform.active,
    );
  }
});
```

`RegisterSyncTransforms` returns `transforms$`, an [RxJS](https://rxjs.dev/guide/observable) Observable of all
`SyncTransform` objects of the app. It emits the list whenever an object is added, moved, shown, hidden or deleted
on any client. A new subscriber gets the current list right away.

## Moving an object

To move an object, assign a new position to it, e.g. when the user drags it in a 3D view. Colibri sends it to all
other clients, web and Unity:

```ts
transform.position = [1, 0, 2];
```

This works the same for `rotation`, `scale` and `active`. Setting `active` to `false` hides the object on the Unity
clients.

- Assign a new array to change a value. Changing an array in place, e.g. `position[0] = 1`, is not sent.
- Only the members you change are sent. Moving an object does not change its other members.
- Move an object from one client at a time. Concurrent updates make it jitter.

## Members

| Member      | Type                         | Default         | In Unity                                                      |
| ----------- | ---------------------------- | --------------- | ------------------------------------------------------------- |
| `id`        | `string`                     | set on creation | The object's id. Read only.                                   |
| `active`    | `boolean`                    | `true`          | `activeSelf`                                                  |
| `position`  | `Vector3`, `[x, y, z]`       | `[0, 0, 0]`     | `position`, or `localPosition` with _Use Local Transform_     |
| `rotation`  | `Quaternion`, `[x, y, z, w]` | `[0, 0, 0, 1]`  | `rotation`, or `localRotation` with _Use Local Transform_     |
| `scale`     | `Vector3`, `[x, y, z]`       | `[1, 1, 1]`     | `localScale`                                                  |
| `physicsId` | `string`                     | `''`            | The client with `PhysicsAuthority`. Do not set it on the web. |

`Vector3` and `Quaternion` are types exported by the package.

A Unity object whose _Sync Position_, _Sync Rotation_, _Sync Scale_ or _Sync Active_ box is unticked never sends that
member. On the web, the member keeps its default.

## Coordinates

The values are in Unity's coordinates: left-handed, with Y up. three.js and most other web 3D libraries are
right-handed. To convert, negate `z` of positions, and `x` and `y` of rotations. Scales need no conversion.

For three.js:

```ts
import * as THREE from "three";
import { SyncTransform } from "@hcikn/colibri";

// Unity -> three.js
function applyToMesh(transform: SyncTransform, mesh: THREE.Object3D) {
  const [px, py, pz] = transform.position;
  const [rx, ry, rz, rw] = transform.rotation;
  mesh.position.set(px, py, -pz);
  mesh.quaternion.set(-rx, -ry, rz, rw);
  mesh.scale.set(...transform.scale);
  mesh.visible = transform.active;
}

// three.js -> Unity, e.g. after the user dragged the mesh
function applyToTransform(mesh: THREE.Object3D, transform: SyncTransform) {
  transform.position = [mesh.position.x, mesh.position.y, -mesh.position.z];
  transform.rotation = [
    -mesh.quaternion.x,
    -mesh.quaternion.y,
    mesh.quaternion.z,
    mesh.quaternion.w,
  ];
}
```

## Objects with a ModelId

Unity objects with a `ModelId` sync on a channel of their own. To see them, pass the `ModelId`:

```ts
const [cubes$] = RegisterSyncTransforms("Cube"); // the objects with ModelId 'Cube'
```

`RegisterSyncTransforms()` without an argument returns only the objects without a `ModelId`. For several
`ModelId`s, call it once for each.

## Creating an object from the web

`RegisterSyncTransforms` also returns a function that registers a new `SyncTransform`:

```ts
import { RegisterSyncTransforms, SyncTransform } from "@hcikn/colibri";

const [transforms$, registerTransform] = RegisterSyncTransforms();

const marker = new SyncTransform("marker-1");
marker.position = [0, 1, 0];
registerTransform(marker);
```

- The id must be unique across all clients. If another client already created an object with this id, its values
  replace the ones you set ([details](./syncmodel.md#registering-instances)).
- A Unity client shows the new object only if its scene has a `SyncTransformManager` whose `Template` has the same
  `ModelId` as the channel you registered it on. For a template with the `ModelId` `Cube`, register the object with
  `RegisterSyncTransforms('Cube')` ([Unity SyncTransform](../unity/synctransform.md)).

## Sample

The [sync-transform](https://github.com/hcigroupkonstanz/Colibri/blob/develop/colibri-web/samples/sync-transform.ts) sample lists the objects of Unity's SyncTransform sample and moves, scales, hides and shows
them from a terminal. Start the SyncTransform sample in Unity with the app name `myAppName`, then run:

```sh
cd colibri-web
npm ci
npm run samples/sync-transform
```

Type `list` to see the objects, and e.g. `move <id> 0 1 0` to move one. The start of an id is enough.

## Limitations

`SyncTransform` is a ready-made [`SyncModel`](./syncmodel.md), so the [limitations of SyncModel](./syncmodel.md#limitations)
apply here too:

- Call `RegisterSyncTransforms` once per `ModelId` and share what it returns. Two calls for the same `ModelId` on
  one page do not see each other's changes.
- Like all synchronized objects, the server keeps the objects only while at least one client of the app is
  connected.
