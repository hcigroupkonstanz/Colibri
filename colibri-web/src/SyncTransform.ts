import type { Observable } from 'rxjs';
import { RegisterModelSync } from './ModelSynchronization';
import { SyncModel } from './SyncModel';
import { Synced } from './Synced';

/** `[x, y, z]`, as colibri-unity sends a Vector3. */
export type Vector3 = [number, number, number];

/** `[x, y, z, w]`, as colibri-unity sends a Quaternion. */
export type Quaternion = [number, number, number, number];

/**
 * The web side of colibri-unity's `SyncTransform`: active state, position, rotation and scale in
 * Unity's coordinates. Register it with {@link RegisterSyncTransforms}.
 *
 * Members mirror colibri-unity's `[Sync]` members. A Unity object with a member's Sync box unticked
 * never sends it, so it keeps its default here, which equals Unity's placeholder.
 *
 * Assign a new array to change a vector: `transform.position = [1, 2, 3]` is sent,
 * `transform.position[0] = 1` is not.
 */
export class SyncTransform extends SyncModel<SyncTransform> {
    /** Unity's `activeSelf`. `false` hides the object on the Unity clients. */
    @Synced()
    public accessor active = true;

    /** World position, or local position with *Use Local Transform* ticked. */
    @Synced()
    public accessor position: Vector3 = [0, 0, 0];

    /** World rotation, or local rotation with *Use Local Transform* ticked. */
    @Synced()
    public accessor rotation: Quaternion = [0, 0, 0, 1];

    /** Local scale. */
    @Synced()
    public accessor scale: Vector3 = [1, 1, 1];

    /**
     * Id of the Unity client that simulates the object's physics (`PhysicsAuthority`). Declared so a
     * remote update carrying it is not warned about as an unknown property. Setting it takes the
     * authority away from that client.
     */
    @Synced()
    public accessor physicsId = '';
}

/**
 * {@link RegisterModelSync} for `SyncTransform`: returns an Observable of all of them, which emits
 * when one is added, changed or deleted, and a function that registers a new one.
 *
 * Unity objects with a `ModelId` sync on a channel of their own, so pass the same `modelId`. Call
 * this once per channel and share the result: two registrations on one channel in one page do not
 * receive each other's updates.
 */
export const RegisterSyncTransforms = (
    modelId = ''
): [Observable<SyncTransform[]>, (transform: SyncTransform) => void] =>
    RegisterModelSync<SyncTransform>({
        name: modelId ? `synctransform_${modelId}` : 'synctransform',
        type: SyncTransform
    });
