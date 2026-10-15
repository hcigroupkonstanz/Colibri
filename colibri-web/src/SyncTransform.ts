import type { Observable } from 'rxjs';
import { RegisterModelSync } from './ModelSynchronization';
import { SyncModel } from './SyncModel';
import { Synced } from './Synced';

/** A position or scale as `[x, y, z]`, the way colibri-unity sends a Vector3. */
export type Vector3 = [number, number, number];

/** A rotation as `[x, y, z, w]`, the way colibri-unity sends a Quaternion. */
export type Quaternion = [number, number, number, number];

/**
 * The web side of colibri-unity's `SyncTransform` component: an object's active state, position,
 * rotation and scale, in Unity's coordinates. Register it with {@link RegisterSyncTransforms}.
 *
 * The members are the ones colibri-unity marks `[Sync]`, under the same names, with the values its
 * placeholders have. A Unity object whose Sync box for a member is unticked never sends it, so the
 * member keeps its default here.
 *
 * Assign a new array to change a vector: `transform.position = [1, 2, 3]`. Changing one in place,
 * `transform.position[0] = 1`, is not noticed and not sent.
 */
export class SyncTransform extends SyncModel<SyncTransform> {
    /** Unity's `activeSelf`. `false` hides the object on the Unity clients. */
    @Synced()
    accessor active = true;

    /** World position, or local position if the Unity object has *Use Local Transform* ticked. */
    @Synced()
    accessor position: Vector3 = [0, 0, 0];

    /** World rotation, or local rotation if the Unity object has *Use Local Transform* ticked. */
    @Synced()
    accessor rotation: Quaternion = [0, 0, 0, 1];

    /** Local scale. */
    @Synced()
    accessor scale: Vector3 = [1, 1, 1];

    /**
     * Which Unity client simulates the object's physics (`PhysicsAuthority`). Synced so that an
     * update carrying it is not reported as an unknown property. Leave it alone: setting it takes
     * the authority away from that client.
     */
    @Synced()
    accessor physicsId = '';
}

/**
 * Syncs the `SyncTransform`s of the app, like {@link RegisterModelSync} does for a model of your
 * own. Returns an Observable of all of them, which emits again whenever one is added, moved or
 * deleted, and a function that registers a new one.
 *
 * Unity objects with a `ModelId` sync on a channel of their own. Pass the same `modelId` to see
 * them. Call this once per channel and share what it returns: two registrations on one channel in
 * one page do not receive each other's updates.
 */
export const RegisterSyncTransforms = (
    modelId = ''
): [Observable<SyncTransform[]>, (transform: SyncTransform) => void] =>
    RegisterModelSync<SyncTransform>({
        name: modelId ? `synctransform_${modelId}` : 'synctransform',
        type: SyncTransform
    });
