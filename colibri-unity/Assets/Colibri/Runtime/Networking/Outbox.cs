using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using HCIKonstanz.Colibri.Networking.Protocol;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Queues every outgoing message and writes it to the current session in send order. Senders on any thread,
    /// the drainer on the thread pool and the connection loop share it under <c>_outboxLock</c>.
    /// </summary>
    internal sealed class Outbox
    {
        // Cap on broadcasts and other messages that are not model state waiting for the connection. The oldest
        // are dropped: this is a last-write-wins sync client, so a long queue only buffers superseded updates.
        // Model messages are not counted here, see "The outbox" below.
        private const int MAX_QUEUED_MESSAGES = 256;

        // Cap on the whole outbox, model state included: the backstop for MAX_QUEUED_MESSAGES, which applies
        // only while disconnected and does not count requests, deletes and unfoldable updates. Past it the
        // oldest droppable messages go first, then the oldest model messages.
        private const int MAX_OUTBOX_MESSAGES = 10000;

        private readonly FrameWriter _frameWriter;

        // Every outgoing message in send order, until written to a socket (see "The outbox" below).
        // Everything up to _hasWarnedAboutRefusal is guarded by _outboxLock: senders on any thread, the
        // drainer on the thread pool and the connection loop all touch it.
        private readonly LinkedList<Outgoing> _outbox = new LinkedList<Outgoing>();
        private readonly object _outboxLock = new object();

        // The session the outbox drains into, and its token. Null while not connected, which makes a send
        // wait in the outbox.
        private ServerSession _outboxSession;
        private CancellationToken _outboxToken;

        // True while a DrainOutbox is running. Only one runs at a time, which keeps the messages in order.
        private bool _isDraining;

        // Reset when the outbox opens, so each is logged once per connection.
        private bool _hasWarnedAboutDrops;
        private bool _hasWarnedAboutOutboxLimit;

        // Set when the server refuses this client's protocol version. Nothing is sent after that, so a send
        // completes at once as dropped.
        private bool _isRefused;
        private bool _hasWarnedAboutRefusal;

        // Under _outboxLock: how many droppable messages the outbox holds, and the model::update
        // queued for each object during the current outage that later ones can still be folded
        // into, i.e. with nothing else about the object queued behind it.
        private int _droppableCount;
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>> _queuedModelUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<Outgoing>>();

        internal Outbox(FrameWriter frameWriter)
        {
            _frameWriter = frameWriter;
        }


        /*
         *  The outbox.
         *
         *  Every message goes into one FIFO and is written to the socket by one drainer, so messages leave
         *  in the order they were sent, across an outage too. While connected the outbox is just the way to
         *  the socket and normally empty or close to it. While not, it is the retry queue, sent ahead of
         *  anything newer once the next session is connected. A message whose write failed stays at the head
         *  and goes first next time.
         *
         *  The queue is bounded during an outage, but not by dropping just anything. Broadcasts, and
         *  anything else that is not model state, are capped at MAX_QUEUED_MESSAGES, oldest dropped first.
         *  The model commands are not dropped by it, because nothing would repair the loss: a dropped
         *  model::request leaves its SyncBehaviour waiting for its first state and never sending a change, a
         *  dropped model::delete leaves the object alive on every other client, and a dropped model::update
         *  is lost, and the re-request after reconnecting then reverts it locally to the server's older copy.
         *  Instead, every model::update queued for the same object during an outage is folded into one, newer
         *  fields winning, which is what a last-write-wins server would have ended up with. That keeps model
         *  state bounded by the number of objects rather than by how long the outage lasts.
         *
         *  Requests, deletes and awaited updates are not folded; each is queued as it is. So behind both of
         *  these sits a hard cap on the whole outbox, MAX_OUTBOX_MESSAGES, which applies while connected too:
         *  the last resort, which does drop model state rather than grow without end.
         *
         *  The folded update moves to the back of the queue, so a fold must never carry an update past
         *  something else about the same object: a newer update, a delete, or a request the server would
         *  answer without it. Such a message ends the fold for that object, the next update starts a new one
         *  behind it, and reconnecting ends every fold.
         */

        private sealed class Outgoing
        {
            public byte[] Frame;

            // Null for SendCommand, which nobody awaits.
            public TaskCompletionSource<bool> Sent;

            // Whether the outage bound counts it, and the cap on the whole outbox drops it before any
            // model command: false for the model commands.
            public bool CanDrop;

            // Set for a model::update queued during an outage, which later updates for the same
            // object in that outage may be folded into (see _queuedModelUpdates). The payload is a
            // private copy.
            public JObject ModelUpdate;
            public (string Channel, string Id) ModelKey;
        }

        /// <summary>
        /// Lets the outbox drain into this session. Called once it is Connected, with the token of the loop the
        /// session belongs to: once OnDisable has ended that loop this does nothing.
        /// </summary>
        internal void OpenOutbox(ServerSession session, CancellationToken token)
        {
            bool startDraining;
            lock (_outboxLock)
            {
                // Checked under the lock: OnDisable cancels the token before it closes the outbox.
                if (token.IsCancellationRequested)
                    return;

                _outboxSession = session;
                _outboxToken = token;
                _hasWarnedAboutDrops = false;
                _hasWarnedAboutOutboxLimit = false;

                // Folds last one outage. What was folded in the outage that just ended is ordinary queued messages
                // now; if one is still queued when the connection drops again (slow link), folding the next outage's
                // update for that object into it would move it past the newer updates queued behind it.
                _queuedModelUpdates.Clear();

                startDraining = !_isDraining && _outbox.Count > 0;
                if (startDraining)
                    _isDraining = true;
            }

            if (startDraining)
                _ = DrainOutbox();
        }

        /// <summary>Makes every send from now on wait in the outbox for the next connection.</summary>
        internal void CloseOutbox()
        {
            lock (_outboxLock)
            {
                _outboxSession = null;
                _outboxToken = CancellationToken.None;

                // Nothing more will be written to that session: see WaitForOutboxToDrain.
                Monitor.PulseAll(_outboxLock);
            }
        }

        /// <summary>
        /// <see cref="CloseOutbox()"/> for the connection loop that <paramref name="token"/> belongs to, when
        /// its session ends, unless OnDisable has ended that loop: it has closed the outbox itself, and the
        /// outbox may already drain into the next loop's session.
        /// </summary>
        internal void CloseOutbox(CancellationToken token)
        {
            lock (_outboxLock)
            {
                if (!token.IsCancellationRequested)
                    CloseOutbox();
            }
        }

        /// <summary>
        /// Blocks until everything in the outbox has been written to the current session's socket,
        /// the session has ended or <paramref name="timeoutMs"/> has passed, whichever comes
        /// first. Returns at once while not connected.
        /// </summary>
        /// <returns>True if the outbox is empty.</returns>
        /// <remarks>
        /// Safe to call from the main thread: the drainer never needs it, since every await on the
        /// way to the socket is ConfigureAwait(false).
        /// </remarks>
        internal bool WaitForOutboxToDrain(int timeoutMs)
        {
            var clock = System.Diagnostics.Stopwatch.StartNew();
            lock (_outboxLock)
            {
                // Woken by the drainer after each message it has written, and when the session ends.
                while (_outbox.Count > 0 && _outboxSession != null)
                {
                    var remaining = timeoutMs - clock.ElapsedMilliseconds;
                    if (remaining <= 0)
                        break;

                    Monitor.Wait(_outboxLock, (int)remaining);
                }

                return _outbox.Count == 0;
            }
        }

        /// <summary>
        /// The server refused this client: everything still queued is dropped, and so is every later send as it
        /// is made. Nothing will connect again, so waiting would leave every <see cref="WebServerConnection.SendCommandAsync"/>
        /// pending for good.
        /// Does nothing once OnDisable has ended the loop that <paramref name="token"/> belongs to: enabling the
        /// component again is a deliberate retry, and the next loop's sends are not refused.
        /// </summary>
        internal void RefuseSends(CancellationToken token)
        {
            Outgoing[] dropped;
            lock (_outboxLock)
            {
                // Checked under the lock that OnEnable lifts a refusal under.
                if (token.IsCancellationRequested)
                    return;

                _isRefused = true;
                dropped = TakeEverythingQueued();
            }

            foreach (var message in dropped)
                message.Sent?.TrySetResult(false);
        }

        internal void LiftRefusal()
        {
            lock (_outboxLock)
            {
                _isRefused = false;
                _hasWarnedAboutRefusal = false;
            }
        }

        internal void AbandonEverythingQueued()
        {
            Outgoing[] abandoned;
            lock (_outboxLock)
                abandoned = TakeEverythingQueued();

            foreach (var message in abandoned)
                message.Sent?.TrySetResult(false);
        }

        // Under _outboxLock.
        private Outgoing[] TakeEverythingQueued()
        {
            var taken = new Outgoing[_outbox.Count];
            _outbox.CopyTo(taken, 0);
            _outbox.Clear();
            _queuedModelUpdates.Clear();
            _droppableCount = 0;
            return taken;
        }

        // Under _outboxLock. Every removal from the outbox goes through here, so the count and the
        // index of queued model updates stay true to what is in it.
        private void RemoveFromOutbox(LinkedListNode<Outgoing> node)
        {
            _outbox.Remove(node);

            var message = node.Value;
            if (message.CanDrop)
                _droppableCount--;

            if (message.ModelUpdate != null
                && _queuedModelUpdates.TryGetValue(message.ModelKey, out var indexed)
                && ReferenceEquals(indexed, node))
            {
                _queuedModelUpdates.Remove(message.ModelKey);
            }
        }

        internal void Post(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            List<Outgoing> dropped = null;
            var warnAboutDrops = false;
            var warnAboutOutboxLimit = false;
            var startDraining = false;
            var refused = false;
            var warnAboutRefusal = false;

            lock (_outboxLock)
            {
                if (_isRefused)
                {
                    refused = true;
                    warnAboutRefusal = !_hasWarnedAboutRefusal;
                    _hasWarnedAboutRefusal = true;
                }
                else if (_outboxSession == null)
                {
                    Queue(channel, command, payload, frame, sent);
                    warnAboutDrops = EnforceOutageBound(ref dropped);
                }
                else
                {
                    startDraining = AddWhileConnected(command, frame, sent);
                }

                if (!refused && _outbox.Count > MAX_OUTBOX_MESSAGES)
                    warnAboutOutboxLimit = EnforceOutboxLimit(ref dropped);
            }

            // Logged, and the dropped tasks completed, outside the lock: both can run other code.
            if (refused)
            {
                FinishRefusedPost(channel, command, sent, warnAboutRefusal);
                return;
            }

            FinishPost(dropped, warnAboutDrops, warnAboutOutboxLimit, startDraining);
        }

        private static void FinishRefusedPost(string channel, string command, TaskCompletionSource<bool> sent, bool warnAboutRefusal)
        {
            if (warnAboutRefusal)
            {
                Debug.LogWarning($"Colibri: not sending {command} on channel '{channel}' - the server refused this client's protocol version, "
                    + "so nothing is sent any more. Every later message is dropped the same way; this is said once.");
            }

            sent?.TrySetResult(false);
        }

        private void FinishPost(List<Outgoing> dropped, bool warnAboutDrops, bool warnAboutOutboxLimit, bool startDraining)
        {
            if (warnAboutDrops)
            {
                Debug.LogWarning($"Colibri: more than {MAX_QUEUED_MESSAGES} messages are waiting for the connection to come back, "
                    + "so the oldest are being dropped. Synchronized model state is kept: it is folded into one update per object instead. "
                    + "Said once per outage.");
            }

            if (warnAboutOutboxLimit)
            {
                Debug.LogWarning($"Colibri: more than {MAX_OUTBOX_MESSAGES} messages are waiting to be sent, so the oldest are being dropped - "
                    + "broadcasts and other messages first, and once there are none of those left, synchronized model state (requests, "
                    + "updates and deletes), which other clients then never see. Said once per connection.");
            }

            if (dropped != null)
            {
                foreach (var message in dropped)
                    message.Sent?.TrySetResult(false);
            }

            // Outside the lock: the drain runs synchronously up to its first write that does not
            // complete at once.
            if (startDraining)
                _ = DrainOutbox();
        }

        // Under _outboxLock.
        private bool EnforceOutageBound(ref List<Outgoing> dropped)
        {
            while (_droppableCount > MAX_QUEUED_MESSAGES)
            {
                var oldest = _outbox.First;
                while (!oldest.Value.CanDrop)
                    oldest = oldest.Next;

                (dropped ??= new List<Outgoing>()).Add(oldest.Value);
                RemoveFromOutbox(oldest);
            }

            if (dropped != null && !_hasWarnedAboutDrops)
            {
                _hasWarnedAboutDrops = true;
                return true;
            }

            return false;
        }

        // Under _outboxLock. The oldest message that may be dropped goes first, and only when none
        // is left the oldest of the rest. Never the message the drainer is writing at this moment:
        // dropping that one would report as dropped a message that may well arrive.
        private bool EnforceOutboxLimit(ref List<Outgoing> dropped)
        {
            while (_outbox.Count > MAX_OUTBOX_MESSAGES)
            {
                var oldest = _isDraining ? _outbox.First.Next : _outbox.First;

                var victim = oldest;
                if (_droppableCount > 0)
                {
                    var droppable = oldest;
                    while (droppable != null && !droppable.Value.CanDrop)
                        droppable = droppable.Next;

                    victim = droppable ?? oldest;
                }

                (dropped ??= new List<Outgoing>()).Add(victim.Value);
                RemoveFromOutbox(victim);
            }

            var warnAboutOutboxLimit = !_hasWarnedAboutOutboxLimit;
            _hasWarnedAboutOutboxLimit = true;
            return warnAboutOutboxLimit;
        }

        // Under _outboxLock, while not connected.
        private void Queue(string channel, string command, JToken payload, byte[] frame, TaskCompletionSource<bool> sent)
        {
            // Only what nobody awaits is folded: each awaited task has to complete for its own message.
            if (sent == null && command == ModelCommands.MODEL_UPDATE_COMMAND && ModelCommands.TryGetModelId(payload, out var update, out var id))
            {
                var key = (channel, id);

                // A copy, because the caller's object may change after it was sent.
                var latest = (JObject)update.DeepClone();

                if (_queuedModelUpdates.TryGetValue(key, out var queued))
                {
                    var merged = (JObject)queued.Value.ModelUpdate.DeepClone();
                    foreach (var property in latest.Properties())
                        merged[property.Name] = property.Value;

                    var mergedFrame = PayloadCodec.TryEncodeFrame(channel, command, merged);
                    if (mergedFrame != null)
                    {
                        // To the back of the queue: it now carries the newest change.
                        RemoveFromOutbox(queued);
                        latest = merged;
                        frame = mergedFrame;
                    }
                }

                _queuedModelUpdates[key] = _outbox.AddLast(new Outgoing { Frame = frame, CanDrop = false, ModelUpdate = latest, ModelKey = key });
                return;
            }

            var canDrop = ModelCommands.IsDroppable(command);
            if (!canDrop)
                ModelCommands.EndFolds(_queuedModelUpdates, channel, payload);

            _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = canDrop });
            if (canDrop)
                _droppableCount++;
        }

        // Under _outboxLock.
        private bool AddWhileConnected(string command, byte[] frame, TaskCompletionSource<bool> sent)
        {
            _outbox.AddLast(new Outgoing { Frame = frame, Sent = sent, CanDrop = ModelCommands.IsDroppable(command) });
            if (ModelCommands.IsDroppable(command))
                _droppableCount++;

            if (!_isDraining)
            {
                _isDraining = true;
                return true;
            }

            return false;
        }

        /// <summary>
        /// Writes the outbox to the current session's socket, head first, until it is empty or
        /// the session is gone. Only ever one running (<c>_isDraining</c>), and it reads the session
        /// afresh for every message, so a drainer that outlives one session carries on into the next.
        /// </summary>
        private async Task DrainOutbox()
        {
            while (true)
            {
                LinkedListNode<Outgoing> node;
                Outgoing next;
                ServerSession session;
                CancellationToken token;
                lock (_outboxLock)
                {
                    if (_outboxSession == null || _outbox.Count == 0)
                    {
                        _isDraining = false;
                        return;
                    }

                    node = _outbox.First;
                    next = node.Value;
                    session = _outboxSession;
                    token = _outboxToken;
                }

                try
                {
                    await _frameWriter.SendFrame(session, next.Frame, token).ConfigureAwait(false);
                }
                catch (Exception e)
                {
                    // The message stays at the head of the outbox and is the first thing the
                    // next session sends. This session is finished: close it, so the receive loop
                    // notices now rather than at the next heartbeat.
                    CloseFailedSession(session, token, e);
                    continue;
                }

                lock (_outboxLock)
                {
                    // Gone already if, while it was being written, the session ended and the
                    // outage bound dropped it. (A fold never absorbs it: only updates queued since
                    // the outbox last closed are folded into, and this one was queued before that.)
                    if (node.List == _outbox)
                        RemoveFromOutbox(node);

                    // One message further: see WaitForOutboxToDrain.
                    Monitor.PulseAll(_outboxLock);
                }

                next.Sent?.TrySetResult(true);
            }
        }

        private void CloseFailedSession(ServerSession session, CancellationToken token, Exception e)
        {
            lock (_outboxLock)
            {
                if (ReferenceEquals(_outboxSession, session))
                {
                    _outboxSession = null;
                    _outboxToken = CancellationToken.None;
                    Monitor.PulseAll(_outboxLock);
                }
            }

            if (!token.IsCancellationRequested)
                Debug.Log($"Colibri: sending failed ({e.GetType().Name}: {e.Message}); queued messages will be sent after reconnecting");

            session.Close();
        }
    }
}
