# colibri-server development

For developers working on colibri-server itself. Using Colibri: [README](../../README.md).

- `npm ci`: install the dependencies.
- `npm run watch`: development server, recompiles and reloads on changes. Records no commit: it
  removes `dist/server/build-info.json`, and the *Server* page shows the commit as unknown.
- `npm run build`: compile. Records the commit in `dist/server/build-info.json`, from
  `COLIBRI_COMMIT` and `COLIBRI_COMMIT_DIRTY` (`true`) if set, else from git.
- `npm start`: start the server. Compile first.
- `npm run publish`: maintainers only. Builds the image with the commit, then pushes
  `hcikn/colibri:<version>` and `hcikn/colibri:latest`.
- `npm run lint`: lint the server and admin UI sources.
- `npm test`: vitest unit tests. The TLS tests need `openssl` on `PATH` (Git for Windows ships it in
  `usr/bin`). In a test,
  `createTestCertificate(dir, name, { commonName, keyType: 'ec' | 'rsa', signedBy, serverOnly })`
  from [`test/tls-test-certificate.ts`](../../test/tls-test-certificate.ts) creates a certificate valid
  for 2 days, self-signed or signed by another test certificate.
- `npm run gui:test`: admin UI unit tests.
- `npm run bench`: vitest benchmarks. Results depend on machine and runtime, so report them in the pull
  request that claims them instead of committing them. Always compare before and after on the same
  machine and Node version.
- `npm run test:vectors`: checks that colibri-unity's protocol test vectors match this server's
  encoder, and that colibri-web, colibri-unity and the admin UI announce this server's protocol
  version. Runs in CI. `npm run test:vectors -- --emit` prints the C# vector table.
- `npm run test:tcpclient`: manual smoke test against a server on this machine on `TCP_PORT`. Sends a
  v3 handshake, then echoes heartbeats.
  - `-- 1`: announce protocol version 1 to provoke a refusal.
  - `TCP_PORT=<port> npm run test:tcpclient -- --tls`: connect over TLS and print the SHA-256
    fingerprint of the server's certificate. Add `--insecure` for an untrusted certificate, e.g. a
    self-signed one, and `--host <name>` for another machine.
  - Exit codes: `0` connected and heartbeats received, `2` refused (prints the server's reason), `1` no
    heartbeat, or an undecodable frame (prints `Malformed frame from server` and ends the run).
  - `tsx test/tcp-crosstalk-check.ts [app] [ms] --tls [--insecure] [--host <name>]`: manual probe with
    the same TLS options.
- `npm run test:stressecho`: raw TCP client that answers the probes of colibri-unity's Network Stress
  sample, so one Unity editor can measure round trips (`npm run test:stressecho -- [app] [seconds]`).
- `npm run demo`: synthetic clients against a running server, so the admin UI has data to show without
  headsets. Two apps: `ArchViz` (a Unity editor, Quest 3, Quest 2 and a web dashboard) and `MuseumGuide`
  (Quest Pro and a web kiosk), with avatars synced at 30 Hz, log lines of every level including an
  exception, annotations added and deleted, and a headset that leaves and rejoins. The scene repeats
  every 3 minutes, and clients reconnect after a server restart, so it can run for hours. The server
  receives up to about 250 messages a second from them and sends up to about 550.
  - `-- --minutes <n>`: stop after n minutes, at most 35791 (about 24.8 days). Default: run until Ctrl+C.
  - `-- --apps <n>`: n copies of both apps, the others named `ArchViz-2`, `MuseumGuide-2` and so on,
    each with the same load.
  - `--web-port <port>`, `--tcp-port <port>`: default `WEBSERVER_PORT` and `TCP_PORT`. `--host <name>`:
    default `localhost`, which reaches a server on `127.0.0.1` or `::1`. `--tls` and `--insecure` as for
    `test:tcpclient`.
- `npm run test:docker`: requires Docker. Builds the image, or uses `COLIBRI_DOCKER_IMAGE`, and runs
  it in each deployment in the table. Pass deployment names to run only those.

  | Deployment | Setup |
  | --- | --- |
  | `bind-missing-dir` | Bind mount of a directory Docker creates |
  | `bind-root-owned-1x` | Root-owned 1.x data directory |
  | `named-volume` | Named volume |
  | `user-1000-named-volume` | `--user 1000:1000` on a named volume |
  | `user-1000-root-owned-dir` | `--user 1000:1000` on a root-owned directory |
  | `bind-read-only` | 1.x data mounted read-only |
  | `bind-world-writable-no-chown` | 1.x data without `CAP_CHOWN` |
  | `web-port-9111` | `WEBSERVER_PORT` in the environment |
  | `web-host-localhost` | `WEBSERVER_HOST=localhost` |
  | `web-port-from-env-file` | `WEBSERVER_PORT` in a mounted `.env` |
  | `tls-self-signed` | TLS on both ports |

  Each run must become healthy, stop cleanly and keep saved data across a restart, or, where it cannot
  save, report that with advice for the cause. With TLS, it also checks the served certificate, the
  refusal of a client without TLS, and renewal without a restart, which needs `openssl` on `PATH`.
  Each container is removed after its deployment, everything else at the end.
  `COLIBRI_DOCKER_PREFIX`, `COLIBRI_DOCKER_PORT` and `COLIBRI_DOCKER_TMPDIR` are described at the top
  of [`test/docker-image-check.ts`](../../test/docker-image-check.ts).
