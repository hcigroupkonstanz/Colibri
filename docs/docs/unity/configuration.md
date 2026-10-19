---
sidebar_position: 2
title: Configuration
---

# Configuration

Colibri needs to know which server to connect to and which app your clients belong to. You set both once per
project in the *Colibri Setup* window. This page also covers the settings for TLS, other server ports and builds for
Meta Quest and Android.

## Colibri Setup window

1. Open *Window → Colibri Configuration*. The window opens automatically while the project has no configuration.
2. Set **App Name** to a name that is unique to your project. Clients exchange data only if their app names match.
3. Set **Server Address** to the address of the Colibri server you want to use. The address is a host name or IP
   address without `http://`. A public test server is available: `colibri.hci.uni-konstanz.de`.
4. Click *Save Config*.

![The Colibri Setup window](/img/unity/config.png)

*Save Config* writes the configuration to `Assets/Resources/ColibriConfig`. All copies and builds of the project use
this file, so every client of your project has the same app name and server.

:::warning
Colibri has no authentication. Anyone who can reach a server and knows your app name can read and change your app's
data. Do not send sensitive data through the public test server. For sensitive data, run your
[own server](../server/installation.md) on a trusted network.
:::

### Run In Background

Enable *Project Settings → Player → Resolution and Presentation → **Run In Background/Run Without Focus***. It is off
by default. Without it, a Unity Editor that is not in focus pauses the game: it sends nothing and calls no
listeners until it is in focus again, although *Window → Colibri Status* still shows *Connected*. This matters
most when you test with two Editors side by side.

On Android, including Meta Quest, this setting has no effect.

### App name

All clients with the same app name on a server form one app. They see each other's synchronized objects, messages
and data store values. Clients with different app names do not see each other.

- Use an app name that is unique on the server, especially on a shared server such as the public test server.
  Another project with the same app name sees your objects and messages, and you see theirs.
- The server's work grows with the square of the number of clients in one app.
- The window warns about app names that others are likely to use too, ignoring case: `myAppName` (used by the
  web client's samples), `myApp`, `appName`, `app`, `test`, `testApp`, `demo`, `example`, `colibri` and `default`.

### Changing settings

- Valid changes apply at once, even before you click *Save Config*. An open connection keeps its server and app
  name until it reconnects.
- Invalid values, such as an empty app name, an address with `http://` or port 0, are marked as errors. Colibri
  neither uses nor saves them and keeps the last valid value.
- Changes made elsewhere, e.g. in the Inspector of the `ColibriConfig` asset, appear in the window.

## Server addresses

The server address can be a host name, an IPv4 address or an IPv6 address. An IPv6 address works with or without
brackets, e.g. `2001:db8::1` or `[2001:db8::1]`.

- On a headset or smartphone, `localhost` is the device itself, not your computer. Use the LAN IPv4 address of the
  computer that runs the server, e.g. `192.168.0.10`.
- A host name can have several IP addresses. Colibri tries its IPv4 addresses first, then its IPv6 addresses. When
  one does not work, the console shows `Colibri: no connection to …, trying …` and Colibri tries the next one.
- Once connected, the console shows the address in use:
  `Colibri: connected to colibri.example.org:9212 (192.0.2.10) as app '…'`.
- colibri-server listens on IPv4 only by default. For a server name that has only IPv6 addresses, the server must
  also listen on IPv6. See the server's [configuration](../server/configuration.md).
- [Voice chat](./voice-chat.md) uses the server's IPv4 address when it has one. If the IPv4 address does not answer
  but the IPv6 address does, the client connects over IPv6 while voice chat still uses IPv4, and nobody hears this
  client. Make the IPv4 address reachable, or remove it from DNS.

## Advanced settings

The settings under *Optional Config* must match the server. Change them only if the server does not use the
defaults.

| Setting | Default | Description |
|---|---|---|
| Server supports SSL/TLS? | off | Encrypt the connection. Tick it if the server has TLS enabled. Voice chat stays unencrypted. See [TLS](#tls). |
| Allow self-signed certificate | off | With TLS, accept a certificate the device does not trust, e.g. a self-signed one. See [Certificates](#certificates). |
| Server certificate SHA-256 | empty | With TLS, accept only the certificate with this fingerprint. Paste it from the server log. See [Certificates](#certificates). |
| Web server Port | `9211` | The server's web port, used by the [data store](./data-store.md) |
| TCP server Port | `9212` | The server's port for Unity clients |
| Voice server Port | `9213` | The server's port for [voice chat](./voice-chat.md) |
| Voice Sampling Rate | `48000` | Must match the server's `VOICE_SAMPLING_RATE`. Between 16000 and 48000. |
| Max Send Rate (Hz) | `30` | Updates per second per synchronized object, `0` for no limit. See [Send rate](./syncbehaviour.md#send-rate). |

- The three ports must differ from each other.
- A configuration saved by Colibri 1 keeps the Colibri 1 ports 9011, 9012 and 9013. Change them to 9211, 9212 and
  9213 unless your server still uses the old ports.
- With *Max Send Rate* set to `0`, the window warns: every moving object then sends an update in every frame, which
  a server and a Wi-Fi network cannot handle for dozens of clients.

### Allow downloads over HTTP

Without TLS, the [data store](./data-store.md) uses plain `http`. Unity blocks plain `http` except to `localhost`
and other loopback addresses. For any other server, including any server you reach from a headset, set *Project
Settings → Player → Other Settings → **Allow downloads over HTTP*** to *Always allowed*, or use [TLS](#tls).
Otherwise every data store request fails with "Insecure connection not allowed".

*Allowed in development builds* is enough for development builds only. Colibri checks this setting in the
[build settings check](#build-settings-check).

## TLS

*Server supports SSL/TLS?* encrypts the connection to the server and switches the data store to `https`.

- Tick it when the server has TLS enabled, or when a reverse proxy in front of the server provides TLS on the TCP
  port. See the server's [configuration](../server/configuration.md).
- The setting must match the server. The server's TCP port accepts either only TLS or no TLS.
- The client checks the certificate against the *Server Address* as you entered it.
- [Voice chat](./voice-chat.md) stays unencrypted, even with TLS.
- Colibri's console messages call this setting 'Server supports SSL/TLS', without the question mark.

### Certificates

| Certificate | Setting | Result |
|---|---|---|
| Issued by a certificate authority, e.g. Let's Encrypt | none | Checked against the device's trusted certificates, also on Android and Meta Quest |
| Self-signed, pinned | *Server certificate SHA-256* | Only this certificate is accepted, whether the device trusts it or not. Its names are not checked, so certificates for IP addresses work too. |
| Self-signed, not pinned | *Allow self-signed certificate* | Untrusted certificates are accepted. The connection is encrypted, but nothing checks that it goes to your server. The console warns once per session and shows the fingerprint to pin. |

- Both settings appear only when *Server supports SSL/TLS?* is ticked. Both are off by default, so only trusted
  certificates are accepted.
- The fingerprint consists of 64 hexadecimal digits. Case and colons do not matter. Anything else is an error in the
  Setup window and is neither used nor saved.
- You find the fingerprint in the server's startup log (`TLS is on, ... SHA-256 fingerprint AB:CD:...`), in
  Colibri's warning or error message, and in the *SHA-256* row of *Window → Colibri Status*, where you can select
  and copy it.
- Do not pin Let's Encrypt certificates. Each renewal changes the fingerprint.
- The data store's `https` requests follow both settings.
- Next to the server address, *Window → Colibri Status* shows how the certificate was accepted:
  `trusted by this device`, `matches 'Server certificate SHA-256'` or
  `not trusted, accepted because 'Allow self-signed certificate' is on`.

If the connection fails because of TLS, see [TLS errors](./troubleshooting.md#tls-errors).

## Meta Quest and Android

Meta Quest apps are Android builds. Switch the platform to Android in *File → Build Settings* (*File → Build
Profiles* in Unity 6). The Quest needs ARM64, which on Android requires the IL2CPP scripting backend.

- Use the server's LAN IPv4 address as the server address, not `localhost` ([Server addresses](#server-addresses)).
- *Run In Background* has no effect on Android.
- On Android, [voice chat](./voice-chat.md) asks for the microphone permission when it starts.
- Keep *Project Settings → Player → Other Settings → Managed Stripping Level* at *Minimal* if you send your own
  classes as JSON or save them in the data store. Higher levels may remove members of classes that only Newtonsoft
  JSON uses. Alternatively, mark these classes with `[Preserve]` or list them in a `link.xml`. `[Sync]` members are
  always kept.

### Build settings check

Two Player settings fail only in the built app, where you have no console. Colibri checks them after every script
reload, after switching the build target and at the start of every build, and warns in the console. The build
continues anyway. *Window → Colibri Configuration* lists the issues with a button that fixes each one, under
**Android / Meta Quest** (Android target) or **Player build** (other targets).

| Setting (*Player → Other Settings*) | Required | Checked | Warning | Otherwise |
|---|---|---|---|---|
| *Internet Access* | *Require* | Android target | `Colibri (Android build): Internet Access is set to Auto. …` | The build may lack the permission to use the network. The app starts but never connects. |
| *Allow downloads over HTTP* | *Always allowed* | All targets, if TLS is off and the server is not `localhost` | `Colibri (build): Allow downloads over HTTP is '…' …` | Every data store request fails with "Insecure connection not allowed". |
