# Colibri Unity

## Requirements

Unity 2019.4 or higher

## Installation

### Package Manager (Recommended)

Add the following Git URLs to the Unity Package Manager:

```
https://github.com/Cysharp/UniTask.git?path=src/UniTask/Assets/Plugins/UniTask
```
```
https://github.com/neuecc/UniRx.git?path=Assets/Plugins/UniRx/Scripts
```
```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

### UnityPackage

Download the latest release from GitHub and import it to your Unity project.

## Configuration

Upon installation, a configuration window should show up:

<img src="img/config.png" alt="Config Screen" width=400/>

- Enter the URL of your (shared) [server](../colibri-server). A public test server can be found at `colibri.hci.uni-konstanz.de` (beware of network latency!)
- Choose a unique *app name*. Though a server supports multiple clients, data is only synchronized between clients with identical *app names*!
- To adjust the Colibri Configuration you can reopen the window in Unity under "Window" -> "Colibri Configuration" 
- All changes are saved to `Resources/ColibriConfig`

### Advanced Configuration

If your server is running a non-default configuration, the advanced configuration allows you modify server ports.
Do not modify port numbers unless you know what you are doing!

When using the REST API, the `UnityWebRequest` does not allow Non-Https calls.
All requests are sent by default using `https`. Disable the toggle `SSL/TLS` and `http` will be used for all request.
Make sure to `Allow download over HTTP` in the Player Settings!

When using the voice chat, Colibri allows to adjust the sampling rate on the server. In this case, clients need to manually set the `Voice Sampling Rate` setting in the configuration.

Default values:

- Web server Port: `9011`
- TCP server Port: `9012`
- Voice server Port: `9013`
- Voice Sampling Rate: `48000`

## Samples

Samples can be found in the `Samples` tab (when installed via Package Manager) or in the `Colibri/Samples` folder (when installed via UnityPackage).

## Documentation

### Web Interface for Logging

<img src="img/weblogger.png" alt="WebLogger" width=400/>

Colibri provides a *web logger* with web interface to send diagnostic data (currently: console logs) to the server. This may be useful for devices (e.g., VR devices, smartphones) where access to the console is not easily available.

To setup, add the `[RemoteLogger]` prefab to your scene. The Unity log output should be redirect to your server's webinterface, which can be accessed via `http://<your-server-ip>:9011`.

### Sending Data between Clients

Colibri supports simple data transmission via pub/sub communication. Data can be published from anywhere in
the executed code, as illustrated with the following simple example of sending a float value `myNumber` on a `MyChannel` channel:

```c#
float myNumber = 5;
Sync.Send("MyChannel", myNumber);
```

The sent data can then be received anywhere within Unity by registering a listener:

```c#
void Start() {
    Sync.Receive("MyChannel", (Action<float>)MyListener);
}

private void MyListener(float myNumber) {
    // This code that will be executed whenever
    // a float is received on "MyChannel"
}
```

The listener can be deregistered with `Sync.Unregister`:

```c#
private void OnDestroy() {
    Sync.Unregister("MyChannel", (Action<float>)MyListener);
}
```

The following types (including arrays) are available for sync: 
- `bool`
- `int`
- `float`
- `string`
- `Vector2`
- `Vector3`
- `Quaternion`
- `Color`

For custom types, Colibri supports JSON (via Newtonsoft.JSON): 

```c#
Sync.Send("myJson", new JObject
{
    { "attribute1", "example" },
    { "attribute2", 5 }
});

Sync.Receive("myJson", (Action<JToken>)MyListener);

private void MyListener(JToken jtoken) {
    string attribute1 = jtoken["attribute1"].Value<string>(); 
    int attribute2 = jtoken["attribute2"].Value<int>();
}
```

Serializable classes can automatically serialized and deserialized:

```c#
using System;

[Serializable]
public class ExampleClass
{
    public int Id;
    public string Name;
}
```

```c#
ExampleClass exampleObject = new ExampleClass();
exampleObject.Id = 1234;
exampleObject.Name = "Charly Sharp";

Sync.Send("example", JToken.FromObject(exampleObject));
```

```c#
Sync.Receive("example", (Action<JToken>)MyListener);

private void MyListener(JToken jtoken) {
    ExampleClass exampleObject = jtoken.ToObject<ExampleClass>();
}
```

Limitations:

- You have to register the listener *before* sending out data
- Type and channel *must* match between Listener and Sender
- Remember to unregister your listener where necessary!
- Due to overloading, some methods may have to be cast explicitly: `Sync.Receive("...", (Action<JToken>)OnJsonMessage);`



### SyncTransform

For synchronizing the location of an object, Colibri provides a `SyncTransform` script. Simply attach the script to an object, and its active state, position, rotation, and scale will be synchronized between all clients. Set `UseLocalTransform` to `true` to synchronize the local coordinates of the object. See SyncTransform samples for more information.

Information about the object's state is stored on the server. When a new client connects, the location is automatically updated to its current state.

`SyncTransform` also supports physics. `PhysicsAuthority` defines which client is currently controlling the physics. Only one client can control the physics of an object at a time. If the `PhysicsAuthority` is set to `true` on one client it is automatically set to `false` on all other clients. If the `PhysicsAuthority` is checked by default, the first client receives the physics authority. The `isKinematic` field of the attached `Rigidbody` will be overwritten by the `isKinematic` field of the `SyncTransform`. Therefore, if you want to change this field, always (additionally) set the `isKinematic` field of the `SyncTransform`.

For dynamically created objects, add a `[SyncTransformManager]` prefab to the scene. Create a prefab of the object you'll dynamically instantiate and add it to the `Template` attribute. Set the `ModelId` (in the `SyncTransform`) of the prefab to a custom value that identifies the prefab. When a client instantiates an object with `SyncTransform` and the same `ModelId`, the Manager will automatically create an object using this prefab and synchronize it. Make sure to leave the `Id` field of the prefab blank!

<img src="img/synctransformmanager.png" alt="SyncTransformManager" width=400/>

Limitations:

- Only one client can update the each attribute of the object simultaneously
- Scene will be reset once all clients disconnect

### Remote Store

Colibri offers persistent data storage on the server, so that data can be saved easily between sessions. `[Serializable]` objects can be uploaded via a RESTful interface of the `Store` object:

```c#
// Create example object
ExampleClass exampleObject = new ExampleClass();
exampleObject.Id = 1234;
exampleObject.Name = "Charly Sharp";

// Save example object using REST API
bool putSuccess = await Store.Put("exampleObject", exampleObject);
Debug.Log($"Success: {putSuccess}");
```

or retrieved again:

```c#
ExampleClass exampleObject = await Store.Get<ExampleClass>("exampleObject");
if (exampleObject != null)
{
    // Use fetched "exampleObject"
}
else
{
    Debug.LogError("Get Example Object failed!");
}
```

Limitations:

- Data fetching happens manually (data won’t be automatically updated!)
- If you want to synchronize custom classes, use the built-in `[Serializable]` attribute on your class

### SyncBehaviour

For more complex scenarios, Colibri supports synchronization of data models (e.g., for use in model-view-controller architectures). For this, we need a model script and a manager script.

The model script has to inherit from `SyncBehaviour<T>` instead of `MonoBehaviour`. Afterward, just add `[Sync]` to the property or field you want to synchronize:

```c#
public class MyClass : SyncBehaviour<MyClass>
{
    [Sync]
    public string MyString = "123";

    [Sync]
    private Vector3 Position
    {
        get { return transform.localPosition; }
        set { transform.localPosition = value; }
    }
}
```

The manager just requires a declaration matching the model script:

```c#
public class MyClassManager : SyncBehaviourManager<MyClass>
{
    // No code necessary – just add this script
    // to your scene (e.g., on an empty GameObject)
}
```

The manager should be added to your scene (e.g., on an empty GameObject), and the manager requires a Prefab with the model script for synchronizing different objects. 

By the way: `SyncTransform` is also a `SyncBehaviour`.

Limitations:

- Only one client can update each attribute of the object simultaneously
- Scene will be reset once all clients disconnect

### Voice Chat

Colibri also offers a voice chat for remote scenarios. The voice chat consists of two scripts `VoiceBroadcast` and `VoiceReceiver`.

`VoiceBroadcast` records the microphone audio and streams it over the network. Simply attach the script to an empty `GameObject`. To start broadcasting, call the `StartBroadcasting` method with any (`short`) voice id:

```c#
// Create random voice id
VoiceId = (short)UnityEngine.Random.Range(1, 32000);
VoiceBroadcast.StartBroadcast(VoiceId);
```

`VoiceReceiver` receives and playbacks the voice data of a specific voice id. Attach the script to a `GameObject` of your choice. This is usually a user representation, such as an avatar. When attaching the script, an `AudioSource` is automatically added. To support mulitple `VoiceReceiver` create a prefab of the object. To start receiving voice data, call the `StartPlayback` method with the specific voice id of the client. For the distribution of active voice ids of other clients, `Sync.Send` can be used:

```c#
void Start()
{
    Sync.Receive("VoiceChat", OnIdArrived);
}

private void OnIdArrived(int id) 
{
    GameObject voiceReceiverPrefab = Instantiate(VoiceReceiverPrefab);
    voiceReceiverPrefab.GetComponent<VoiceReceiver>().StartPlayback((short)id);
}
```

See `Samples/VoiceChat` for a fully working voice chat example with a `VoiceManager` handling voice ids and the instantiation of `VoiceReceiver` prefabs.

By default, the voice chat transmits audio as raw PCM data. However, to reduce throughput, the Colibri voice chat also supports Opus codec compression on Windows, Linux, and Android. In order to use the Opus codec, enable the `Use Opus Codec` toggle on both the `VoiceBroadcast` and `VoiceReceiver`.

Colibri voice chat also supports spatial audio. The `VoiceReceiver` position in the scene defines the playback location of the voice. Make sure that `Spatialize` is enabled on the `AudioSource` and that `Spatial Blend` is set to `1` (3D). This also works with a spatializer plugin set in the audio settings. 

Limitations:

- Only limited scalability, because voice data is distributed to all active clients on the server using `VoiceBroadcast`
- Only limited security, as voice data can be received by knowing the voice ID, regardless of the app name set in the Colibri configuration.
- Without enabling Opus high throughput

## License

Copyright (c) HCI Group University of Konstanz. All rights reserved.

Licensed under the [MIT](../LICENSE) license.

This repository includes third-party open source libraries as listed in [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES.txt).
