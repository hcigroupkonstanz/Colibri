# colibri-unity 2.0.0: ease of use and the sync loop

Companion to [`v2-changes.md`](dev/v2-changes.md), covering the last pass over colibri-unity 2.0.0 in
the depth a change log cannot carry: what changed, why, how the replacements work, and what the
Editor verification showed, including the two numbers that were only ever argued before it.

Two goals, and they turned out not to conflict:

1. **A developer with some C# and little Unity experience should get a prototype running in the
   first hour.** Every silent failure and every manual install step is an hour not spent on the
   prototype.
2. **Synchronization stays real-time.** Under good network conditions the client must not be the
   thing that adds latency or frame-time cost.

The first goal was pursued by deleting both third-party runtime dependencies. That could have cost
the second one. It did the opposite: the libraries were paying for abstractions on the per-frame
path, and removing them made the sync loop allocation-free while idle.

---

## Contents

- [Why](#why)
- [1. Installation: three packages to one URL](#1-installation-three-packages-to-one-url)
- [What you actually write](#what-you-actually-write)
- [2. The sync loop](#2-the-sync-loop)
- [3. Removing UniTask](#3-removing-unitask)
- [4. Four silent failures, made loud](#4-four-silent-failures-made-loud)
- [5. `Window → Colibri Status`](#5-window--colibri-status)
- [6. API changes](#6-api-changes)
- [7. Migrating an existing project](#7-migrating-an-existing-project)
- [8. Verification status](#8-verification-status)
- [9. Decisions, and what was deliberately not done](#9-decisions-and-what-was-deliberately-not-done)
- [Appendix: file map and commits](#appendix-file-map-and-commits)

---

## Why

The 2.0.0 protocol work fixed the wire format but made onboarding *worse*. Installing Colibri had
grown to three packages, one of which (R3) ships in two halves and additionally needs NuGetForUnity.
Miss half of it and Unity produces a wall of `The type or namespace name 'R3' could not be found`
with nothing pointing at the cause.

On top of that, four things failed in complete silence, and all four are things a new user hits in
the first hour:

| Situation | What happened before |
|---|---|
| `Send("ch", 5f)` with `Receive("ch", (Action<string>)H)` | No listener list matched. Returned. **No log, ever.** |
| `Sync.Receive("ch", MyHandler)` without a cast | Compile error: 17 overloads make the method group ambiguous |
| No `Resources/ColibriConfig.asset` | The connect loop polled forever without a word, and `ColibriConfig.GetWebUrl` threw a `NullReferenceException` |
| "Am I even connected?" | Only answerable by reading Console logs |

Nobody can debug a failure that says nothing. The whole point of this pass is that the common
mistakes now name themselves.

---

## 1. Installation: three packages to one URL

**Before:** `com.unity.nuget.newtonsoft-json`, UniTask via git URL, NuGetForUnity via git URL, R3
core via the NuGet window, R3's Unity layer via git URL, then Colibri. Six steps, four of which had
to be done by hand because a UPM `dependencies` entry cannot express a NuGet package.

**After:** one URL:

```
https://github.com/hcigroupkonstanz/Colibri.git?path=colibri-unity/Assets/Colibri
```

`com.unity.nuget.newtonsoft-json` is the only remaining dependency, and it is declared in
`Assets/Colibri/package.json`, so the Package Manager resolves it automatically.

Without a `#ref` the URL resolves to the repository's default branch; appending a release tag
(e.g. `#v2.0.0`) pins one version. A 1.x package installed this way does not compile without UniRx
and UniTask, which its asmdef references, and it speaks the v1 protocol.

What was removed along the way:

- `com.cysharp.r3` and `com.cysharp.unitask` from `Packages/manifest.json` and `packages-lock.json`
- `"R3.Unity"`, `"UniTask"` from `Colibri.asmdef` `references`, and `"R3.dll"` from
  `precompiledReferences`
- `"Unity.TextMeshPro"` from `references`: nothing in Colibri used it. It resolved only because
  `com.unity.ugui` happens to ship that assembly, so it was a latent failure in any project without
  ugui, in exchange for nothing.
- The R3 and UniTask entries in `THIRD_PARTY_NOTICES.txt`

Total call sites removed: eight. That is what the two dependencies were buying.

---

## What you actually write

Everything below this section is internals. This is the surface, and the surface is the point, so it
is worth seeing before the machinery.

### Level 0: no code at all

Add `SyncTransform` to a GameObject and drop one `SyncTransformManager` in the scene. Position,
rotation, scale and active state now follow every other client. Nothing to write, nothing to
register, nothing to unregister.

### Level 1: send a value to everyone

```csharp
// Ping.cs
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Ping : MonoBehaviour
{
    void OnEnable()
    {
        Sync.Receive<Vector3>("ping", OnPing);
    }

    void OnDisable()
    {
        Sync.Unregister<Vector3>("ping", OnPing);
    }

    // Hook this up to a UI Button.
    public void SendPing()
    {
        Sync.Send("ping", transform.position);
    }

    void OnPing(Vector3 where)
    {
        Debug.Log($"Someone pinged at {where}");
    }
}
```

That is the whole thing. No connection to open, no server object to find, no coroutine: the first
call to `Sync.Receive` brings the connection up by itself.

The `<Vector3>` is the change. The same script before:

```csharp
//                              vvvvvvvvvvvvvvvvv  and you had to know to write this
Sync.Receive("ping", (Action<Vector3>)OnPing);
Sync.Unregister("ping", (Action<Vector3>)OnPing);
```

Without the cast, `Sync.Receive("ping", OnPing)` failed to compile against 17 overloads with an
error message that pointed at overload resolution rather than at anything in the calling code. It
is the single most common wall people hit in the first ten minutes.

### Level 2: a shared object

```csharp
// Player.cs: every client sees the same Players, with these two values kept in step.
using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

public class Player : SyncBehaviour<Player>
{
    [Sync] public int Score;
    [Sync] public Color Colour;
}
```

```csharp
// PlayerManager.cs: one in the scene, so clients can create Players for each other.
using HCIKonstanz.Colibri.Synchronization;

public class PlayerManager : SyncBehaviourManager<Player> { }
```

Assign `Score` from anywhere and every other client's `Player` has the new value on its next frame.
There is no `SendScore()` and nothing to call: §2 is the machinery that makes plain field assignment
enough, and it is why that machinery has to be cheap.

> Two `MonoBehaviour`s cannot share one `.cs` file in Unity: only the class matching the filename
> can be added to a GameObject. Hence two files.

### What it looks like when you get it wrong

This is the part that did not exist before. Send a `float` on a channel whose listener expects an
`int`, and the message used to vanish without a word. Now:

```
Colibri: a float arrived on channel 'score', but the listener registered there expects int.
The message was dropped, because Colibri matches messages on the channel *and* the type.
Either send it as int, or listen for it with Sync.Receive<float>("score", MyHandler).
```

Forget to configure the project, and instead of a `NullReferenceException` from whichever call site
happened to touch the config first:

```
Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name,
and press Save Config. (Every client that should see each other has to use the same App Name.)
```

Get connected but see nobody, and the connect log already names the reason:

```
Colibri: connected to 192.168.0.10:9212 as app 'my-ar-prototype'.
Only clients using the same App Name can see each other.
```

Put a type Colibri cannot serialize behind `[Sync]`, and it is reported when the scene loads rather
than on the first message that happens to arrive:

```
Colibri: cannot synchronize 'Player.Inventory' - [Sync] does not support Dictionary`2.
Supported types are bool, int, float, string, Vector2, Vector3, Quaternion, Color, JObject
and arrays of those. For your own classes, sync a JObject built with JToken.FromObject(...).
```

---

## 2. The sync loop

### What it looked like

`SyncBehaviour<T>.Awake` subscribed once **per synced attribute**:

```csharp
Observable.EveryValueChanged(this, _ => attribute.Value.Getter(this as T))
    .Where(_ => _hasReceivedFirstUpdate)
    .Subscribe(_ => AddUpdate(attribute.Key, attribute.Value.Getter(this as T)))
    .AddTo(this);
```

with the getter typed as `Func<T, object>`, built from an expression tree that ends in
`Expression.Convert(exBody, typeof(object))`.

`GenericSyncTransform` declares five `[Sync]` members: `Active` (bool), `Position` (Vector3),
`Rotation` (Quaternion), `Scale` (Vector3), `PhysicsId` (string). So every `SyncTransform` in the
scene meant:

- **five** R3 frame-provider work items, each running a `Where` → `Subscribe` chain every frame;
- **four boxes per frame**, every frame, whether or not anything moved (`string` is already a
  reference type, so it does not box);
- one `async void` state machine allocated per change, because `SendUpdate()` coalesced a frame's
  changes with `await UniTask.Yield(PlayerLoopTiming.PostLateUpdate)`;
- one Unity `Update`/`LateUpdate` message dispatch per `WebServerConnection`, plus R3's own player
  loop injection.

The garbage figure, as arithmetic rather than a measurement, for 100 synced objects at 60 fps with
nothing moving:

```
  100 objects x 4 boxed attributes x 60 fps  =  24,000 boxes / second

  per object per frame, on 64-bit:
      Vector3   12 B payload + 16 B object header  =  24 B  (x2, Position and Scale)
      Quaternion 16 B payload + 16 B object header =  32 B
      bool       1 B payload + 16 B header, min 24 =  24 B
                                              total  104 B

  104 B x 100 objects x 60 fps  =  ~610 KB / second
```

That is the cost of an *idle* scene, before anything moves. It is not catastrophic (Unity's GC
absorbs it), but it is a recurring collection pressure with nothing to show for it, and it scales
linearly with the number of synced objects, which is precisely the axis a project grows along.

### What it looks like now

**One ticker for the whole application.** `Synchronization/Code/SyncTicker.cs` is an internal,
auto-created, `DontDestroyOnLoad` MonoBehaviour and the only thing in Colibri with a per-frame Unity
message:

```csharp
private void Update()
{
    for (var i = 0; i < _tickables.Count; i++)
        _tickables[i]?.PollChanges();
}

private void LateUpdate()
{
    var now = Time.unscaledTimeAsDouble;
    var interval = SyncSettings.SendInterval;

    for (var i = 0; i < _tickables.Count; i++)
        _tickables[i]?.FlushUpdate(now, interval);

    if (_hasEmptySlots)
        Compact();
}
```

An index loop over the raw `List<>`, so no enumerator and no defensive copy. (`now` and `interval`
are for the send-rate limit described below.) Registration is `Awake`, deregistration `OnDestroy`,
or a delete from another client, whichever comes first. Deregistration is **O(1)**: each tickable
stores its own slot index, `Deregister` nulls that slot, and the list is compacted once per frame
if anything was removed. Removing entries during iteration would otherwise shift indices under the
running loop. Statics are reset from a `[RuntimeInitializeOnLoadMethod(SubsystemRegistration)]`
hook, so entering Play mode with domain reload disabled does not inherit destroyed components from
the last session.

`SingletonBehaviour<T>` needed the same treatment and could not use the same mechanism: Unity only
scans **non-generic** types for `[RuntimeInitializeOnLoadMethod]`, so a hook written on the generic
base would compile, look right, and never run. It kept a `_createdInstance` flag instead, latched
`true` forever, which meant the second Play session was handed back the previous session's
destroyed connection: a client with no socket and no console output, whose only symptom was the
Status window reporting no connection in the scene. The flag is gone: liveness is read off the
instance itself, where Unity's `==` already distinguishes "destroyed, rebuild it" from "alive". The
one thing the flag was genuinely doing, refusing to resurrect a singleton during teardown, moved to
a `SingletonLifetime.IsQuitting` guard in a non-generic helper, which *is* scanned for the reset
hook and so starts each session false.

**Typed change detection.** `SyncedAttribute` went from a struct holding `Func<T, object>` to an
abstract class with a generic subclass, so the comparison happens on the concrete type:

```csharp
private sealed class ChangeTracker<TValue> : IChangeTracker
{
    private readonly Func<T, TValue> _getter;
    private TValue _lastValue;

    public bool CaptureChange(T target)
    {
        var current = _getter(target);
        if (EqualityComparer<TValue>.Default.Equals(current, _lastValue))
            return false;

        _lastValue = current;
        return true;
    }
}
```

`EqualityComparer<Vector3>.Default` resolves to `GenericEqualityComparer<Vector3>`, because
`Vector3` implements `IEquatable<Vector3>`, so the comparison calls `Vector3.Equals(Vector3)`
directly, with no boxing on either side. Same for `Quaternion`. A value is boxed only on the frame
it actually changed, in order to hand it to `AddUpdate`.

> **Comparison semantics are unchanged.** Both the old and the new path compare with `Equals`, not
> with `operator ==`. Unity's `Vector3 == Vector3` is an approximate comparison (`sqrMagnitude` of
> the difference below `1e-10`), while `Vector3.Equals` is an exact field-by-field float
> comparison. The old code boxed and called `object.Equals`, which dispatches to
> `Vector3.Equals(object)`, the same exact comparison. So this change does not alter which frames
> count as "changed".

**Poll and flush are separate phases.** `AddUpdate` now only fills `_nextUpdate`, and the ticker's
`LateUpdate` sends it:

```csharp
void SyncTicker.ITickable.FlushUpdate(double now, double interval)
{
    var update = TakeDueUpdate(now, interval);
    if (update != null)
        Sync.SendModelUpdate(Channel, update);
}
```

This preserves the previous behaviour (all of one frame's attribute changes travel in a single
message) while removing the `async void` state machine that used to implement it. It also makes the
ordering explicit rather than a side effect of a player-loop timing constant: every `PollChanges`
runs, then every `FlushUpdate`. `TakeDueUpdate` is where the send-rate limit decides whether that
message leaves in this frame or waits.

### Cost, before and after

Per `SyncTransform`, idle:

| | Before | After |
|---|---|---|
| Reactive frame-provider work items | **5** (one per attribute) | 0 |
| Unity per-frame messages | R3's player-loop injection | **1 `Update` + 1 `LateUpdate`, total**, not per object |
| Boxes per frame | **4** | **0** |
| Allocation per change | 1 `async void` state machine | 0 |
| Allocation per message | 1 `JObject` | 1 `JObject` (unchanged) |

**Free of garbage is not free of time.** The profiler run in §8 puts one `SyncTicker.Update()` at
**0.335 ms for 100 idle `SyncTransform`s**, against a `PlayerLoop` total of 0.786 ms in the same
frame: a little under half the player loop, spent establishing that nothing changed. The poll is
O(objects × attributes) whether or not anything moves, because that is what change detection by
polling *is*; what the rewrite removed is the allocation and the per-attribute machinery around it,
not the comparison itself. At 100 objects × 5 attributes that is 500 typed comparisons a frame. It
is a fixed, predictable cost rather than a growing one, but a scene with thousands of synced objects
would want an explicit dirty flag instead of a poll, and that is a different design.

### The send-rate limit

Polling is per frame, and so was sending: an object that moved sent a `model::update` in every
frame. A headset renders 72 to 120 frames a second, so dozens of headsets, each moving a few
objects, produced more traffic than one server and one Wi-Fi network can keep up with. Each object
now sends at most `SyncSettings.MaxSendRate` updates a second: 30 unless `ColibriConfig.MaxSendRate`
says otherwise, and 0 for no limit. The ticker reads the clock (`Time.unscaledTimeAsDouble`, so
`timeScale = 0` does not stop sending) and the interval once per `LateUpdate`, and each object
decides in `TakeDueUpdate`:

```csharp
internal JObject TakeDueUpdate(double now, double interval)
{
    var sendAtOnce = _sendAtOnce;
    _sendAtOnce = false;

    if (_nextUpdate == null)
        return null;

    if (interval > 0 && now < _nextSendTime && !sendAtOnce)
        return null;

    var late = now - _nextSendTime;
    _nextSendTime = late >= 0 && late < interval ? _nextSendTime + interval : now + interval;

    var update = _nextUpdate;
    _nextUpdate = null;
    return update;
}
```

- **Leading edge.** `_nextSendTime` starts at negative infinity and is in the past after any quiet
  spell, so a one-off change goes out in the frame it was made, exactly as quickly as without a
  limit.
- **Trailing flush.** Changes inside the interval accumulate in `_nextUpdate`, a newer value
  replacing an older one per member. The ticker flushes every registered object in every frame,
  changed or not, so the held update leaves in the first frame after the interval is up: the last
  values of a burst arrive even if nothing changes after them. Only intermediate values are
  skipped, which a last-write-wins receiver would have overwritten anyway.
- **The next slot counts from the previous slot.** Frames rarely land on the interval: at 72 fps
  a 30 Hz limit is passed about 8 ms late, and counting the next slot from `now` would round every
  interval up to three frames, which is 24 Hz. Carried over, the lateness is made up in the next
  interval. After a pause, or a send forced early, `late` is a whole interval or more, or negative,
  and the next slot starts afresh from `now`, so no backlog of sends builds up.
- **Showing and hiding skip it.** `PollChanges` compares `activeSelf` with the previous poll, and
  when it switched sets `_sendAtOnce`, which sends whatever is waiting in this frame (for a
  `SyncTransform`, its `Active` member among it). Hiding is a one-off event rather than motion, and
  often the last thing that happens to an object.
- **Deletes are never overtaken.** `OnDestroy` deregisters first, which drops a held update, and
  sends `model::delete` at once. The server creates a model on its first update, so an update that
  arrived after the delete would bring the object back. A delete from another client
  (`OnModelDelete`) drops `_nextUpdate` and deregisters at once for the same reason: until its
  `OnDestroy` a moment later, the object could still send a held update and resurrect itself on
  every client.
- **A value from the server wins over a waiting local change.** `UpdateAttribute` removes the member
  it has just applied from `_nextUpdate`, and drops the update if only the id is left. Sent
  afterwards, the older local value would overwrite the server's on the server and on every other
  client while this client shows the server's, and the copies would disagree for good. Without a
  limit this covers a change polled earlier in the same frame; with one, anything held.

**When the app stops.** The limit can hold back up to one interval of an object's last motion,
and on Android, and so on a Quest, no further frame may come to send it: taking the headset off or
leaving the app pauses it, the system may end the paused process later, and Unity may never call
`OnApplicationQuit`. So `SyncTicker` (always active, which the synced objects need not be, so it
receives these messages for all of them) sends everything waiting, past the limit, from
`OnApplicationPause(true)`, `OnApplicationFocus(false)` and `OnApplicationQuit`. It polls every
object first, so a change made in this frame after the ticker's own `Update` is included. While
paused the process is still alive and socket writes complete on a worker thread, so those updates
do go out. On quit it is best effort: the connection closes its socket in its own `OnDisable`
during the same teardown. Losing focus while the app keeps running (a Quest's system menu, another
window on a desktop) merely skips the limit once.

**The setting.** `ColibriConfig.MaxSendRate` is a serialized field initialized to
`DEFAULT_MAX_SEND_RATE` (30), so a configuration asset saved before it existed gets 30 without
being saved again. The setup window shows it as *Max Send Rate (Hz)* under *Optional Config*,
refuses to save a negative value, and warns outside the foldout when it is 0, since the foldout is
closed whenever the window opens. `SyncSettings.MaxSendRate` reads it and can override it for the
current run without touching the asset; it throws on a negative value, and the override is reset at
`SubsystemRegistration`, so a value set in one Play session does not carry into the next with
domain reload disabled.

An idle object costs the limit one null check per frame. `SendRateTests` run `TakeDueUpdate` on a
clock of their own, including the rate an object changing in every frame reaches at 72, 90 and
120 fps: 30 a second each time, with its last value still arriving.

### What did *not* change

**The network path never touched either library.** `WebServerConnection` is raw `Socket`, `Task`,
`SemaphoreSlim`, a lock-free queue and `FrameCodec`: receive → queue → drained on the main thread
in `Update`; send → `SemaphoreSlim` → `Socket.SendAsync`. Not one R3 or UniTask call in the whole
file. (The receive queue is a `ConcurrentQueue` today, and sends go through the outbox described
at the end of this section.) Latency and throughput are therefore untouched by everything above:
this work moved per-frame CPU and allocation, not wire time.

Which is not to say the network path was fine. It was not, and the next section is about that.

### The socket, and the frame it was waiting for

Reported during the Editor pass: two editors side by side on one machine, both on the SyncTransform
sample, both talking to a `colibri-server` in Docker on localhost. Moving the cube in one took a
visibly long moment to reach the other, and the Status window showed missed heartbeats. Everything
was local, so the wire was not the explanation.

`RunConnectionLoop` is started from `OnEnable`, on the main thread. The file contained **no
`ConfigureAwait(false)` anywhere**, so the first `await` captured Unity's `SynchronizationContext`
and every continuation in the chain inherited it. `UnitySynchronizationContext.Post` queues work
that is executed once per frame by the player loop. Which means:

| Await | What resuming on the main thread cost |
|---|---|
| `socket.ReceiveAsync(...)` | inbound bytes sit in the kernel buffer until the next frame |
| `SendFrame(...)` for the heartbeat echo | two further frame-pumps, *inside* the receive loop |
| `StampLiveness()` after a receive | the watchdog's proof of life only advances when the main thread runs |

An Editor in the background is throttled by Unity, hard. One of two editors always is. So the
unfocused one received late, echoed later, and then reported the heartbeat gap it had itself
created: a client that looks like it is on a bad network while the network is a loopback socket with
`NoDelay` set on both ends.

The fix is `.ConfigureAwait(false)` on every await from `RunConnectionLoop` down: `RunSession`,
`ReceiveLoop`, `SendFrame`, `Delay`, and the send path (at the time `TrySendFrame`, `FlushQueue` and
`SendCommandAsync`, today the outbox's `DrainOutbox`). Nothing about the design changed: this is the
threading the file was already written for. The comment on `_msgQueue` said *"written from the send
path, drained from the connect path, both off the main thread"*, and the `volatile` fields, the
`Interlocked` stamp, the `LockFreeQueue` and the `SemaphoreSlim` were all there for concurrency the
missing `ConfigureAwait` had been quietly preventing. The mechanism existed; only its precondition
was absent.

Because that precondition is now met, the remaining shared state had to be audited rather than
assumed:

| State | Before | Now |
|---|---|---|
| `_lastHeartbeatTime` | `Interlocked` | unchanged |
| `_queuedCommands` | `LockFreeQueue` | `ConcurrentQueue` |
| `_msgQueue` | `lock (_msgQueueLock)` | replaced by the outbox, under `_outboxLock` |
| `_sendLock` | `SemaphoreSlim` | unchanged |
| `_fireOnConnected` / `_fireOnDisconnected` | `volatile` | replaced by `_connectionEvents`, a `ConcurrentQueue<bool>` filled under `_statusLock` |
| `_socket` | plain field | `volatile` |
| `_status` | plain field | `volatile` |
| `_connectedGate` | plain field | `volatile` |
| `_connectAttempts` | plain field | under `_statusLock` |
| `Status` **setter** | unsynchronized read-modify-write | serialized on `_statusLock` |

`LockFreeQueue` recycles its nodes through a pool that is only safe with a single producer, so the
connection's receive queue and `RemoteLogging`'s log buffer use `ConcurrentQueue`.
`VoiceServerConnection` has since followed: its `OnDisable` waits only 500 ms for the receive
thread, so after a quick disable and enable the old one may still be handing over a packet while
the new one starts. With nothing left using it, `LockFreeQueue` is deleted.

The `Status` setter is the one that genuinely needed a lock rather than a keyword: it compares,
assigns, re-arms the connected gate and queues the connection events, and the connection loop and
`Update`'s heartbeat watchdog can now reach it at the same time. Interleaved, the watchdog's
`Disconnected` landing between the loop's compare and its assignment would leave the gate open on a
socket that is already closed. The gate is created with `RunContinuationsAsynchronously`, so
`TrySetResult` inside the lock schedules whoever awaits it rather than running them there.

**What did not move: the main-thread handoff user code depends on.** Received messages still go
receive loop → `_queuedCommands` → drained in `Update()`, so handlers, `SyncBehaviour` fields and
anything touching `transform` still run on the main thread. No user code changes.

**What is left after the fix is the frame rate, and it is now visible.** A message still reaches
user code from `Update`, so a client running at 4 fps still applies it up to 250 ms late: a real
delay, but a local one, and nothing on the server can fix it. The Status window therefore reports
the rate `Update` is running at and the delay that implies, and warns below 20 fps that a
backgrounded Editor is the usual cause (§5). Distinguishing "the network is slow" from "this client
is slow" is most of the diagnosis.

Two tests pin it, in `ConnectionTests`. The first blocks the main thread with `Thread.Sleep(1000)`
and then (before yielding, since yielding would flush anything queued on the main thread and destroy
the evidence) asserts the last heartbeat is under 500 ms old. It fails on the old code and describes
the reported symptom rather than the implementation, so it stays honest if the mechanism changes.
The second asserts the receive loop's managed thread id is not the main thread's.

### Connected, and sending while disconnected

Later changes to the same file are worth knowing alongside the threading above.

**`Connected` means the server has spoken.** A session becomes `Connected` on the first frame the
server sends, not when the TCP connection opens: anything can accept a connection, a 1.x server and
a port that is not Colibri included. Only then is the reconnect backoff reset, `OnConnected` raised
and the queue flushed, and before then the 2 s watchdog in `Update` counts only a decoded frame as
proof of life, so something that accepts and says nothing is dropped. `OnDisconnected` is raised
exactly once per `OnConnected`. Both events are raised from `Update`, each handler in its own
`try`/`catch`, because `Sync`'s re-request of the models after a reconnect is one of those handlers
and a handler in application code that throws must not skip it.

They are raised in the order the transitions happened. The `Status` setter queues each one, under
its lock, in `_connectionEvents`, and `Update` raises them one by one. They used to be two flags,
`_fireOnConnected` and `_fireOnDisconnected`, checked connected-first: a connection that dropped and
came back between two frames (a long frame during a Wi-Fi blip) raised `OnConnected` and then
`OnDisconnected`, and code that follows the events believed it was offline while it was connected.

**A connect that nothing answers is given up.** The socket has no connect timeout of its own, so an
address nothing answered on held an attempt in `Connecting` for the operating system's own SYN
timeout, about two minutes on Android. `RunSession` now opens the connection through
`ConnectAsync(socket, host, port, CONNECT_TIMEOUT_MS, token)`, which races `Socket.ConnectAsync`
against a 5 s delay. Closing the socket is the only way to abandon a pending connect on this API
surface, so that is what giving up does; the abandoned task's exception is observed there, so it
never surfaces later as unobserved, and a `TimeoutException` goes to the reconnect loop, which logs
it with advice (check the address, and that the device is on the server's network) and backs off as
after any other failure. A refusal still fails at once with a `SocketException`. Either one is kept
in `LastConnectFailure` until a connection opens, because the two want different fixes: the address
or the network for a timeout, the server or its port for a refusal. On a local network a connection
opens in milliseconds, and 5 s still leaves room for two lost SYNs on bad Wi-Fi.

**The outbox.** Sends used to wait on the `Connected` gate: each one issued during an outage parked
a task, and on reconnect the parked continuations resumed together on the thread pool and raced for
the socket, so outage messages went out in any order and interleaved with new ones. Every message
now goes into one FIFO (a `LinkedList` under `_outboxLock`) that a single `DrainOutbox` writes to
the socket, re-reading the live session for every frame. While connected it is just the way to the
socket. While not, it is the retry queue, opened again (`OpenOutbox`) before `Status` says
`Connected`, so anything that reacts to `Connected` lines up behind the outage's messages. A failed
write leaves its frame at the head for the next session. During an outage, broadcasts and the other
messages that are not model state are capped at 256 (`MAX_QUEUED_MESSAGES`), oldest first. Log lines
rarely count towards that: `RemoteLogging` sends nothing while disconnected and keeps up to 1000
lines itself (§3), so only lines it handed over before the connection dropped are in the outbox.
Model messages are not dropped by that cap, and the un-awaited `model::update`s for one object are
folded into one copied `JObject` (newer members winning, the result moving to the back) unless
something else about that object (an awaited update, a request for it or for its channel, a delete)
is queued in between. Reconnecting ends every fold. Nothing in the send path awaits the `Connected`
gate any more; only user code does.

Folding bounds model updates by the number of objects, but requests, deletes and updates that
cannot be folded were still unbounded, and so was the outbox of a connection whose writes fall
behind what is sent. Behind both bounds sits `MAX_OUTBOX_MESSAGES`: 10 000 messages in the whole
outbox, connected or not. Past it, `EnforceOutboxLimit` drops the oldest droppable message first
and only then the oldest model message (never the one `DrainOutbox` is writing, which may well
arrive), completes an awaited send it dropped with `false`, and warns once per connection. Losing
model state is a real loss, but a bounded one.

---

## 3. Removing UniTask

Three call sites, none of them on the sync hot path.

**`SyncBehaviour._isReady`:** `UniTaskCompletionSource<bool>` → `TaskCompletionSource<bool>`.
`UniTaskCompletionSource` is pooled where `TaskCompletionSource` allocates, but this happens once
per synced object for its entire lifetime. In exchange it removes a real hazard:
`UniTaskCompletionSource` throws *"can not await twice"* on a second **pending** awaiter, and
`TriggerSync()` is awaited both from `SyncBehaviourManager.Start()` and from its `ModelCreated`
handler. `TriggerSync` also now catches the cancellation raised when an object is destroyed before
the server ever sent its state, instead of letting it escape an `async void`.

**`Store`:** `await request.SendWebRequest()` is a UniTask extension method. Replaced with:

```csharp
private static Task SendAsync(UnityWebRequest request)
{
    var tcs = new TaskCompletionSource<bool>();
    request.SendWebRequest().completed += _ => tcs.TrySetResult(true);
    return tcs.Task;
}
```

Deliberately **not** `TaskCreationOptions.RunContinuationsAsynchronously`:
`UnityWebRequestAsyncOperation` raises `completed` on the main thread, and completing the task
inline is what keeps the caller's code after `await` on the main thread too. (`AsyncOperation`
invokes a handler immediately if the operation has already finished, so there is no lost-race
window.)

The plain awaiter never throws, so `catch (UnityWebRequestException)`, a UniTask type, is gone,
replaced by an explicit result check. This is strictly better for someone new to Colibri: instead
of an exception message, the log shows the operation, the object name, the URL, the transport
error, the HTTP status, and a pointer at the configuration window. That covers failed requests
only: the Newtonsoft calls around them are not caught, so a value that cannot be converted still
throws (§6).

**`RemoteLogging`:** `Subject<int>` + `.Where(!_isSending)` + `.ThrottleLast(1s)` became a queue
filled from Unity's threaded log callback (which fires on arbitrary threads) and drained by a
one-second timer in `Update`. It has since been simplified further. The queue is a
`ConcurrentQueue`, since several threads may log at once, with an `Interlocked` count beside it.
It keeps at most the newest 1000 lines between two sends, connected or not: a second's worth while
connected, which is also all a runaway log loop can cost the server, and the whole outage while
not. It counts the lines it drops, and the next send starts with one line saying how many are
missing, handed straight to the connection; through `Debug.Log` it would come back into the buffer.
After a protocol refusal it discards the lines and the count. While connected it hands each line to
`SendCommand` exactly once and never retries: the connection's outbox keeps a line across an outage,
and the old in-flight gate and retry re-arm were what had sent some lines twice. `UniTask.Yield`'s
allocation-free await does not apply anywhere here, because §2 removed the await rather than
swapping it for `Task.Yield`.

---

## 4. Four silent failures, made loud

### Type mismatch

Colibri routes on **(channel, type)**. `Sync.Invoke<T>` used to find no listener list and return.
`Synchronization/Code/ChannelListenerRegistry.cs` now tracks which types each channel has listeners
for, updated from `AddListener`/`RemoveListener`, and the miss branch says:

```
Colibri: a float arrived on channel 'chat', but the listener registered there expects string.
The message was dropped, because Colibri matches messages on the channel *and* the type.
Either send it as string, or listen for it with Sync.Receive<float>("chat", MyHandler).
```

Three deliberate restrictions on when it speaks:

- **Only on a mismatch.** A channel with *no* listeners is normal: every client sees every channel
  its app uses, including ones it does not care about. Warning there would train people to ignore
  the console.
- **Once per `(channel, receivedType)`.** A mismatch on a channel receiving at 60 Hz would otherwise
  produce 60 identical errors a second. The pair is re-armed if a matching listener is later
  registered and removed again.
- **Off the hot path.** The check costs one dictionary lookup, on a message that already missed.

Model channels (`model::update` / `model::delete`) are registered with `track: false`. They are
Colibri's own `SyncBehaviour` plumbing, never go through `Invoke<T>`, and listing them would bury
the channels the application actually uses.

The registry has **no `UnityEngine` dependency**, which is the reason it is a separate file:
registering a listener with `Sync` reaches `WebServerConnection.Instance`, which spawns a
GameObject. Splitting the registry out made the interesting part testable without one. See
`Tests/Editor/ChannelListenerRegistryTests.cs`. (`Sync`'s own dispatch is tested too now, in
`MessageDispatchTests`, which accepts the inert connection object that registering creates in edit
mode.)

### The cast on every `Receive`

17 overloads made `Sync.Receive("ch", MyHandler)` ambiguous. Naming the type is not:

```csharp
Sync.Receive<float>("MyChannel", MyHandler);
Sync.Unregister<float>("MyChannel", MyHandler);
```

Supplying type arguments rules the non-generic overloads out of consideration entirely. Dispatch is
a pattern match on the delegate (no reflection) and forwards to the existing typed overload, which
still wins overload resolution inside the switch because a non-generic method is preferred over a
generic one:

```csharp
public static void Receive<T>(string channel, Action<T> listener)
{
    switch (listener)
    {
        case Action<bool> l: Receive(channel, l); break;
        case Action<int> l: Receive(channel, l); break;
        /* … one line per supported type … */
        case Action<JToken> l: Receive(channel, l); break;
        default: LogUnsupportedType<T>(channel); break;
    }
}
```

Every existing call site keeps compiling. An unsupported `T` names the supported set and shows the
`JToken` route.

### The `Unregister` you had to remember

Forgetting the matching `Sync.Unregister` in `OnDestroy` was the most expensive mistake the API
allowed. The delegate keeps the destroyed `MonoBehaviour` reachable, so calling it *works* right up
until the first line that touches `transform` or `gameObject`, which throws
`MissingReferenceException`, out of `WebServerConnection.Update`, taking every message still queued
behind it that frame with it. The symptom is not "my handler misbehaves after I destroy the object";
it is "the connection drops messages at random", on a channel that has nothing to do with the object
that was destroyed.

A listener already carries the answer to who owns it, and it only has to be read once:

```csharp
Sync.Receive<float>("Temperature", OnTemperature);        // Target *is* the component
Sync.Receive<float>("Temperature", v => label.text = ...); // Target is a closure holding it
```

A method group hands over the instance directly, so `listener.Target is UnityEngine.Object` settles
it. A lambda does not: the compiler hoists what it captured into a generated class, and the
enclosing component sits in its `<>4__this` field, or one closure further out, if the lambda is
nested. `ListenerOwner` walks that, with the captured `this` preferred over anything else the lambda
happens to hold, and the result is stored next to the delegate at registration time. Per message the
check is one `UnityEngine.Object` null comparison.

Orphans are dropped on dispatch and on the next registration for the same channel and type. The
second is what keeps a scene reload from stacking the old scene's listeners on a channel that
nothing happens to send on. Pruning also decrements `ChannelListenerRegistry`, or the channel would
keep claiming a listener that no longer exists and every later message on it would be reported as a
mismatch against a component that has been gone for minutes.

What is deliberately *not* automatic: a `static` listener, and one belonging to a plain C# object.
Neither has a Unity lifetime to follow, so `Unregister` remains the only thing that could be meant.
It also stays the way to stop listening while the object is alive; the `OnEnable`/`OnDisable` pair
in the samples is unaffected by any of this, since a disabled component has not been destroyed.

A listener that throws for any other reason no longer takes the frame down either. `Sync` calls
each listener in its own `try`/`catch`, and `WebServerConnection` does the same for each
`OnMessageReceived` handler, so a throw is logged once with its channel and command while the other
listeners, and every message queued behind it, are still delivered. A payload that cannot be read
as the type its command names is reported and dropped in the same way instead of throwing.

### Missing configuration

`ColibriConfig.Load()` returned `null` when `Resources/ColibriConfig.asset` did not exist, so
`GetWebUrl` dereferenced it and threw. It now returns a shared defaults instance, and the connection
loop reports the cause once instead of polling silently twice a second:

```
Colibri is not configured yet. Open Window -> Colibri Configuration, enter an App Name,
and press Save Config. (Every client that should see each other has to use the same App Name.)
```

The defaults object is created **once** and cached separately from `_instance`. The obvious
implementation (`return CreateInstance<ColibriConfig>()` on every call) leaks, because
`WebServerConnection.Update` calls `Load()` every frame and a `ScriptableObject` created that way is
not garbage collected. `_instance` itself is still left unset, so the real asset is picked up the
moment it appears, which in the editor is as soon as the setup window saves it.

### "Which app am I?"

The connect log used to read `Colibri: connection to web server established`. A typo in the app name
produces a perfectly healthy connection on which no other client is ever seen, indistinguishable
from a working setup. It now reads:

```
Colibri: connected to 192.168.0.10:9212 as app 'my-ar-prototype'.
Only clients using the same App Name can see each other.
```

### An App Name everyone uses

A typo in the app name isolates a client; the opposite mistake joins it to strangers. The server
puts every client with the same app name into one app, whoever they are, so projects that keep a
name everybody picks (`myAppName` from the web client's samples, `test`, `demo`) end up in one
shared app. Each project sees every other project's objects and messages, and since every update
goes to every other client in the app, the server's work grows with the square of the number of
clients. Nothing fails at runtime: it just works, for everyone at once.

So *Window → Colibri Configuration* warns, right under the App Name field, when the name is one of
`myappname`, `myapp`, `appname`, `app`, `test`, `testapp`, `demo`, `example`, `colibri` or
`default`, ignoring case and surrounding spaces. The check is `ColibriConfig.SharedAppNameWarning`,
covered by `AppNameCheckTests`. The empty-name error now uses `ColibriConfig.IsConfigured`, so a
name of only spaces, which the Status window already reported as not configured, no longer passes
there either.

### And one more, at startup

`[Sync]` members are validated when the model type is first initialized, rather than failing on the
first message that arrives. An unsupported type, a property missing a getter or setter, and two
members whose lowercased names collide are each reported by name with the fix.

---

## 5. `Window → Colibri Status`

`Setup/ColibriStatusWindow.cs`, next to the existing `SetupWindow` that owns
`Window → Colibri Configuration`. It shows:

- connection state, colour-coded; server `host:port`; the app name actually in use; protocol version
- a protocol refusal in red, with the server's version and reason (not retried, so the usual "check
  that colibri-server is running" advice would be wrong), and a *suspected* mismatch
  (`SuspectedProtocolMismatch`, several connections in a row that ended before a single frame,
  other than by the heartbeat watchdog or, with TLS, by a close or reset) as a yellow warning while
  the client keeps retrying
- **time since the last server heartbeat**: deliberately not called latency. The server's heartbeat
  carries the *server's* clock, so the client genuinely cannot derive a round trip from it; real
  latency figures live on the server's admin UI. What it does tell you is whether the server is
  still talking to you.
- **the delivery rate**: how fast `Update` is running, and therefore the longest a received message
  can wait before user code sees it. Below 20 fps it warns, and names the usual cause: an Editor in
  the background, which Unity throttles. This is the number that separates "the network is slow"
  from "this client is slow", and until it existed the two were indistinguishable from here (§2).
- while not connected, why the last attempt failed (`LastConnectFailure`), such as an address that
  did not answer within 5 s or a refusal, which want different fixes (§2)
- every channel with listeners, and the type each one expects, from the registry above
- the last 20 messages in and out, dropping anything older than ten seconds. The list is meant to
  answer "what is happening right now"; entries had no expiry at first, so a burst from a minute ago
  sat there with its ages counting up, and, because the buffer is a static and
  `realtimeSinceStartup` keeps running after Play stops, the next session opened showing the
  previous one's messages.
- buttons for the configuration window and the server's web UI

Two constraints shaped the implementation:

- **It never touches `WebServerConnection.Instance`.** `SingletonBehaviour.Instance` *creates* a
  GameObject when none exists, so an editor window reading it would quietly add
  `[WebServerConnection]` to the open scene outside Play mode. The window uses
  `FindFirstObjectByType` and renders a hint when nothing is running.
- **Release builds pay nothing.** The traffic ring buffer and the calls that fill it are behind
  `#if UNITY_EDITOR || DEVELOPMENT_BUILD`, and `RecordTraffic` carries `[Conditional("UNITY_EDITOR")]`
  plus `[Conditional("DEVELOPMENT_BUILD")]`, so the call sites are removed by the compiler rather
  than merely doing nothing.

Repaints are throttled to 10 Hz and only while playing.

### The question Status cannot answer: the `Network Stress` sample

Status tells you whether messages are flowing. It says nothing about *how many*, and "how many
synchronized objects can this carry before it stops keeping up" is the question that decides whether
a prototype works in the room it was built for. Before this sample there was no way to ask it. The
main-thread bug in §2 was found by eye, from a cube that looked late; the numbers that would have
settled it in a minute did not exist anywhere.

The sample spawns up to 500 synchronized objects, moves as many of them per frame as you ask, and
puts throughput, round-trip latency percentiles, dropped messages, frame cost and reconnects on
screen behind sliders. Run it in two editors side by side (that is the configuration it exists for)
and turn the count up until the numbers stop being acceptable.

**Two instruments, deliberately separate.** The *load* is synchronized objects, because that is how
a real scene generates traffic. But state sync is last-write-wins and coalesces per frame: if a
value changes three times between two flushes, two of those never go on the wire, and that is the
design working rather than the network failing. So the load cannot measure loss, and the panel calls
its gap figure **coalesced**, not lost. With the send-rate limit (§2) changes are coalesced per
interval as well, so *Coalesced* rises by design, and the panel's *Changed* row, the changes the
sample drives, is no longer the number of messages that leave; *Sent* shows the most they can
become. Set *Max Send Rate* to 0 to measure the raw per-frame load.

*Latency and loss* therefore ride on a separate low-rate probe channel, where every message is meant
to arrive exactly once. It is a round trip, so no clock is shared between the two ends and the
figure stays honest across machines, and it is kept at a low rate on purpose: it measures the delay
*under* the load rather than adding to it. That channel is the only thing in the sample that can
report a genuinely dropped message, and it is what makes the server's own limits visible from
inside Unity: the server drops broadcasts from a client over `CLIENT_MESSAGE_RATE_LIMIT` (1000 a
second by default) or while it is `TCP_INBOUND_BACKLOG_LIMIT` messages behind, and
`tcp-server-worker.ts` discards writes to a client whose socket has fallen more than 1 MB behind.
The server logs each on its own side and never tells the client. The scene's defaults, 100 moving
objects at the default send rate of 30, come to about 3000 updates a second, three times the rate
limit, so at those settings the probes measure the rate limit rather than the round trip; with 30
objects or fewer they measure the round trip.

Two things that follow from the design rather than from the harness:

- **`colibri-server`'s `npm run test:stressecho`** is a raw v3 client that does nothing but answer
  probes. The server excludes a sender from its own broadcasts, so one editor alone can never
  measure a round trip; this closes the loop without starting a second Unity. Measured against it
  through a local Docker server, the wire itself round-trips in **3.5 ms p50, 4.2 ms p95, 5.1 ms
  p99** at 20 Hz with nothing lost: the floor everything else is read against.
- **Inbound model dispatch is O(N) per message**, so the object-count slider is walking into an
  O(N²) frame cost. Every `SyncBehaviour<T>` registers its own listener on one channel per *type*
  (in `SyncBehaviour.Awake`) and each instance compares `id == Id` and returns on a miss
  (in `SyncBehaviour.OnModelUpdate`): one inbound update is offered to all N models, and
  `SyncBehaviourManager` adds a second linear scan. At 100 objects each sending once a frame that
  is 10,000 comparisons a frame; at 500 it is 250,000. Nothing here fixes that. The point of the
  sample is that it can now be measured rather than argued about, and an index from `Id` to model is
  the obvious fix when the measurement says it is worth making.

---

## 6. API changes

### Added

| API | Notes |
|---|---|
| `Sync.Receive<T>(string, Action<T>)` | No cast needed |
| `Sync.Unregister<T>(string, Action<T>)` | No cast needed |
| `Sync.RecentTraffic` | Editor/development builds only |
| `ChannelListenerRegistry` | Channels, expected types, mismatch messages |
| `ColibriConfig.NOT_CONFIGURED_MESSAGE` | One wording, used everywhere |
| `ColibriConfig.IsConfigured` | True once an app name is set |
| `WebServerConnection.MillisSinceLastHeartbeat()` | Was private |
| `WebServerConnection.ServerAddress` / `.TcpPort` / `.AppName` | Read-only, snapshot of the live config |
| `WebServerConnection.ClientVersion` | Static; the handshake's protocol version |
| `WebServerConnection.DeliveryFramesPerSecond` | Smoothed rate `Update` runs at: how fast messages reach user code |
| `ConnectionStatus.ProtocolMismatch` | Terminal: the server refused this client's protocol version |
| `WebServerConnection.ServerVersion` / `.ProtocolMismatchReason` | Set only with a refusal |
| `WebServerConnection.SuspectedProtocolMismatch` | Set after several sessions in a row end before a frame, other than by the heartbeat watchdog or, with TLS, by a close or reset; a guess, retried |
| `WebServerConnection.LastConnectFailure` | Why the last attempt to open the connection failed (a 5 s timeout, a refusal, another socket error); `null` once one opened |
| `ProtocolMismatchException` | Unwinds a refused session; public so tests and applications can identify it |
| `SyncSettings.MaxSendRate` | Updates per second one synced object may send; starts as the configured value, can be changed for the current run |
| `ColibriConfig.MaxSendRate` / `.DEFAULT_MAX_SEND_RATE` | The configured send-rate limit, 30 by default; 0 = no limit |

### Changed

| Before | After |
|---|---|
| `static Observable<SyncBehaviour<T>> ModelCreated()` | `static event Action<SyncBehaviour<T>> ModelCreated` |
| `static Observable<SyncBehaviour<T>> ModelDestroyed()` | `static event Action<SyncBehaviour<T>> ModelDestroyed` |
| A `Sync.Receive` listener outlives its object | Dropped once the object that registered it is destroyed |
| `ColibriConfig.Load()` may return `null` | Never returns `null` |
| `Store.*` may throw `UnityWebRequestException` | A failed request no longer throws; it logs and returns `default`/`false`. A value Newtonsoft cannot convert still throws a `JsonException` |
| `WebServerConnection.Connected` completes when TCP connects | Completes on the server's first frame; cancelled on a protocol refusal |
| `OnDisconnected` raised for every failed attempt | Raised exactly once per `OnConnected` |
| `OnConnected` raised before `OnDisconnected` when both happened since the last frame | Both raised in the order they happened |
| `SendCommandAsync` waits on the `Connected` gate | Queued in the outbox; `true` once written, `false` only if it will never be sent |
| A synced object sends in every frame in which it changed | At most `SyncSettings.MaxSendRate` updates a second, 30 by default; the latest values of a burst still go out |

### Removed

| API | Instead |
|---|---|
| `ObservableModel<T>` / `ObservableManager<T>` | `SyncBehaviour<T>` / `SyncBehaviourManager<T>` |
| `LockFreeQueue<T>`, `LockFreeLinkPool<T>`, `SingleLinkNode<T>`, `SyncMethods` | `System.Collections.Concurrent.ConcurrentQueue<T>` |

### Unchanged

All 17 `Sync.Receive` / `Sync.Unregister` overloads, every `Sync.Send` overload, `SyncBehaviour`'s
`[Sync]` attribute and the set of types it supports, `SyncBehaviourManager`, `SyncTransform`, and
the v3 wire protocol.

---

## 7. Migrating an existing project

1. **Remove R3 and UniTask** from your own `Packages/manifest.json` if nothing else in your project
   uses them, and delete `Assets/Packages/R3.dll` if NuGetForUnity put it there.

2. **`ModelCreated()` / `ModelDestroyed()` subscribers** become `+=` / `-=`:

   ```csharp
   // before
   SyncBehaviour<MyModel>.ModelCreated().Where(m => …).Subscribe(OnCreated).AddTo(this);

   // after
   private void Start()
   {
       SyncBehaviour<MyModel>.ModelCreated += OnCreated;
   }

   private void OnDestroy()
   {
       SyncBehaviour<MyModel>.ModelCreated -= OnCreated; // required
   }
   ```

   > ⚠ A static event does **not** unsubscribe itself. Forgetting the `-=` leaks the handler, and
   > the destroyed component it belongs to, into the next Play session whenever *Enter Play Mode
   > Options* has domain reload disabled. `Where(…)` predicates become early-return guards.

3. **If you override `Awake` or `OnDestroy` in a `SyncBehaviour` subclass, call `base`.** That was
   already true, but it now also drives ticker registration, so skipping it means the object never
   polls for changes.

4. **`Sync.Receive` casts still compile.** Migrate at your own pace; the generic form is what the
   samples and README now use.

5. **`if (ColibriConfig.Load() == null)` is dead code**; use `.IsConfigured` if you want to know
   whether an app name has been set.

6. **`try { await Store.Get… } catch (UnityWebRequestException)`** can be deleted; check the return
   value instead (`null` / `false`). Keep a `catch (JsonException)` if the saved value may not fit
   the type you ask for: `Get` still throws then.

7. **`await connection.Connected` can throw.** It is cancelled when the server refuses this
   client's protocol version and when the component is disabled, so an `await` of it then throws
   `TaskCanceledException` instead of waiting forever.

8. **`OnDisconnected` is no longer raised for failed attempts**, only once for every
   `OnConnected`. Code that counted failed attempts with it should watch `Status` instead.

9. **Check the classes you save with `Store`.** It converts with Newtonsoft now, not `JsonUtility`.
   A `Vector3`, `Quaternion` or `Color` field makes `Put` throw a `JsonSerializationException`;
   keep such values as `float` fields or arrays, or save a `JObject` built with `ToJson()`. A
   private `[SerializeField]` field is neither saved nor loaded any more; make it public or add
   `[JsonProperty]`. Values 1.x saved still load.

10. **Synced objects send at most 30 updates a second.** A `[Sync]` setter that counts or reacts to
    every value it receives now sees gaps. Send events that must each arrive with `Sync.Send`, or
    set *Max Send Rate* to 0 (or `SyncSettings.MaxSendRate = 0`) to send every frame's change as
    before.

11. **`LockFreeQueue<T>` is gone**, with `LockFreeLinkPool<T>`, `SingleLinkNode<T>` and
    `SyncMethods`. Use `System.Collections.Concurrent.ConcurrentQueue<T>`: `Enqueue` stays,
    `Dequeue(out item)` becomes `TryDequeue(out item)`, and any number of threads may enqueue.

---

## 8. Verification status

### Done without the Editor

- **Both assemblies compile clean.** The 43 runtime sources and the 4 EditMode test sources were
  compiled with Roslyn against Unity 6000.2's managed assemblies at `langversion:9.0`
  (C# 9 = the Unity 2022.3 level), with `UNITY_EDITOR` defined so the editor windows are included.
  Zero errors, zero warnings.
- **The registry logic runs green.** `ChannelListenerRegistry` has no Unity dependency, so its
  behaviour was executed standalone: 19 checks covering silence with no listeners, silence on a
  match, the mismatch message content, once-per-pair suppression, re-arming, plural wording,
  listener ref-counting, channel cleanup, and the friendly type names.

### The Editor pass, 2026-08-05

The ten items below were the acceptance criteria for this work, and they have now been run. The
environment was Unity **6000.5.7f1** with a URP-template project (`ColibriTest`) that has Colibri
added as a `file:` UPM package, against `colibri-server` 2.0.0 built and run locally on Node 26.5.1
(ports 9011 web/REST/Socket.IO, 9012 TCP v3). Two of the criteria ask for a *second Unity instance*,
and they were answered in two stages. The message-level checks were run against three non-Unity
endpoints (a non-interactive Socket.IO peer written against colibri-web, a raw v3 TCP client, and a
pass-through proxy in front of the TCP port that decodes every frame in both directions) because
those are what make the wire observable; the proxy is why several claims below can be quoted at the
byte level rather than inferred from behaviour. Separately, a standalone player *was* built and run
alongside the Editor, so the two-Unity-clients configuration itself is covered too. What that does
not cover is the visual half; see the subsection after the ten.

Ten of the problems the run turned up were fixed; they are listed in
[`v2-changes.md`](dev/v2-changes.md) under *End-to-end verification, and what it fixed*. Two more were
diagnoses rather than defects, and both are worth knowing before building on Colibri:

- Unity 6's *Insecure HTTP Option* defaults to *Not allowed*, and the `Store` round trip over
  `http://localhost:9011` worked anyway, because Unity exempts loopback. It only bites when the
  server is remote and not on HTTPS.
- Unity's `Run In Background` also defaults to off, and with it off the Editor suspends the player
  loop as soon as its window loses focus. `Update` never runs, so nothing is sent and nothing the
  receive thread queued is ever delivered. It lands squarely on the two-client recipe: the unfocused
  instance goes silent while looking connected.

  This entry originally went on to say that the socket stays up and heartbeats keep being echoed
  *because that happens off the main thread*. That was an assumption, and it was wrong: nothing in
  `WebServerConnection` was off the main thread, because no await on the connection path carried
  `ConfigureAwait(false)`. The correction and the fix are in §2; the sentence is left here, marked,
  because the assumption is exactly what let the bug hide through a full verification pass.

1. **Done, with a narrower claim than the item asks for.** `ColibriTest` resolved
   `de.uni.kn.colibri` 2.0.0 with **zero compile errors** and with no R3 and no UniTask anywhere in
   the manifest, which is the point of §1. `com.unity.nuget.newtonsoft-json` resolved automatically
   from the package's own `dependencies`, and the lock file's 3.2.2 satisfied the requested 3.2.1
   with no conflict. What was *not* tested is the wording of the item: the project is Unity
   6000.5.7f1 rather than 2022.3, and Colibri was added as a local `file:` reference rather than
   through the git URL the README documents, so the URL itself was not exercised.
2. **Covered, though not by this pass.** The pass itself happened inside `ColibriTest`, and after
   the samples moved to `Samples~` (see the change log) the `colibri-unity` project can no longer
   open the sample scenes in place; `ColibriTest` is where they are opened now. But `run-tests.mjs`
   opens the `colibri-unity` project itself, pinned to Unity 6000.5.7f1, and runs both test suites
   there, so the project is opened and compiled on every test run. That the package compiles with R3
   and UniTask out of the manifest is covered by item 1 as well.
3. **Done. 52 passed, 0 failed.** `FrameCodecTests`, `FrameReaderTests`, `ProtocolVectorTests` and
   `ChannelListenerRegistryTests`, run through `TestRunnerApi` against the package's
   `HCIKonstanz.Colibri.Tests` assembly. `colibri-server`'s own suite was green at the same time
   (102 passed), which matters for `ProtocolVectorTests`, since those vectors are only meaningful
   against a server encoder that is itself behaving.
4. **Done: the headline claim, measured.** 100 `SyncTransform`s in an otherwise empty scene, all
   idle, Deep Profile off, Editor Play mode, sampled through `ProfilerDriver`. Over a 231-frame
   window the **median frame allocated 0 bytes**:

   ```
   Frame Time Summary for the frame range [21001; 21231]:
     4 frames out of 231 (1.7 %) exceeding target frame GC Allocation of 8192 bytes
     Frame with Median GC Allocation (50th percentile):
       Frame 21138: 0 bytes of GC Allocation
   ```

   The four outliers are not the sync path: breaking the worst one down puts its allocations on
   background threads (`Thread Index: 134` for 2093 bytes, `128` for 537, `4` for 56), not on the
   main thread. And the main thread's individual samples for a median frame show one ticker entry,
   not N:

   ```
   Top 3 Individual Samples in Frame 21139 on Main Thread by Total Time:
     EditorLoop                                                     3.282ms (73.4 %)
     HCIKonstanz.Colibri.dll!...::SyncTicker.Update() [Invoke]      0.335ms  (7.5 %)
        Object Name: [Colibri SyncTicker]
     Profiler.FlushMemoryCounters                                   0.248ms  (5.6 %)
   ```

   Exactly one `SyncTicker.Update()`, attributed to the single `[Colibri SyncTicker]` object rather
   than one frame-provider item per synced attribute. Both halves of the claim hold. Two things to
   keep with the number, though. It only means anything **because item 9's leak was fixed first**:
   before that, the n-th Play session had n ticker objects and this frame would have shown n
   `SyncTicker.Update` entries, which is how the leak and the claim contradicted each other. And
   polling costs time even when it allocates nothing: 0.335 ms for 100 idle objects against a
   `PlayerLoop` total of 0.786 ms in the same frame, a little under half the player loop spent
   discovering that nothing changed. §2 now says so.
5. **Done, against a web peer rather than a second Editor**, deliberately, since a web peer is what
   makes the payload bytes readable. Every supported type crossed Unity → web and web → Unity: bool,
   int, float, string, Vector3, Quaternion, Color, the
   bool/int/float/string/Vector3 arrays, and `JToken`. All 17 payload shapes, both directions. The
   string fix from the protocol pass is directly visible in the frame bytes: a `broadcast::string`
   payload goes out as `"hello from unity round 1"`, 26 bytes for 24 characters, i.e. quoted. The
   run also found the `SendData` sample itself broken (it sent its `JObject` on `"myJson"` while
   listening on `Channel`), and that is fixed.
6. **Done.** A second client sent **60** `broadcast::float` messages on `verification`, a channel
   where Unity had registered only a `string` listener. The console got **exactly one** warning:

   ```
   Colibri: a float arrived on channel 'verification', but the listener registered there
   expects string. The message was dropped, because Colibri matches messages on the channel
   *and* the type. Either send it as string, or listen for it with
   Sync.Receive<float>("verification", MyHandler).
   ```

   Channel, both types, and both routes out of the mistake, and the
   once-per-`(channel, receivedType)` suppression from §4 holding against 60 messages rather than
   against the unit tests' synthetic ones.
7. **Done for the message; the `Store` half found a bug instead.** With no `ColibriConfig.asset` in
   the project at all, a ~60 s Play session logged `NOT_CONFIGURED_MESSAGE` **exactly once**, not
   once per frame: the fallback in §4 behaves. `Store.Get`, however, neither threw *nor* logged: the
   default `ServerAddress` points at the public `colibri.hci.uni-konstanz.de`, and the request was
   still outstanding after ~60 s, because `UnityWebRequest.timeout` defaults to no timeout at all.
   §3's promise that a `Store` failure surfaces as a detailed log only holds if the request ever
   finishes, so the requests now carry a ten-second timeout.
8. **Done for both halves, and the live half produced a fix.** Opening *Window → Colibri Status* in
   edit mode rendered the "press Play" hint and created **no** `[WebServerConnection]` and **no**
   `[Colibri SyncTicker]` GameObject: the scene still contained only what was already in it, which
   is what the `FindFirstObjectByType` constraint in §5 is for. During Play the readout tracked the
   connection over many minutes and stayed in the 7-99 ms band, and the 2 s watchdog never fired.
   Watching it is also what exposed the readout itself: sampling `MillisSinceLastHeartbeat()` raw at
   the window's 10 Hz repaint beats against the server's 100 ms heartbeat and reads like a number
   counting down. The window now peak-holds the worst gap over one second, which is both steady and
   the figure that actually matters.
9. **Done, and it failed before it passed.** This is the one item that found a defect rather than
   confirming a claim. With `EnterPlayModeOptions.DisableDomainReload` on, three enter/exit cycles of
   the `SyncBehaviour` sample left one extra `[Colibri SyncTicker]` GameObject behind *each time*.
   Measured outside Play mode, the Editor had accumulated seven, all still enabled:

   ```
   live SyncTicker components (outside Play mode): 7
     go='[Colibri SyncTicker]' hideFlags=DontSave activeSelf=True enabled=True scene='' valid=False
     ... x7
   ```

   They belong to no scene (`scene=''`), which is why item 8's edit-mode check could truthfully
   report an untouched scene while these were sitting in the Editor.

   The cause is one flag. `HideFlags.DontSave` does not only keep an object out of the saved scene,
   it also exempts it from being destroyed when Play mode ends. And `DontDestroyOnLoad` was already
   covering the "not saved" half on its own, so the flag was buying nothing and costing this. The
   consequence is worse than a stale object in the hierarchy: every ticker drives the same *static*
   `_tickables` list, so the n-th Play session ran `PollChanges` and `FlushUpdate` **n times per
   frame** (duplicate `model::update` messages on the wire, and a sync cost that grew every time
   someone pressed Play). The flag is removed, and `ResetState` now destroys strays first, so an
   Editor that already collected a pile of them recovers on the next Play. After the fix: zero
   tickers alive outside Play mode, and three cycles that hold steady:

   ```
   LEAK syncedBehaviours=4 connections=1 tickerObjects=1 tickables=4
   LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
   LEAK syncedBehaviours=3 connections=0 tickerObjects=1 tickables=3
   ```

   The first cycle counts four only because the late-joined remote model had already arrived by the
   time the probe ran. The 52 EditMode tests still pass afterwards, and item 4's profiler run was
   taken after this fix, which is why it sees the one ticker entry the design intends rather than one
   per Play session so far. Note that `ColibriTest` was
   left with *Enter Play Mode Options → Disable Domain Reload* enabled, since that is the
   configuration this check requires.
10. **Done, against injected traffic rather than a second instance.** On connect, each
    `SyncTransform` broadcast its full state on `synctransform` (`active`, `position`, `rotation`,
    `scale`, `physicsid`). Selective sync holds: with position *and* rotation *and* scale changed on
    both objects, `CubePosOnly` sent `{"id":...,"position":[5,1,2]}` and `CubeRotOnly` sent
    `{"id":...,"rotation":[...]}`, each only its own axis. Injecting a `model::update` for an
    unknown id on `synctransform_cube` made `[SyncTransformManager] (Cube)` instantiate
    `CubeModelTemplate(Clone)` at exactly the injected `[3,4,5]`. Idle objects sent nothing at all,
    which is what the sync-loop rewrite intends. `[RemoteLogger]`, dragged in from
    `Packages/de.uni.kn.colibri/Prefabs/[RemoteLogger].prefab`, put one line per second on the wire
    for 25+ seconds with no storm and no stuck in-flight gate, so the `Subject` + `ThrottleLast` →
    1 s timer rewrite in §3 behaves. Its payload is **unquoted**
    (`payload(23B)="verification log line 1"`, 23 bytes for 23 characters, against the quoted
    `broadcast::string` in item 5), which is exactly the `log`-channel exception the protocol pass
    documented. What this does not cover is how two Unity clients *look* while syncing: the next
    subsection has two of them connected at once, but nobody watched a cube in one follow a cube in
    the other.

### Beyond the ten: the standalone player, and two Unity clients at once

A development Windows 64-bit player was built from `ColibriTest` with the `SyncTransform` and
`SyncBehaviour` sample scenes in it: `result=Succeeded errors=0 warnings=13 time=00:01:59`. That on
its own is worth having: it says the package compiles and links for a real player target and not
only for the Editor, which a clean Editor compile does not imply.

Run alongside the Editor, both clients were connected to the same app at the same time:

```
State        LocalPort  OwningProcess
Established      53594          12476   <- standalone player
Established      49539           6976   <- Unity Editor
```

and the player's own log shows a clean session with no `FrameException`:

```
Colibri: connecting to localhost:9012
Colibri: connected to localhost:9012 as app 'myAppName'. Only clients using the same App Name can see each other.
```

Two Unity clients on one machine is the configuration the two-client recipe asks for, and the one
the old hardcoded voice port and the old `static` socket fields would have broken. What it still
does **not** show is the visual half: that moving a cube in one client moves it in the other was
never confirmed, because the player's scene state is not observable from outside its process. Every
message path underneath it was verified separately, but "both connected" is not "sync confirmed".

Two incidental observations from the player run, both of which matter to anyone following the
two-client recipe:

- **TextMeshPro is missing from a fresh project.** The sample scenes' `Instructions` object raised
  `NullReferenceException at TMPro.TMP_Settings.get_defaultFontAsset` in the player, because a new
  project has no TMP Essentials imported. Not a Colibri fault, but it is the first thing anyone
  building this recipe will hit.
- **One orphaned socket, unexplained.** A single Editor connection created at 21:14 was still
  `Established` nearly an hour later with **zero** `WebServerConnection` components alive: a socket
  whose owner was gone. It did not reproduce: a clean enter/exit Play cycle afterwards added no new
  connection and left that one alone. It also appeared during a stretch where the configured TCP port
  was being edited while Play mode ran and proxies were being killed underneath the connection, so
  this is recorded as an observation and not as a diagnosed defect; nothing was changed in response
  to it. It is worth a deliberate look, because a phantom client stays in the server's client list.

### Beyond the ten: the `SyncBehaviour` sample

The ten items are silent about `SyncBehaviour` itself (they cover `SyncTransform`, which is one
particular subclass), so the sample was run as well, and it is the thing that exercises §2's typed
change tracking on members a project actually declares. On connect, each of the three scene models
broadcast its full `[Sync]` state on `samplesyncedbehaviour` (the channel is the type name passed
through `ToLowerInvariant()`), e.g.
`{"id":"nonrandom_id","position":[...],"scale":[...],"rotation":[...],"color":"#00000000","randomvalue":0,"editorteststring":"1234"}`.
All three member kinds propagate: `randomvalue` is a `[Sync, SerializeField]` *private field*,
`editorteststring` a public field, and `position` / `scale` / `rotation` / `color` are properties,
so the `Expression.Compile()` accessors reach non-public state as intended. (That is the Mono path
the Editor runs; IL2CPP builds use the reflection-bound accessors described in §9.) Injecting a
`model::update` for `remote-model-1` produced a `SampleSyncedBehaviourTemplate(Clone)` whose
component read back `RandomValue: 99`, `EditorTestString: "from the injector"`, `Scale: (2,2,2)`,
`Color: RGBA(1,0,0,1)` (parsed from `#FF0000FF`) and `Id: remote-model-1`: every synced member
applied, colour included. Finally, after a full exit and re-enter of Play with no other client
running, Unity re-created that model from the server's stored state via `model::request`, at the
injected position `[7,1,3]` and scale `[2,2,2]`, as exactly **one** instance rather than a
duplicate, which is the late-joiner path, and the one where a double-registration bug would show up
as a second copy.

### Still not covered

All ten of the original criteria have now been addressed. Beyond the ten, this pass did not
touch:

- **Voice chat.** It needs a microphone, so it has no end-to-end test. Unit tests have since
  covered the port-0 bind and the `CancellationToken` shutdown that replaced `Thread.Abort`
  (`VoiceServerAddressTests` opens the socket on the IPv6 loopback, runs the receive thread and
  stops it), the choice of the server's address, failed sends, the queue that hands received
  packets to the main thread (`VoicePacketQueueTests`), framing, resampling, decoding and the
  playback buffer. The microphone and the sample itself have no coverage.
- **The visual half of Unity ↔ Unity.** The player was built and both clients were connected
  concurrently, but object-follows-object between them was not confirmed.
- **Unity 2022.3, Android and the headset.** The pass and the test suites ran on Unity
  6000.5.7f1, in the Editor and in a development Windows player. No run in a 2022.3 Editor, of an
  Android build, or on a Meta Quest is recorded here.

---

## 9. Decisions, and what was deliberately not done

**No `Sync.Send<T>`.** `Sync.Send("ch", value)` already resolves without a cast, because the
argument is a value rather than a method group; there is no ambiguity to fix. Adding a generic
version would turn today's *compile error* on an unsupported type into a runtime `Debug.LogError`,
trading a mistake caught instantly for one caught at 2am.

**No warning for channels with no listeners.** Every client sees every channel its app uses. A
console that cries wolf is a console nobody reads.

**Explicit per-type dispatch instead of `MakeGenericMethod`.** `SyncBehaviour.BuildAttribute` is a
17-line `if` chain over the supported types rather than reflection over an open generic. It keeps
every generic instantiation visible to the AOT compiler (IL2CPP), and it doubles as the place that
can report that a `[Sync]` member has a type Colibri cannot put on the wire.

**No expression trees on IL2CPP.** On Mono the accessors are compiled from expression trees, typed
for properties and fields alike, so nothing boxes. IL2CPP has no JIT: `Expression.Compile()` does
not fail there but falls back to an interpreter that is slow on every call and, for value types,
depends on generic code IL2CPP may not have generated. So under `ENABLE_IL2CPP` a property gets
open-instance delegates bound straight to its get and set methods (the same typed call, still
allocation-free), and a field goes through `FieldInfo.GetValue`/`SetValue`, which boxes a value-type
field on every poll. There is no allocation-free way to read a field through reflection without a
JIT, so on a Quest a hot value-type member is cheaper as a property; every `SyncTransform` member
already is one. The IL2CPP path is compiled on every backend, so the EditMode tests run it in the
Editor.

**`[Sync]` derives from `PreserveAttribute`.** A `[Sync]` member is only ever reached through
reflection, so nothing references it, which is exactly what managed code stripping removes above
the *Minimal* level. The Unity linker honours subclasses of `PreserveAttribute`, and on a property
it keeps the getter and setter too. That keeps the members but not the attribute itself: the linker
leaves Preserve attributes out of what it writes, so from *Medium* up the members lost their
`[Sync]`. `SyncAttribute` therefore also carries `[RequireAttributeUsages]`.

**Registration in `Awake`/`OnDestroy`, not `OnEnable`/`OnDisable`.** The base class already declares
`Awake` and `OnDestroy` as `protected virtual`, so subclasses that shadow them get a compiler
warning. Introducing `OnEnable`/`OnDisable` as *new* virtuals would create a fresh trap: a subclass
writing `private void OnEnable()` would silently take over the Unity message and the object would
never register. Polling is instead gated inside the tick, on the component's own `enabled`, not on
`isActiveAndEnabled`. An inactive GameObject is still polled, because being inactive is itself
synced state: `SyncTransform`'s `Active` reads `activeSelf`, and gated on `isActiveAndEnabled` the
poll stopped the moment the object was switched off, so `false` was never sent and other clients'
copies never disappeared. Disabling only the component stops it syncing without hiding the copies.
Teardown sends nothing through the poll: destroying an object and unloading its scene leave
`activeSelf` alone and remove the object from the ticker in `OnDestroy`, before another poll, so
they send only `model::delete`. Leaving Play mode or quitting deletes nothing, whether the object
is active or not: `OnDestroy` skips the delete when `OnApplicationQuit` ran, which Unity sends only
to active objects, and when `Application.quitting` was raised (`SingletonLifetime.IsQuitting`),
which covers the inactive ones. All that goes out on the way is what the send-rate limit still held
(§2).

**A copy of a disabled `Template` is switched on before it gets its state.** `Instantiate` gives a
copy its template's active state, and a manager's template is often kept switched off in the scene
so that it does not sync as an object of its own. A copy that is off never runs `Awake`, so, with
registration where it is, it never registered for its own updates or with the ticker, and stayed as
its first update left it. `SyncBehaviourManager.OnModelUpdate` therefore switches the copy on first:
`Awake` latches the template's values, the state applied next is latched as well, so none of it is
echoed back, and a `SyncTransform`'s synced `Active` then decides whether it ends up visible. Since
it stays registered while inactive, a later `active: true` shows it again.

**Only the traffic log is reset at `SubsystemRegistration`, not `Sync`'s listener dictionaries.**
Those are statics too, and they survive Play mode with domain reload disabled just as readily. A
listener belonging to a Unity object is dropped once that object is destroyed (lazily, the next time
its channel delivers a message or gets a new registration), and ending a Play session destroys every
one of them, so they never reach the next session's code. A channel's entry can outlive its
listeners that way, which is why every registration asks for the connection again: a client that
only listens would otherwise never rebuild it in the next session. What does leak into the next
session is a `static` listener, or one owned by a plain C# object, since neither has a Unity
lifetime to follow. Clearing them wholesale at startup would be the obvious fix
and is the wrong one: a listener registered from a project's own `[RuntimeInitializeOnLoadMethod]`
hook would be silently unregistered by it, depending on which ran first. Left as a known
edge rather than traded for a subtler one.

**Known limitation, unchanged from before:** a `[Sync]` array mutated **in place** is not detected.
`EqualityComparer<float[]>.Default` falls back to reference equality, exactly as `object.Equals` on
a boxed array did. Assign a new array to trigger a sync.

---

## Appendix: file map and commits

### New files

| File | Purpose |
|---|---|
| `Synchronization/Code/SyncTicker.cs` | The single per-frame driver |
| `Synchronization/Code/ChannelListenerRegistry.cs` | Channel→type registry and mismatch messages |
| `Setup/ColibriStatusWindow.cs` | `Window → Colibri Status` |
| `Tests/Editor/ChannelListenerRegistryTests.cs` | 11 EditMode tests |

### Modified

`Synchronization/Code/SyncBehaviour.cs` (typed attributes, ticker, static events),
`SyncBehaviourManager.cs` (event handlers + unsubscribe), `Sync.cs` (generics, mismatch reporting,
traffic log, log reset and retention), `Networking/WebServerConnection.cs` (config reporting, status
accessors, `ConfigureAwait(false)` across the connection path and the concurrency audit that
follows from it, delivery-rate readout),
`Networking/RemoteLogging.cs` (timer instead of throttle), `Store/Store.cs` (awaiter, error
reporting), `Setup/ColibriConfig.cs` (non-null defaults), `Setup/SetupWindow.cs`,
`Samples/SendMessages/SendMessages.cs`, `Samples/VoiceChat/VoiceManager.cs`, `Colibri.asmdef`,
`Packages/manifest.json`, `Packages/packages-lock.json`, `THIRD_PARTY_NOTICES.txt`, `README.md`,
`CHANGELOG.md`.

### Commits

```
a9010ed  perf(unity): drive sync change detection from one central ticker
9cbc0b9  refactor(unity): drop UniTask from Store and RemoteLogging
5c33fc7  build(unity): remove the R3 and UniTask dependencies
2d83436  feat(unity): report type mismatches and drop the casts from Sync.Receive
30c00f7  fix(unity): say what is wrong when Colibri is not configured
8906b6e  feat(unity): add a Window -> Colibri Status panel
e9c9be4  fix(unity): keep the mismatch key separator as a source escape
1a4678d  docs(unity): rewrite the install and lead with the cast-free API
eb71408  fix(unity): stop the unconfigured fallback allocating a config per frame
```

24 files, +1405 / −429.
