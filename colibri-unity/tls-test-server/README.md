# TLS test server

A second colibri-server with TLS turned on, for the PlayMode tests in `Assets/Tests/TlsTests.cs`
and for the whole PlayMode suite run over TLS (`run-tests.mjs --tls`). `run-tests.mjs` starts it
next to the plain test server and stops it again afterwards.

**`cert.pem`, `key.pem` and `cert.pfx` are for these tests only.** The private key is public, here
in the repository, so anything encrypted with it is readable by anyone. Never use them for a server
that other people connect to; make your own as described in
[Self-signed certificate](../../colibri-server/docs/guide.md#self-signed-certificate) in the
colibri-server guide.

- Self-signed, issued for `localhost`, `127.0.0.1` and `::1`, valid for 100 years.
- SHA-256 fingerprint: `57:71:4B:56:18:11:5B:4C:C8:FD:92:AD:AF:DD:07:65:8F:EF:8B:23:B5:79:A2:E8:57:60:F4:25:A2:3C:89:F7`
- Made with:
  `openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 36500 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1" -addext "keyUsage=critical,digitalSignature,keyEncipherment" -addext "extendedKeyUsage=serverAuth" -addext "basicConstraints=critical,CA:FALSE"`
- `cert.pfx` is the same certificate with its key as PKCS#12 (password `colibri-test`), for the
  TLS that the tests' own fake server and proxy serve in a run over TLS (`run-tests.mjs --tls`, or
  `COLIBRI_E2E_TLS=1`). It uses 3DES and a SHA-1 MAC, which Mono can read:
  `openssl pkcs12 -export -in cert.pem -inkey key.pem -out cert.pfx -passout pass:colibri-test -certpbe PBE-SHA1-3DES -keypbe PBE-SHA1-3DES -macalg sha1`

To start it by hand, for running `TlsTests` from the Test Runner window:

```
docker compose -f colibri-unity/tls-test-server/compose.yml up -d --build
```

It listens on 9111 (web, https) and 9112 (TCP, TLS); `COLIBRI_E2E_TLS_PORT` and
`COLIBRI_E2E_TLS_TCP_PORT` change both, for the server and for the tests.
