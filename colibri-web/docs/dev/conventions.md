# colibri-web conventions

For developers working on colibri-web itself. Running the tests: [development.md](development.md).

## Modules and files

- One concept per module (Angular style guide: prefer focusing source files on a single concept). The file is named
  after its main export: PascalCase for a class or a PascalCase-named function or const (`Colibri.ts` exports
  `Colibri`, `Synced.ts` exports `Synced`), camelCase for a module of plain functions (`lifecycle.ts`). Small types and
  functions only that module uses may stay in it.
- Folders are camelCase, as `src/modelSync/`.
- Existing file names stay as they are, so nothing about 2.0 looks different.
- No generic names like `utils.ts`, `helpers.ts` or `common.ts`.
- No barrel files except `src/index.ts`, the package's single entry point. Import from the defining file. Barrels bring
  import cycles and load every module they re-export.
- `import type` for imports used only as types.
- No import cycles.

## Public API

- Only `src/index.ts` defines the public API. It lists each export by name, `export type` for types. A name that is not
  listed there is not public.
- Nothing public is renamed or removed, including public members of exported classes. 2.x keeps the 2.0 API.
- Splitting a class never turns a private member public. The extracted class gets callbacks from its owner instead.
- `test/PublicApi.test.ts` is the check: it pins the exported names.

## Size guides

Configured in `eslint.config.js` as errors, so lint and CI fail when code exceeds one. They apply to `src/`.
Tests (`test/`, `e2e/`) and everything else outside `src/` are exempt.
Exceeding a guide needs an `eslint-disable-next-line <rule> -- <reason>` comment that review accepts.

| Metric                                            | Limit                            |
| ------------------------------------------------- | -------------------------------- |
| Code lines per file (`max-lines`)                 | 400                              |
| Lines per function (`max-lines-per-function`)     | 40                               |
| Cyclomatic complexity per function (`complexity`) | 15                               |
| Nesting depth (`max-depth`)                       | 4                                |
| Parameters (`max-params`)                         | 5, an options object beyond that |

`.ts` files are linted with type information (typescript-eslint's `strictTypeChecked`, through the project service
and the `include` of `tsconfig.json`), which catches floating promises and `any` leaking through. Plain JavaScript
files are linted without it. `npm run lint` must report 0 problems.

## Design

- No new module-level state. A dual ESM/CJS package can be loaded twice, and module state then exists twice.
- Keep state with the code that changes it. Prefer a `WeakMap` keyed by the instance, as `lifecycle.ts` does.
- Module functions rather than classes with only static members.
- Functional core, imperative shell: the coordinators send messages, emit and start timers. `Colibri` is the
  coordinator for the connection, `ModelSyncChannel` for one model sync registration (`RegisterModelSync` creates one
  per call).
- A class split out of `Colibri` may own one timer or one request, and `Colibri` starts and stops it:
  `OldServerDetector` (its timer and the warning it logs), `RestStore` (the store's requests).
- The model sync collaborators in `src/modelSync/` (for example `DeletedHere`, `KnownValues`, `GuardWindow`,
  `ReconnectRound`) keep state and decide. Where they need the time or a request, they take the clock
  (`() => Date.now()`) or a callback as a parameter, so unit tests reach them without a socket.
- `OwnModelAnswers` holds part of `ModelSyncChannel`'s work: settling own models after their request. It sends and
  applies only through callbacks that `ModelSyncChannel` passes it.
- A class split out of another gets what it needs through its constructor (values, shared collaborators, callbacks),
  never a reference to its owner.
- Read the time with `Date.now()`, so tests control it with fake timers.

## Style

- Explicit accessibility on class members: `public`, `protected`, `private`.
- `readonly` for members never reassigned.
- Arrow-function consts for module functions, as the code does. `Synced` and `synced` stay function declarations:
  their `.d.ts` and the `asserts` signature need it.
- Prettier formats, ESLint checks. `npm run format` and `npm run lint:fix` apply them, and lint-staged runs both on
  commit.
- `eqeqeq`.

`.editorconfig`, `.prettierrc` and ESLint enforce what they can.

## Behaviour that users see

- A refactoring keeps byte-identical: the messages sent and their order, the order channels are registered in, log and
  warning text, and timing (the `setTimeout(0)` before the first catch-up, the 1 ms change buffer in `SyncModel`).
  Tests assert many of them.

## Tests

- Unit tests are `test/<Module>.test.ts`. A module whose tests are split by concern gets
  `test/<Module>.<concern>.test.ts`.
- Unit tests for a module in a `src/` subfolder sit in the matching `test/` subfolder, as
  `test/modelSync/Confirmations.test.ts` for `src/modelSync/Confirmations.ts`.
- Helpers several test files share sit in `test/support/`.
- A test file resets the module state it uses (`Colibri`'s singleton, `RemoteLogger`'s patched console and the like),
  so files and tests run in any order.
- End-to-end tests are in `e2e/`, against a real server.

## Comments

- Comment only the why the code cannot say: ordering, protocol, Socket.IO and reconnect behaviour, runtime gotchas.
- Public API gets a one-sentence TSDoc summary.
- No bug history. That goes in the commit message.

## Refactoring

- One Extract Class, Extract Function or Move per commit.
- Tests green before and after.
- No behaviour change mixed into a move.
- Keep the order of side effects (sends, emits, log calls) across events, timers and `await`.
- A test that reaches a private member keeps working: update its cast in the same commit, never its assertions.

## Commits

Conventional commits: `type(scope): subject`, with the why in the body.

## Sources

- [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
- [Angular style guide](https://angular.dev/style-guide)
- [Please stop using barrel files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [Refactoring catalog](https://refactoring.com/catalog/)
- [Functional core, imperative shell](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)
- [typescript-eslint rules](https://typescript-eslint.io/rules/)
- [TypeScript: choosing compiler options (library guide)](https://www.typescriptlang.org/docs/handbook/modules/guides/choosing-compiler-options.html)
- [Node.js package examples: dual packages](https://github.com/nodejs/package-examples/blob/main/guide/07-dual-packages/README.md)
- [Vitest: parallelism](https://vitest.dev/guide/parallelism.html)
