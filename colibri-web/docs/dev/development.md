# colibri-web development

For developers working on colibri-web itself. Using Colibri: [README](../../README.md).

| Command                | Description                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| `npm test`             | Unit tests                                                                                       |
| `npm run typecheck`    | Type-checks sources, samples and tests                                                           |
| `npm run lint`         | Style check (ESLint)                                                                             |
| `npm run format:check` | Formatting check (Prettier)                                                                      |
| `npm run test:e2e`     | End-to-end tests against a real colibri-server                                                   |
| `npm run release`      | Builds and publishes to npm. `npm publish` also builds first. Replaces the 1.x `publish` script. |

`npm run test:e2e` starts a server from `../colibri-server` with Docker Compose on port 9211, unless
`COLIBRI_E2E_SERVER` names a running server (port: `COLIBRI_E2E_PORT`, default 9211).

Code structure, style and size limits: [conventions.md](conventions.md).
