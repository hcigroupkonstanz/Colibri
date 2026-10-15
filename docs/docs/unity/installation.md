---
sidebar_position: 1
title: Installation
---

# Installation

This page shows how to add Colibri to a Unity project and how to try the samples. After installing, continue with
[Configuration](./configuration.md).

## Requirements

- Unity 2022.3 or newer
- A [colibri-server](../server/installation.md) 2.0.0 or newer. To get started, you can use the public test server
  `colibri.hci.uni-konstanz.de` instead of your own.

Colibri 2 does not work with Colibri 1. A Colibri 2 client cannot connect to a Colibri 1 server, and a Colibri 2
server refuses Colibri 1 clients. Upgrade the server and all clients together.

## Package Manager (recommended)

In *Window → (Package Management →) Package Manager → + → Install package from git URL*, enter:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

- The Package Manager must list **Colibri 2.0.0** or newer. Errors about UniRx or UniTask mean that Colibri 1 is
  installed.
- The only dependency, `com.unity.nuget.newtonsoft-json`, is installed automatically.
- The *Colibri Setup* window opens automatically after the installation. See [Configuration](./configuration.md).

### Pinning a version

To install a specific version, append the tag of a [release](https://github.com/hcigroupkonstanz/Colibri/releases)
to the URL, e.g. `#v2.0.0`:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri#v2.0.0
```

The Package Manager records the installed commit either way. Colibri changes only when you update it in the
Package Manager.

## UnityPackage

1. Download the latest `.unitypackage` from the [releases page](https://github.com/hcigroupkonstanz/Colibri/releases)
   and import it with *Assets → Import Package → Custom Package*. Use a Colibri 2 package, not a Colibri 1 one.
2. A `.unitypackage` cannot install dependencies. In *Window → (Package Management →) Package Manager → + → Install
   package by name*, enter:
   ```
   com.unity.nuget.newtonsoft-json
   ```

The `.unitypackage` contains the samples in `Assets/Samples/Colibri/<version>/`. Delete the samples you do not need.

## Samples

Colibri comes with samples that show each feature:

| Sample | Shows |
|---|---|
| SendData | Sending and receiving [messages](./messages.md) of every supported type |
| SyncTransform | [SyncTransform](./synctransform.md) on objects placed in the scene and on objects created at runtime |
| SyncBehaviour | Your own synchronized scripts with [SyncBehaviour](./syncbehaviour.md) |
| Remote Store | Saving and loading an object with the [data store](./data-store.md) |
| Voice Chat | A complete [voice chat](./voice-chat.md) |
| Network Stress | Puts Colibri under load and shows throughput, latency and dropped messages |

### Importing a sample

With the Package Manager installation, select *Colibri* in the Package Manager, open the *Samples* tab and click
*Import* next to a sample. Unity copies it to `Assets/Samples/Colibri/` where you can edit it. Only imported samples
are part of your project and your builds.

With the `.unitypackage`, the samples are already in `Assets/Samples/Colibri/<version>/`.

The `[RemoteLogger]` and `[SyncTransformManager]` prefabs are part of the package, not of the samples. Drag them
from `Packages/Colibri/Prefabs/` in the Project window into your scene.

### TextMeshPro resources

The Remote Store, SendData, SyncTransform and Voice Chat scenes show their instructions with TextMeshPro, which
Colibri does not install. Without the TextMeshPro essential resources, these scenes throw a
`NullReferenceException` in `TMP_Settings`. Before you open them:

| Unity | Steps |
|---|---|
| 2022.3 | Install *TextMeshPro* (`com.unity.textmeshpro`) in the Package Manager if it is missing. Then run *Window → TextMeshPro → Import TMP Essential Resources*. |
| 6 | TextMeshPro is part of `com.unity.ugui`. Run only *Window → TextMeshPro → Import TMP Essential Resources*. |

### Trying a sample with two clients

To see Colibri at work, you need two clients with the same configuration. You have these options:

- Copy the `Assets`, `Packages` and `ProjectSettings` folders to a new folder and open it from Unity Hub as a second
  client. Unity cannot open one project twice. The copy includes your configuration and the imported samples.
- Build the project and run it on a second device. A build has no Inspector and writes its log to a file, so
  samples that you control from the Inspector work best in two Editors.

For example, with the SendData sample:

1. [Configure](./configuration.md) Colibri with an app name and a server address, and enable *Run In
   Background/Run Without Focus*.
2. Import the SendData sample.
3. Copy the project as described above and open the copy in a second Editor.
4. Open the sample scene in both Editors and enter Play mode in both.
5. In one Editor, select the `[ClickMe]` object and enable *Send Properties* on its `SendMessages` component.
6. The other Editor logs `Received message with value …` for each value. The sending Editor logs nothing, because a
   client never receives its own messages.

If nothing arrives, see [Troubleshooting](./troubleshooting.md).

## Upgrading from Colibri 1

To upgrade a project from Colibri 1, follow the
[migration guide](https://github.com/hcigroupkonstanz/Colibri/blob/develop/MIGRATION.md). Among other things, a
configuration saved by Colibri 1 keeps the old ports 9011 to 9013, while a Colibri 2 server uses 9211 to 9213 by
default.
