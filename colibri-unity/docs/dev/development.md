# colibri-unity development

For developers working on colibri-unity itself. Using Colibri: [README](../../README.md).
Code conventions: [conventions.md](conventions.md).

## Running the tests

```sh
node colibri-unity/run-tests.mjs              # both suites
node colibri-unity/run-tests.mjs --editmode   # unit tests only, no server needed
node colibri-unity/run-tests.mjs --playmode   # end-to-end only
node colibri-unity/run-tests.mjs --editmode --stripping   # plus the code-stripping check
node colibri-unity/run-tests.mjs --tls        # plus the PlayMode suite again, over TLS
```

| Suite | Location | Description |
|---|---|---|
| EditMode | `Assets/Colibri/Tests/Editor/` | NUnit tests of the framing, JSON conversions, diagnostics, outage queue, message dispatch, `[Sync]` accessors (including the IL2CPP path), send-rate limit, connect timeout, server address lookup with IPv6, Store URLs, build settings check, app-name warning, and the voice server address, sends, socket, packet format, packet queue, resampling, framing, decoding and playback buffer. Needs no server and runs wherever Unity runs. |
| PlayMode | `Assets/Tests/` | A Unity client and a raw v3 peer against a running `colibri-server`. Reconnects go through a proxy the test can cut. Mismatch detection runs against a scripted stand-in server. |

For PlayMode, the script starts colibri-server with `docker compose` and stops it afterwards. A
server already listening on the port is used and left running. The script also starts a TLS server
from `tls-test-server/compose.yml` ([README](../../tls-test-server/README.md)) on ports 9111 (https)
and 9112 (TLS) for `TlsTests` and `StoreOverTlsTests`. Without it, these tests are skipped, and the
script reports this. The certificate files in `tls-test-server/` (`cert.pem`, `key.pem`, `cert.pfx`)
are public and for tests only.

Results go to `TestResults/` as NUnit XML plus the Editor log. Without a reachable server, the
end-to-end tests are skipped and name the command that fixes it. A suite whose tests were all
skipped counts as failed.

`--tls` runs the PlayMode suite again with every connection over TLS, including the tests' own fake
server and proxy, into `TestResults/PlayMode-TLS.xml` and `.log`. `ProtocolMismatchDetectionTests`
skip themselves in that run. Without the TLS server, `--tls` fails.

`--stripping` checks that `[Sync]` members survive managed code stripping, which the Editor never
applies. It builds and runs a Release IL2CPP player of `Assets/StrippingCheck/` for the Editor's
desktop platform with *Managed Stripping Level* High. The player checks that every `[Sync]` member
of `SyncTransform` and of a test model (a private serialized field, public value and reference
fields, a property) keeps its `[Sync]`, applies an update to each and checks the values. It prints
the results and exits with 1 on any failure. The check takes a few minutes and needs the platform's
IL2CPP module but no server. Without the module, it is skipped with a notice. `ProjectSettings` are
restored exactly after the build.

These connect-timeout tests are skipped on Windows, which refuses connections to a full listen
backlog instead of leaving them unanswered:
`ConnectTimeoutTests.AnAttemptNothingAnswersIsGivenUpAfterTheTimeout`,
`ConnectTimeoutTests.CancellingGivesUpTheAttemptAtOnce` and
`ProtocolMismatchDetectionTests.AnAttemptNothingAnswersIsGivenUpAfterFiveSecondsAndRetried`. On
Windows, check manually that a client with an unreachable server address leaves *Connecting* after
5 s.

| Variable | Default | Description |
|---|---|---|
| `COLIBRI_E2E_SERVER` | unset | Host of a server to use instead of starting one. When set, the script never starts or stops anything. |
| `COLIBRI_E2E_PORT` | `9211` | Web/Socket.IO port |
| `COLIBRI_E2E_TCP_PORT` | `9212` | Binary v3 port |
| `COLIBRI_E2E_NO_BUILD` | unset | Skip `docker compose --build` |
| `COLIBRI_E2E_TLS_PORT` | `9111` | TLS server's web port (https) |
| `COLIBRI_E2E_TLS_TCP_PORT` | `9112` | TLS server's binary v3 port (TLS) |
| `COLIBRI_E2E_TLS_CERT` | `tls-test-server/cert.pem` | TLS server's certificate |
| `COLIBRI_E2E_TLS` | unset | `1` runs the PlayMode suite over TLS. `--tls` sets it. |
| `COLIBRI_E2E_TLS_PFX` | `tls-test-server/cert.pfx` | Certificate the tests' own fake server and proxy serve over TLS |
| `UNITY_PATH` | Unity Hub's location | Editor to use |

Unless `UNITY_PATH` is set, the script requires the exact Editor version in
`ProjectSettings/ProjectVersion.txt`. Another version would upgrade the project in place and change
the manifest and half of `ProjectSettings`. If that version is not installed, the script lists the
installed ones and the `UNITY_PATH` to use. Commit such an upgrade on its own. The package supports
Unity 2022.3 LTS and newer. The pinned version applies only to the development project.

Both suites also run in *Window → General → Test Runner*. The end-to-end tests enable *Run In
Background* themselves. For the TLS tests, start the TLS server with
`docker compose -f colibri-unity/tls-test-server/compose.yml up -d --build`. For a run over TLS,
also set `COLIBRI_E2E_TLS=1` in the Editor's environment.

Voice chat has no end-to-end tests, because they need a microphone. Unit tests cover only the server
address choice, failed sends, the socket and its receive thread over the IPv6 loopback, the packet
format with its app id, the queue that hands received packets to the main thread, how recorded audio
is resampled and cut into frames, with the fallback to PCM, and how received packets are decoded and
handed to the audio thread.

## Exporting the .unitypackage

*Tools → Colibri → Export .unitypackage* exports `Assets/Colibri` and the samples for the releases
page. The samples are in `Assets/Colibri/Samples~`, which Unity does not import, so a plain *Export
Package* leaves them out. The export copies them with their `.meta` files to
`Assets/Samples/Colibri/<version>/<sample name>`, exports them with the package and deletes the
copies afterwards. If `Assets/Samples` already exists, the export stops without changing anything.

From the command line, with an absolute output path, since Unity runs in the project folder:

```sh
COLIBRI_UNITYPACKAGE="$PWD/Colibri-2.0.0.unitypackage" <Unity> -batchmode -nographics -projectPath colibri-unity \
  -executeMethod HCIKonstanz.Colibri.Release.Editor.UnityPackageExport.Export
```
