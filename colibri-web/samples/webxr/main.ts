import { Colibri, RegisterSyncTransforms, type SyncTransform } from '@hcikn/colibri';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/**
 *  Shows the objects of colibri-unity's SyncTransform component in WebXR, and moves them with the
 *  controllers. Run it next to the SyncTransform sample in Unity, with the same app name there.
 *
 *  The page is served over https://, so it connects over TLS: the public test server answers on
 *  port 443. Your own server needs TLS, or a reverse proxy that adds it.
 */

const params = new URLSearchParams(location.search);
const app = params.get('app') ?? 'myAppName';
const server = params.get('server') ?? 'https://colibri.hci.uni-konstanz.de:443';

function element(id: string): HTMLElement {
    const found = document.getElementById(id);
    if (!found) throw new Error(`index.html has no #${id}`);
    return found;
}

const status = element('status');
element('app').textContent = app;
element('server').textContent = server;

const colibri = new Colibri(app, server);
colibri.protocolMismatch.subscribe(error => {
    status.textContent = error.message;
    status.classList.add('error');
});

// Like the Unity sample's own updates: a held object sends at most 30 updates a second.
const SEND_INTERVAL_MS = 1000 / 30;

// --- Scene ----------------------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242a);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(3, 6, 2);
scene.add(sun);
scene.add(new THREE.GridHelper(20, 20, 0x888888, 0x444444));

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(0, 1.6, 4);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(0, 1, 0);
orbit.update();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// --- Synced objects -------------------------------------------------------------------------------

// Unity's primitives: a cube of 1 m, a sphere 1 m across.
const geometries: Record<string, THREE.BufferGeometry> = {
    sphere: new THREE.SphereGeometry(0.5, 32, 16),
    cube: new THREE.BoxGeometry(1, 1, 1)
};

interface SyncedObject {
    transform: SyncTransform;
    mesh: THREE.Mesh;
}

const objects = new Map<string, SyncedObject>();
const held = new Set<SyncedObject>();

// The Unity sample syncs its placed objects without a ModelId, and creates cubes and spheres at
// runtime with the ModelIds 'cube' and 'sphere'. Each ModelId has a channel of its own.
for (const modelId of ['', 'cube', 'sphere']) {
    const [transforms$] = RegisterSyncTransforms(modelId);
    const ids = new Set<string>();

    // Emits the whole list on every change, many times a second while an object moves in Unity.
    transforms$.subscribe(transforms => {
        const now = new Set(transforms.map(t => t.id));
        for (const id of ids) {
            if (!now.has(id)) remove(id);
        }
        ids.clear();

        for (const transform of transforms) {
            ids.add(transform.id);
            let object = objects.get(transform.id);
            if (!object) {
                const material = new THREE.MeshStandardMaterial({
                    color: new THREE.Color().setHSL(Math.random(), 0.6, 0.55)
                });
                object = { transform, mesh: new THREE.Mesh(geometries[modelId] ?? geometries.cube, material) };
                objects.set(transform.id, object);
                scene.add(object.mesh);
            }
            // The controller moves a held object; what other clients send meanwhile would make it jump.
            if (!held.has(object)) applyToMesh(transform, object.mesh);
        }
        status.textContent = `${objects.size} synced object(s)`;
    });
}

function remove(id: string) {
    const object = objects.get(id);
    if (!object) return;
    held.delete(object);
    object.mesh.removeFromParent();
    objects.delete(id);
}

// Unity is left-handed, three.js right-handed: positions negate z, rotations x and y.
function applyToMesh(transform: SyncTransform, mesh: THREE.Object3D) {
    const [px, py, pz] = transform.position;
    const [rx, ry, rz, rw] = transform.rotation;
    mesh.position.set(px, py, -pz);
    mesh.quaternion.set(-rx, -ry, rz, rw);
    mesh.scale.set(...transform.scale);
    mesh.visible = transform.active;
}

const worldPosition = new THREE.Vector3();
const worldRotation = new THREE.Quaternion();

// A held object hangs below a controller, so its world pose is sent, not its local one.
function applyToTransform(mesh: THREE.Object3D, transform: SyncTransform) {
    mesh.getWorldPosition(worldPosition);
    mesh.getWorldQuaternion(worldRotation);
    transform.position = [worldPosition.x, worldPosition.y, -worldPosition.z];
    transform.rotation = [-worldRotation.x, -worldRotation.y, worldRotation.z, worldRotation.w];
}

// --- Controllers ----------------------------------------------------------------------------------

const raycaster = new THREE.Raycaster();

for (const index of [0, 1]) {
    const controller = renderer.xr.getController(index);
    controller.add(
        new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]),
            new THREE.LineBasicMaterial({ color: 0xffffff })
        )
    );
    scene.add(controller);

    let grabbed: SyncedObject | undefined;

    controller.addEventListener('selectstart', () => {
        raycaster.setFromXRController(controller);
        const candidates = [...objects.values()].filter(o => o.mesh.visible && !held.has(o));
        const hits = raycaster.intersectObjects(
            candidates.map(o => o.mesh),
            false
        );
        if (hits.length === 0) return;
        grabbed = candidates.find(o => o.mesh === hits[0].object);
        if (!grabbed) return;
        // attach() keeps the world pose, so the object moves with the controller from where it is.
        controller.attach(grabbed.mesh);
        held.add(grabbed);
    });

    controller.addEventListener('selectend', () => {
        if (!grabbed) return;
        // Deleted by another client while held: sending it again could bring it back.
        if (objects.get(grabbed.transform.id) === grabbed) {
            scene.attach(grabbed.mesh);
            applyToTransform(grabbed.mesh, grabbed.transform);
        }
        held.delete(grabbed);
        grabbed = undefined;
    });
}

// --- Loop -----------------------------------------------------------------------------------------

let lastSent = 0;

renderer.setAnimationLoop(time => {
    if (held.size > 0 && time - lastSent >= SEND_INTERVAL_MS) {
        lastSent = time;
        for (const object of held) applyToTransform(object.mesh, object.transform);
    }
    renderer.render(scene, camera);
});
