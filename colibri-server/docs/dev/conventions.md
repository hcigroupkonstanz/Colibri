# colibri-server conventions

For developers working on colibri-server itself. Running the tests: [development.md](development.md).

## Modules and files

- One concept per module (Angular style guide: prefer focusing source files on a single concept). The file is
  kebab-case and named after its main export (`tcp-server-proxy.ts` exports `TCPServerProxy`). Small types and
  functions only that module uses may stay in it.
- No generic names like `utils.ts`, `helpers.ts` or `common.ts`.
- Feature folders, not folders by kind (Node best practices 1.1, Angular style guide).
  - Server: `src/server/modules/<feature>/` with `core/`, `core/worker/`, `protocol/`, `net/`, `tls/`, `limits/`,
    `tcp/`, `tcp/worker/`, `socket-io/`, `hooks/`, `models/` (the synchronized models, `DataStore`), `store/` (the
    REST store, `store.db`), `http/`, `admin/` and `voice/`.
  - Admin UI: `src/ui/app/<feature>/` with `log/`, `clients/`, `models/`, `server/`, `charts/`, `shell/` and
    `connection/`. Modules several features use (`format.ts`, `download.ts`) sit in `src/ui/app/` itself. Helpers
    only specs use sit in `src/ui/testing/`.
- No barrel files (an `index.ts` that re-exports). Import from the defining file. Barrels bring import cycles and
  load every module they re-export. They suit only a library's single entry point, and the server is not a library.
- `import type` for imports used only as types.
- No import cycles.
- Code that runs in the TCP worker thread (`tcp/worker/`) imports only what the worker needs, never main-thread
  modules.

## Size guides

Configured in `eslint.config.mjs` as errors, so lint and CI fail when code exceeds one. They apply to `src/`.
Specs (`*.spec.ts`), `src/ui/testing/` and everything outside `src/` are exempt.
Exceeding a guide needs an `eslint-disable-next-line <rule> -- <reason>` comment that review accepts.

| Metric | Limit |
|---|---|
| Code lines per file (`max-lines`) | 400 |
| Lines per function (`max-lines-per-function`) | 40 |
| Cyclomatic complexity per function (`complexity`) | 15 |
| Nesting depth (`max-depth`) | 4 |
| Parameters (`max-params`) | 5, an options object beyond that |

`src/` is linted with type information (typescript-eslint's `recommendedTypeChecked`), which catches floating
promises and `any` leaking through. The server uses the project service, the admin UI `src/ui/tsconfig.app.json` and
`src/ui/tsconfig.spec.json`. `test/` and `bench/` are linted without type information.
`npm run lint` must report 0 problems.

## Design

- Functional core, imperative shell: `Service` and `WorkerService` subclasses hold the sockets, files and thread
  messages and own the lifecycle. A helper class that owns a timer or a thread (`StoreExpiry`,
  `StoreCheckpointer`, `ProxyProtocolGate`) is started and stopped by its `Service`.
- Decisions and formatting go into plain functions and classes. Pass the time (`now`) and callbacks in, so unit
  tests reach them without sockets. The `admin/` topic snapshots are the example.
- Classes split out of a `Service` do not extend `Service` themselves: a `Service` registers itself in
  `Service.Current` and logs under its own name. They log and post through callbacks from their owner.
- Module functions rather than classes with only static members.
- Export only what other modules use. Named exports only: no `export default`, no `export let`.

## Style

- Explicit accessibility on class members: `public`, `protected`, `private`.
- TypeScript `private`, not `#private`.
- `readonly` for members never reassigned after the constructor.
- camelCase for variables and functions, PascalCase for classes, interfaces and types, UPPER_SNAKE_CASE for module
  constants.
- Function expressions (`const f = function () {}`) for module functions, as `func-style` requires. Arrow functions
  for callbacks.
- `eqeqeq`, single quotes, semicolons, 4 spaces.
- Few `../` steps in imports.

`colibri-server/.editorconfig` and ESLint enforce what they can.

## Admin UI (Angular)

- Components hold UI state and template bindings. Logic that makes sense without the UI (building sections,
  formatting) goes into plain functions or services.
- Short lifecycle hooks: call named methods.
- `protected` for members only the template reads. `readonly` for inputs, outputs and queries (`input()`,
  `output()`, `viewChild()`).
- `inject()` rather than constructor parameters.
- File names with hyphens. Tests next to the file as `.spec.ts`.

## Behaviour that users see

- A refactoring keeps byte-identical: log text, wire frames, REST routes and responses, admin topics, environment
  variables. Tests assert many log lines.

## Comments

- Comment only the why the code cannot say: ordering, protocol, threads and the worker boundary, Node.js gotchas.
- Public API gets a one-sentence summary.
- No bug history. That goes in the commit message.

## Refactoring

- One Extract Class, Extract Function or Move per commit.
- Tests green before and after.
- No behaviour change mixed into a move.
- Keep the order of side effects (writes, posts, log calls) across events, timers and `await`.
- A test that reaches a private member keeps working: update its cast in the same commit, never its assertions.

## Commits

Conventional commits: `type(scope): subject`, with the why in the body.

## Sources

- [Node.js best practices](https://github.com/goldbergyoni/nodebestpractices)
- [Google TypeScript style guide](https://google.github.io/styleguide/tsguide.html)
- [Angular style guide](https://angular.dev/style-guide)
- [Please stop using barrel files](https://tkdodo.eu/blog/please-stop-using-barrel-files)
- [Refactoring catalog](https://refactoring.com/catalog/)
- [Functional core, imperative shell](https://www.destroyallsoftware.com/screencasts/catalog/functional-core-imperative-shell)
- [typescript-eslint rules](https://typescript-eslint.io/rules/)
