# Plan: Migrate `@Synced` to TC39 decorators + fix packaging & echo suppression

> Status: **executed** (2026-07-22). Kept as a record of the rationale and verification steps behind
> the `2.0.0` release.

## Context

The uncommitted work on `src/Synced.ts` / `src/SyncModel.ts` already fixed two real bugs
(per-instance backing storage, and setters actually emitting `modelChanges`). Empirical testing
showed it works **only** under `useDefineForClassFields: false` (the repo's `target: es6` default).
Under `useDefineForClassFields: true` — the default for React/Vite/Next and any modern target —
plain `@Synced() field = x` initializers create own data properties that **shadow** the prototype
accessor the decorator installs, so local edits never emit change events. This is the long-standing
"syncing fields doesn't work in React" caveat, and the current fix does not resolve it.

Decision: **migrate `@Synced` to TC39 standard decorators using the `accessor` keyword.**
Auto-accessors always live on the prototype with per-instance private backing, so they sync correctly
under every bundler/target — including React. This is a **breaking change** (consumers must drop
`experimentalDecorators` and write `@Synced() accessor x = 0`), so it warrants a major version bump.

Also in scope: fix the misconfigured npm entry points, harden the fragile `ignoreNextChange`
echo-suppression, and move `typescript` to devDependencies. **Out of scope:** a test suite (deferred).

Repo facts that shape this plan:
- Library source only *defines* the decorator; it never *applies* one → the `tsup` build strips the
  decorator types and is unaffected by the legacy↔standard switch.
- Only `@Synced` decorators exist anywhere (samples only) → flipping `experimentalDecorators` off is
  safe repo-wide.
- Installed **esbuild is 0.18.20** (via `tsx ^4` / `tsup ^7`), which predates standard-decorator +
  `accessor` support (~esbuild 0.21). So `tsx` cannot run the migrated sample until upgraded.

## Changes

### 1. Rewrite `src/Synced.ts` for TC39 accessor decorators
Replace the legacy `PropertyDecorator` with a standard `ClassAccessorDecorator`. Shape:

```ts
import { SyncModel } from './SyncModel';

export function Synced<This extends SyncModel<unknown>, V>(syncedName = '') {
    return function (
        value: ClassAccessorDecoratorTarget<This, V>,
        context: ClassAccessorDecoratorContext<This, V>,
    ): ClassAccessorDecoratorResult<This, V> {
        if (context.kind !== 'accessor') {
            throw new Error('@Synced() must decorate an `accessor` member');
        }
        const key = String(context.name);
        const name = (syncedName || key).toLowerCase();

        // runs once per instance during construction; registers metadata
        context.addInitializer(function (this: This) {
            this.registerSyncedProperty(name, key);
        });

        return {
            get(this: This) {
                return value.get.call(this);
            },
            set(this: This, newVal: V) {
                value.set.call(this, newVal);
                // suppress emission for server-driven updates (see SyncModel guard)
                if (this.modelChanges && !this.applyingRemoteUpdate) {
                    this.modelChanges.next(key);
                }
            },
        };
    };
}
```

Notes:
- Auto-accessor init writes the private backing field directly (not via this setter), so construction
  does not emit a spurious change — the `if (this.modelChanges)` guard from the old code is no longer
  strictly needed but kept for safety.
- Metadata registration moves from decoration-time (prototype) to per-instance `addInitializer`, which
  removes the reason for the prototype-chain seeding gymnastics in `SyncModel` (see below).
- The `instanceof SyncModel` runtime check is dropped (the generic constraint + `context.kind` guard
  replace it).

### 2. Harden echo suppression in `src/SyncModel.ts`
Replace the timing-dependent `ignoreNextChange` boolean with a **synchronous** guard the setter reads
while assigning, so suppression no longer depends on `bufferTime` ordering:

- Remove `public ignoreNextChange = false;` → add `public applyingRemoteUpdate = false;`.
- Wrap `update()` assignments:
  ```ts
  public update(updates: Partial<T>): void {
      const syncedProps = this.getSyncedProperties();
      this.applyingRemoteUpdate = true;
      try {
          for (const key of Object.keys(updates)) {
              if (key === 'id') continue;
              const localKey = syncedProps[key];
              if (localKey) (this as any)[localKey] = updates[key as keyof T];
              else console.warn(`Unknown property ${key} in ${this.constructor.name}`);
          }
      } finally {
          this.applyingRemoteUpdate = false;
      }
  }
  ```
  During a remote update the decorated setter sees `applyingRemoteUpdate === true` and never emits —
  no post-hoc flag, no reset, no reliance on `bufferTime`.
- Simplify `registerSyncedProperty`: since `addInitializer` now runs it per-instance, it can store into
  a plain non-enumerable `__syncedProperties` object without the parent-chain spread seeding. Keep it
  non-enumerable so it stays out of `toJson`/enumeration. Keep `getSyncedProperties()` and `toJson()`
  as-is.

### 3. Drop `ignoreNextChange` from `src/ModelSynchronization.ts`
Because remote updates no longer emit, the subscriber's `if (!model.ignoreNextChange)` gate and the
`model.ignoreNextChange = false` reset become dead code. In both subscriber closures (the
`registerModel` path and the new-model path in `onUpdate`), simply send on every emission:
```ts
model.modelChanges$.subscribe((changes) => {
    SendMessage(`${name}`, 'model::update', model.toJson(changes));
    models.next([...models.value]); // keep the BehaviorSubject refresh in the onUpdate path
});
```

### 4. Migrate the sample — `samples/model-sync.ts`
- Convert all three synced members to auto-accessors:
  ```ts
  @Synced() accessor name = '';
  @Synced() accessor age = 0;
  @Synced('billingAddress') accessor address = '';
  ```
  (drops the manual `_name` backing getter/setter).
- Remove the `/* Warning: ... does not work with ... React! */` comment (no longer true).
- Update the header comment (lines 4–7): replace the "add `experimentalDecorators: true`" instruction
  with a note that standard decorators + TypeScript ≥5.0 are required and `experimentalDecorators` must
  be off.

### 5. `tsconfig.json`
- Remove `"experimentalDecorators": true` (standard decorators are the default when it is absent).
- Bump `"target": "es6"` → `"es2022"` (so `useDefineForClassFields` defaults to `true`, matching
  standard semantics; the sample now proves out under the modern config).

### 6. `package.json`
- **Entry points** (currently point to nonexistent/mis-typed files — `dist/` actually contains
  `index.js` [ESM] and `index.cjs` [CJS]):
  ```json
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
      ".": {
          "types": "./dist/index.d.ts",
          "import": "./dist/index.js",
          "require": "./dist/index.cjs"
      }
  },
  "files": ["dist"]
  ```
- Move `"typescript"` from `dependencies` → `devDependencies` (it's type-only for consumers).
- Bump `"tsx"` to latest `^4` (its bundled esbuild must be ≥0.21 to transpile `accessor` + standard
  decorators, so the sample runs). `tsup` need not be upgraded — the library build applies no decorators.
- Major version bump `1.3.1` → `2.0.0` (breaking API change).

### 7. `README.md`
Update the SyncModel section: document the `@Synced() accessor x = 0` pattern, state the TypeScript
≥5.0 / standard-decorators requirement (and that `experimentalDecorators` must be **off**), remove the
"doesn't work in React" caveat, and add a short 1.x→2.0 migration note (field → `accessor`, drop
`experimentalDecorators`).

## Files to modify
- `src/Synced.ts` — full rewrite (TC39 accessor decorator)
- `src/SyncModel.ts` — `applyingRemoteUpdate` guard, simplified metadata, `update()` try/finally
- `src/ModelSynchronization.ts` — remove `ignoreNextChange` gating
- `samples/model-sync.ts` — `accessor` members, comment cleanup
- `tsconfig.json` — drop `experimentalDecorators`, `target: es2022`
- `package.json` — entry points + `exports`, dep hygiene, `tsx` bump, major version
- `README.md` — decorator docs + migration note

## Verification
1. `npm run build` — confirm `dist/` now contains `index.js`, `index.cjs`, **and** `index.d.ts`
   (the `types` field target); confirm no build errors.
2. `npm run lint` — passes (no `experimentalDecorators`/no-explicit-any regressions).
3. `npx tsc --noEmit` — type-checks `src` + `samples` under the new tsconfig (validates the standard
   decorator types resolve and the `accessor` sample compiles).
4. **Behavioral check under the modern config** (a standalone script run with the upgraded `tsx` — no
   live Colibri server needed), asserting on a `SyncModel` subclass with two `accessor` fields (one
   with a custom sync name) + a subclass:
   - per-instance isolation: two instances hold independent values;
   - accessor edits emit `modelChanges` (all fields, including plain-looking `accessor age`) — this is
     the previously-broken React case;
   - `toJson()` filters by `localKey` and maps custom names (`address` → `billingaddress`);
   - during `update({...})` the setter does **not** emit (synchronous `applyingRemoteUpdate` guard),
     and no `modelChanges` fire for server-driven writes;
   - subclass `__syncedProperties` don't bleed into a sibling/parent.
   Run once with `target: es2022`/`useDefineForClassFields: true` to prove the React-config fix.
5. Smoke-run `samples/model-sync.ts` via `tsx` against a local Colibri server (optional, needs server)
   to confirm end-to-end sync of an `accessor` field edit.

## Risks / notes
- **Breaking change**: consumers must migrate fields → `accessor` and remove `experimentalDecorators`.
  Captured by the 2.0.0 bump + README migration note.
- **Toolchain**: the `tsx` bump is required for the sample to run; if the upgrade proves disruptive,
  the fallback is to verify via `tsc`-compiled output instead of `tsx`.
- `ModelSynchronization.ts` is currently unmodified in the working tree; this plan is the first change
  to it — keep the edit minimal (only the `ignoreNextChange` removal).
