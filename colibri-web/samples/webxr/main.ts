import { Colibri, RegisterSyncTransforms, SyncTransform, type Vector3 } from '@hcikn/colibri';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { VRButton } from 'three/addons/webxr/VRButton.js';

/**
 *  colibri-unity's SyncTransform sample in WebXR: the same four cubes, with the same Ids, and the
 *  cubes and spheres created at runtime. The controllers move, rotate and scale them, and create new
 *  ones. Run it next to the SyncTransform sample in Unity, with the same app name there, or open it
 *  on two devices.
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

// --- The Unity sample -----------------------------------------------------------------------------

// Which members an object syncs: the Sync boxes of its SyncTransform. As in Unity, a member that is
// switched off stays local: it is neither sent nor applied.
interface Members {
    active: boolean;
    position: boolean;
    rotation: boolean;
    scale: boolean;
}

const ALL: Members = { active: true, position: true, rotation: true, scale: true };

interface SceneCube {
    name: string;
    position: Vector3;
    members: Members;
}

// The four cubes of SyncTransformSample.unity, with their Ids, positions and Sync boxes. Every
// client loads them with the same Ids, so they are one object on all clients. Their rotation is
// [0, 0, 0, 1] and their scale [1, 1, 1].
const SCENE_CUBES = new Map<string, SceneCube>([
    [
        'c72a4318-1774-472f-9ac1-88a3d787bd56',
        { name: 'CubeAll', position: [3.0451636, -5.598028, 0.5917454], members: ALL }
    ],
    [
        '2b129dfa-3dc3-414b-9dd7-25c8500bc210',
        {
            name: 'CubePosOnly',
            position: [11.61, -5.598028, 0.5917454],
            members: { ...ALL, rotation: false, scale: false }
        }
    ],
    [
        '51694901-26fa-4c85-9671-d29fd383498a',
        { name: 'CubeRotOnly', position: [2.73, -5.598028, -4.96], members: { ...ALL, position: false, scale: false } }
    ],
    [
        'fed32fd4-39a2-49cd-bc75-630260feeffe',
        {
            name: 'CubeScaleOnly',
            position: [-4.13, -5.598028, 0.5917454],
            members: { ...ALL, position: false, rotation: false }
        }
    ]
]);

// The page keeps Unity's coordinates, so positions match Unity's numbers. Unity's sample has no
// floor; here it is under the cubes, and the viewer stands on it in front of them.
const FLOOR_Y = -6.1;
const VIEWER = new THREE.Vector3(3.7, FLOOR_Y, 9);

// --- Scene ----------------------------------------------------------------------------------------

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.xr.enabled = true;
document.body.appendChild(renderer.domElement);
document.body.appendChild(VRButton.createButton(renderer));

// WebXR puts the viewer's floor at y = 0. Moving the reference space puts it at VIEWER instead.
renderer.xr.addEventListener('sessionstart', () => {
    const floor = renderer.xr.getReferenceSpace();
    if (!floor) return;
    renderer.xr.setReferenceSpace(
        floor.getOffsetReferenceSpace(new XRRigidTransform({ x: -VIEWER.x, y: -VIEWER.y, z: -VIEWER.z }))
    );
});

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x20242a);
scene.add(new THREE.HemisphereLight(0xffffff, 0x444444, 2));
const sun = new THREE.DirectionalLight(0xffffff, 1.5);
sun.position.set(VIEWER.x + 3, FLOOR_Y + 6, 2);
scene.add(sun);
const grid = new THREE.GridHelper(30, 30, 0x888888, 0x444444);
grid.position.set(VIEWER.x, FLOOR_Y, 2);
scene.add(grid);

const camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.05, 100);
camera.position.set(VIEWER.x, FLOOR_Y + 1.6, VIEWER.z);
const orbit = new OrbitControls(camera, renderer.domElement);
orbit.target.set(VIEWER.x, -5.6, 1);
orbit.update();

window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
});

// A name above an object, so the four cubes can be told apart.
function label(text: string): THREE.Sprite {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    if (context) {
        context.font = 'bold 64px system-ui, sans-serif';
        context.fillStyle = '#ffffff';
        context.textAlign = 'center';
        context.textBaseline = 'middle';
        context.fillText(text, 256, 64);
    }
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas) }));
    sprite.scale.set(2, 0.5, 1);
    return sprite;
}

// --- Synced objects -------------------------------------------------------------------------------

// Unity's primitives: a cube of 1 m, a sphere 1 m across.
const geometries: Record<string, THREE.BufferGeometry> = {
    sphere: new THREE.SphereGeometry(0.5, 32, 16),
    cube: new THREE.BoxGeometry(1, 1, 1)
};

interface SyncedObject {
    transform: SyncTransform;
    members: Members;
    mesh: THREE.Mesh;
    label?: THREE.Sprite;
}

// Where a held object hangs, relative to the controller that holds it.
interface Grab {
    object: SyncedObject;
    position: THREE.Vector3;
    rotation: THREE.Quaternion;
}

const objects = new Map<string, SyncedObject>();
const held = new Set<SyncedObject>();
const grabs = new Map<THREE.XRTargetRaySpace, Grab>();
const registerTransform: Record<string, (transform: SyncTransform) => void> = {};

// The Unity sample syncs its four cubes without a ModelId, and creates cubes and spheres at runtime
// with the ModelIds 'cube' and 'sphere'. Each ModelId has a channel of its own.
for (const modelId of ['', 'cube', 'sphere']) {
    const [transforms$, register] = RegisterSyncTransforms(modelId);
    registerTransform[modelId] = register;
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
            const object = objects.get(transform.id);
            if (!object) {
                add(transform, modelId);
                continue;
            }
            // Registering an object with a listed id replaces the listed instance.
            object.transform = transform;
            // The controller moves a held object; what other clients send meanwhile would make it jump.
            if (!held.has(object)) applyToMesh(transform, object);
        }
        status.textContent = `${objects.size} synced object(s)`;
    });
}

function add(transform: SyncTransform, modelId: string) {
    const cube = SCENE_CUBES.get(transform.id);
    const material = new THREE.MeshStandardMaterial({
        color: cube ? 0xd0d0d0 : new THREE.Color().setHSL(Math.random(), 0.6, 0.55)
    });
    const mesh = new THREE.Mesh(geometries[modelId] ?? geometries.cube, material);
    const object: SyncedObject = { transform, members: cube?.members ?? ALL, mesh };
    if (cube) {
        // Where the scene places it: what Unity shows for the members it does not sync.
        mesh.position.set(cube.position[0], cube.position[1], -cube.position[2]);
        object.label = label(cube.name);
        scene.add(object.label);
    }
    applyToMesh(transform, object);
    objects.set(transform.id, object);
    scene.add(mesh);
}

function remove(id: string) {
    const object = objects.get(id);
    if (!object) return;
    held.delete(object);
    for (const [controller, grab] of grabs) {
        if (grab.object === object) grabs.delete(controller);
    }
    object.mesh.removeFromParent();
    object.label?.removeFromParent();
    objects.delete(id);
}

// Unity is left-handed, three.js right-handed: positions negate z, rotations x and y.
function applyToMesh(transform: SyncTransform, { members, mesh }: SyncedObject) {
    if (members.position) {
        const [px, py, pz] = transform.position;
        mesh.position.set(px, py, -pz);
    }
    if (members.rotation) {
        const [rx, ry, rz, rw] = transform.rotation;
        mesh.quaternion.set(-rx, -ry, rz, rw);
    }
    if (members.scale) mesh.scale.set(...transform.scale);
    if (members.active) mesh.visible = transform.active;
}

function applyToTransform({ members, mesh, transform }: SyncedObject) {
    if (members.position) transform.position = [mesh.position.x, mesh.position.y, -mesh.position.z];
    if (members.rotation) {
        transform.rotation = [-mesh.quaternion.x, -mesh.quaternion.y, mesh.quaternion.z, mesh.quaternion.w];
    }
    if (members.scale) transform.scale = [mesh.scale.x, mesh.scale.y, mesh.scale.z];
}

// On the 'cube' or 'sphere' channel, so the Unity sample shows it with its matching template. Small
// enough to hold in one hand.
function create(modelId: 'cube' | 'sphere', position: THREE.Vector3) {
    const transform = new SyncTransform(window.crypto.randomUUID());
    transform.position = [position.x, position.y, -position.z];
    transform.scale = [0.3, 0.3, 0.3];
    registerTransform[modelId](transform);
}

// A few metres in front of the viewer, at chest height.
function inFront(): THREE.Vector3 {
    return new THREE.Vector3(VIEWER.x + Math.random() * 2 - 1, FLOOR_Y + 1.2, VIEWER.z - 3 + Math.random() * 2 - 1);
}

element('add-cube').addEventListener('click', () => {
    create('cube', inFront());
});
element('add-sphere').addEventListener('click', () => {
    create('sphere', inFront());
});

// The scene's cubes are registered like any object: if the server has them already, e.g. from
// Unity, its values replace these.
for (const [id, cube] of SCENE_CUBES) {
    const transform = new SyncTransform(id);
    transform.position = cube.position;
    registerTransform[''](transform);
}

// --- Controllers ----------------------------------------------------------------------------------

const gamepads = new Map<THREE.XRTargetRaySpace, Gamepad>();
const raycaster = new THREE.Raycaster();
const ahead = new THREE.Vector3();
const controllerRotation = new THREE.Quaternion();
let nextKind: 'cube' | 'sphere' = 'cube';

for (const index of [0, 1]) {
    const controller = renderer.xr.getController(index);
    controller.add(
        new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -5)]),
            new THREE.LineBasicMaterial({ color: 0xffffff })
        )
    );
    scene.add(controller);

    controller.addEventListener('connected', event => {
        if (event.data.gamepad) gamepads.set(controller, event.data.gamepad);
    });
    controller.addEventListener('disconnected', () => {
        gamepads.delete(controller);
    });

    controller.addEventListener('selectstart', () => {
        raycaster.setFromXRController(controller);
        const candidates = [...objects.values()].filter(o => o.mesh.visible && !held.has(o));
        const hits = raycaster.intersectObjects(
            candidates.map(o => o.mesh),
            false
        );
        if (hits.length === 0) return;
        const object = candidates.find(o => o.mesh === hits[0].object);
        if (!object) return;
        // Remembered relative to the controller, so the object moves with it from where it is.
        controller.updateWorldMatrix(true, false);
        controller.getWorldQuaternion(controllerRotation);
        grabs.set(controller, {
            object,
            position: controller.worldToLocal(object.mesh.position.clone()),
            rotation: controllerRotation.invert().multiply(object.mesh.quaternion)
        });
        held.add(object);
    });

    controller.addEventListener('selectend', () => {
        const grab = grabs.get(controller);
        if (!grab) return;
        grabs.delete(controller);
        held.delete(grab.object);
        applyToTransform(grab.object);
    });

    // The grip creates a cube or a sphere, in turn, half a metre ahead of the controller.
    controller.addEventListener('squeezestart', () => {
        create(nextKind, controller.localToWorld(ahead.set(0, 0, -0.5)));
        nextKind = nextKind === 'cube' ? 'sphere' : 'cube';
    });
}

// Moves a held object with its controller, and scales it with the thumbstick: up to grow, down to
// shrink. Only the members the object syncs change, so CubeRotOnly turns in place.
function follow(controller: THREE.XRTargetRaySpace, { object, position, rotation }: Grab, seconds: number) {
    const { members, mesh } = object;
    controller.updateWorldMatrix(true, false);
    if (members.position) mesh.position.copy(controller.localToWorld(position.clone()));
    if (members.rotation) mesh.quaternion.copy(controller.getWorldQuaternion(controllerRotation).multiply(rotation));

    // xr-standard: axis 3 is the thumbstick's y, negative when pushed up.
    const stick = gamepads.get(controller)?.axes[3] ?? 0;
    if (members.scale && Math.abs(stick) > 0.2) {
        const scale = THREE.MathUtils.clamp(mesh.scale.x * Math.exp(-stick * seconds), 0.05, 20);
        mesh.scale.setScalar(scale);
    }
}

// --- Loop -----------------------------------------------------------------------------------------

let lastFrame = 0;
let lastSent = 0;

renderer.setAnimationLoop(time => {
    const seconds = lastFrame ? (time - lastFrame) / 1000 : 0;
    lastFrame = time;

    for (const [controller, grab] of grabs) follow(controller, grab, seconds);

    if (held.size > 0 && time - lastSent >= SEND_INTERVAL_MS) {
        lastSent = time;
        for (const object of held) applyToTransform(object);
    }

    for (const { mesh, label } of objects.values()) {
        if (!label) continue;
        label.position.set(mesh.position.x, mesh.position.y + mesh.scale.y / 2 + 0.4, mesh.position.z);
        label.visible = mesh.visible;
    }

    renderer.render(scene, camera);
});
