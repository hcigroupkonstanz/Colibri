---
sidebar_position: 7
title: Voice Chat
---

# Voice Chat

Voice chat lets the users of all clients talk to each other, e.g. in a shared virtual environment. Each client
records its microphone and streams it through the server to the other clients of the app. The voice can play at
the position of an avatar, so users hear each other from the right direction.

Voice chat is available in Unity only, not in web clients.

## Components

Voice chat uses two components:

- `VoiceBroadcast` records the microphone and sends the audio under a voice id. Add it to an empty GameObject. Call
  `StartBroadcast` with any `short` voice id except `0`, and `StopBroadcast` to stop.
- `VoiceReceiver` plays the voice with one voice id. Add it to a GameObject, usually an avatar. It adds an
  `AudioSource`. Call `StartPlayback` with the voice id, and `StopPlayback` to stop. For several users, make a
  prefab with a `VoiceReceiver` and create one receiver per user.

Each client must tell the others its voice id, e.g. with [messages](./messages.md).

## Example

```csharp
using System.Collections.Generic;
using HCIKonstanz.Colibri.Communication;
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class VoiceChat : MonoBehaviour
{
    public VoiceBroadcast Broadcast;       // records and sends this client's microphone
    public GameObject VoiceReceiverPrefab; // prefab with a VoiceReceiver, e.g. an avatar

    short voiceId;
    HashSet<int> receivedIds = new HashSet<int>();

    void Start()
    {
        Sync.Receive<int>("voice", OnVoiceId);

        voiceId = (short)Random.Range(1, 32000);
        Broadcast.StartBroadcast(voiceId);
        InvokeRepeating(nameof(SendVoiceId), 0f, 1f);
    }

    // Repeated every second so that clients that join later also get the id.
    void SendVoiceId()
    {
        Sync.Send("voice", (int)voiceId);
    }

    void OnVoiceId(int id)
    {
        if (receivedIds.Add(id))
        {
            GameObject receiver = Instantiate(VoiceReceiverPrefab);
            receiver.GetComponent<VoiceReceiver>().StartPlayback((short)id);
        }
    }
}
```

Each client picks a random voice id, streams its microphone with `VoiceBroadcast` under that id and tells the other
clients its id with `Sync.Send` every second. When an id arrives for the first time, the script creates a
`VoiceReceiver` from the prefab, which plays that client's voice at its position.

The Voice Chat sample is a complete voice chat. Its `VoiceManager` also removes the receivers of clients that leave:
it destroys a receiver when its client's id has not arrived for 2 seconds.

## Requirements

- **Same app name.** The server forwards voice only to clients with the same app name. Voice ids must be unique only
  within your app.
- **A connected client.** The server accepts voice only from a client that is also connected for messages and
  synchronized objects, from the same address. The voice components do not open this connection. In a scene without
  `Sync` calls or a `SyncBehaviour`, call `Sync.Receive` once, as the example does.
- **Broadcasting.** A client hears others only while it broadcasts itself: the server learns where to send voice
  only from the voice a client sends. A client that only listens, with `VoiceReceiver`s but without a running
  `VoiceBroadcast`, hears nothing. Each client therefore needs a microphone.
- **Voice port.** The server's voice port (`9213` by default, UDP) must be reachable and must match *Voice server
  Port* in the [configuration](./configuration.md#advanced-settings). *Voice Sampling Rate* must match the server
  too.

## Settings

`VoiceBroadcast`:

| Setting | Default | Description |
|---|---|---|
| Microphone ID | `0` | The recording device to use. On Android, the default microphone is always used. |
| Microphone Buffer Length Seconds | `10` | Length of the recording buffer |
| Frame Size Milliseconds | `20` | Length of the audio in one packet |
| Use Opus Codec | off | Compress the audio. See [Opus](#opus). |
| Debugging | off | Log the available recording devices with their IDs, and more details |

`VoiceReceiver`:

| Setting | Default | Description |
|---|---|---|
| Fast Forward Playback | on | When more than *Fast Forward Latency Milliseconds* of audio waits, drop the oldest audio and keep the last packet, so the voice does not lag behind |
| Fast Forward Latency Milliseconds | `100` | The delay at which fast forward starts |
| Volume | `1` | Volume of this voice |
| Use Opus Codec | off | No effect. The receiver plays both PCM and Opus. |
| Debugging | off | Log more details |

- Calling `StartPlayback` with the id that is playing only restarts the `AudioSource` if Unity stopped it, e.g.
  because the GameObject was deactivated. Calling it with another id replaces the voice that is playing.
- `VoiceBroadcast` converts the microphone to the *Voice Sampling Rate* of the configuration.

## Opus

By default, the audio is sent uncompressed (PCM), which needs a lot of bandwidth. To reduce it, enable *Use Opus
Codec* on `VoiceBroadcast`.

- Opus works on Windows, Linux and Android, at a *Voice Sampling Rate* of 8, 12, 16, 24 or 48 kHz and a *Frame Size
  Milliseconds* of 5, 10, 20, 40 or 60. Otherwise `VoiceBroadcast` logs a warning and sends PCM.
- `VoiceReceiver` plays each packet in the format it was sent in. Where it cannot decode Opus (macOS, iOS, and the
  macOS Editor with Android as the build target), it drops Opus packets with one warning per receiver and still
  plays PCM.

## Spatial audio

The voice plays at the position of the `VoiceReceiver`. For spatial audio, enable *Spatialize* on its `AudioSource`
and set *Spatial Blend* to `1`. Spatializer plugins set in the audio settings work too.

## Android and Meta Quest

On Android, `VoiceBroadcast` asks the user for the microphone permission when it starts. If the user refuses, it
logs `[VoiceBroadcast] Voice Broadcast initialization failed: Microphone permission NOT granted` and does not
broadcast.

## Changing the app name at runtime

After the app name changes at runtime, voice stops until the client reconnects with the new app name. Messages and
synchronized objects, such as voice ids sent with `Sync.Send`, also stay in the old app until then. To move them,
disable and enable the `WebServerConnection` component on the `[WebServerConnection]` GameObject, which Colibri
creates when it connects.

## Limitations

- The voice is not encrypted, even with TLS.
- The app name separates apps, but it is no access control. Anyone who knows your app name can listen.
- Each voice packet goes to every other broadcasting client of the app, which limits the number of users.
- Without Opus, the bandwidth is high.
- Colibri 1 clients are not heard.
- Voice through a reverse proxy arrives from the proxy's address, which the server must trust. See the server's
  [configuration](../server/configuration.md).

If nobody is heard, see [Troubleshooting](./troubleshooting.md#voice-chat).
