using System.Collections.Generic;
using System.Threading;
using Newtonsoft.Json.Linq;
using UnityEngine;

namespace HCIKonstanz.Colibri.Networking
{
    /// <summary>
    /// Carries received messages from the receive loop to the main thread, where Update takes them.
    /// <c>_queuedCommandsLock</c> guards the queue and its backlog counters.
    /// </summary>
    internal sealed class ReceiveQueue
    {
        // Received messages waiting for Update past which model updates are folded per object, newer fields
        // winning. The receive thread keeps reading while Update does not run (Quest paused, Editor in the
        // background), so model state is bounded by the number of objects, not by how long Update stalled.
        // A listener that records every update sees only the newest state of each object for that stretch.
        private const int RECEIVED_FOLDING_THRESHOLD = 1000;

        // Cap on all received messages waiting for Update, the backstop for RECEIVED_FOLDING_THRESHOLD as
        // MAX_OUTBOX_MESSAGES is for the outbox. The oldest broadcasts and other non-model messages are
        // dropped first, then the oldest model messages.
        private const int MAX_RECEIVED_MESSAGES = 10000;

        // Receive loop in, main thread out. Everything up to _hasWarnedAboutReceivedBacklog is guarded by
        // _queuedCommandsLock. See EnqueueReceived for how the queue is bounded.
        private readonly LinkedList<InPacket> _queuedCommands = new LinkedList<InPacket>();
        private readonly object _queuedCommandsLock = new object();

        // During a backlog (from RECEIVED_FOLDING_THRESHOLD messages until Update takes them): the model::update
        // queued for each object that later ones can still be folded into, i.e. with nothing else about the
        // object queued behind it.
        private readonly Dictionary<(string Channel, string Id), LinkedListNode<InPacket>> _queuedReceivedUpdates
            = new Dictionary<(string Channel, string Id), LinkedListNode<InPacket>>();
        private bool _isReceivedBacklog;
        private int _droppableReceivedCount;
        private int _foldedReceivedCount;
        private int _droppedReceivedCount;

        // Reset on every connection, so a backlog is logged once per connection.
        private bool _hasWarnedAboutReceivedBacklog;

        /// <summary>
        /// Hands a received message to the main thread, where <see cref="WebServerConnection.Update"/> delivers it. Bounded like
        /// the outbox for the stretches Update does not run: past <see cref="RECEIVED_FOLDING_THRESHOLD"/>
        /// waiting messages a model::update is folded into the one queued for the same object, and past
        /// <see cref="MAX_RECEIVED_MESSAGES"/> the oldest messages are dropped, broadcasts first.
        /// Does nothing once OnDisable has ended the connection loop that <paramref name="token"/> belongs
        /// to: the next loop's messages may be queued by then, and this one would land behind them.
        /// </summary>
        /// <remarks>
        /// Called from the receive loop. The queue owns <paramref name="payload"/> from here on: a fold writes
        /// newer fields into it.
        /// </remarks>
        internal void EnqueueReceived(string channel, string command, JToken payload, CancellationToken token)
        {
            var canDrop = ModelCommands.IsDroppable(command);

            lock (_queuedCommandsLock)
            {
                // Checked and queued under one lock: the next loop starts only after OnDisable has cancelled the
                // token, so its messages queue behind this one.
                if (token.IsCancellationRequested)
                    return;

                if (!_isReceivedBacklog && _queuedCommands.Count >= RECEIVED_FOLDING_THRESHOLD)
                    _isReceivedBacklog = true;

                if (_isReceivedBacklog && ModelCommands.IsFoldableUpdate(command, payload, out var update, out var id))
                {
                    var key = (channel, id);
                    if (_queuedReceivedUpdates.TryGetValue(key, out var queued))
                    {
                        // The queued payload was parsed off the socket and nothing else holds it yet. To the back of the
                        // queue: it now carries the newest change.
                        var merged = (JObject)queued.Value.Payload;
                        foreach (var property in update.Properties())
                            merged[property.Name] = property.Value;

                        _queuedCommands.Remove(queued);
                        _queuedCommands.AddLast(queued);
                        _foldedReceivedCount++;
                        return;
                    }

                    _queuedReceivedUpdates[key] = _queuedCommands.AddLast(
                        new InPacket { Channel = channel, Command = command, Payload = payload, CanDrop = false });
                }
                else
                {
                    // A delete, or a bare { id } that answers a request, ends the fold for its object: an older update
                    // folded past it would arrive after it. The outbox ends folds the same way.
                    if (_isReceivedBacklog && !canDrop)
                        ModelCommands.EndFolds(_queuedReceivedUpdates, channel, payload);

                    _queuedCommands.AddLast(new InPacket { Channel = channel, Command = command, Payload = payload, CanDrop = canDrop });
                    if (canDrop)
                        _droppableReceivedCount++;
                }

                while (_queuedCommands.Count > MAX_RECEIVED_MESSAGES)
                    DropOldestReceived();
            }
        }

        // Under _queuedCommandsLock. The oldest message that may be dropped goes first, and only
        // when none is left the oldest of the rest.
        private void DropOldestReceived()
        {
            var victim = _queuedCommands.First;
            if (_droppableReceivedCount > 0)
            {
                while (!victim.Value.CanDrop)
                    victim = victim.Next;
                _droppableReceivedCount--;
            }

            _queuedCommands.Remove(victim);
            _droppedReceivedCount++;

            var packet = victim.Value;
            if (!packet.CanDrop
                && ModelCommands.TryGetModelId(packet.Payload, out _, out var id)
                && _queuedReceivedUpdates.TryGetValue((packet.Channel, id), out var indexed)
                && ReferenceEquals(indexed, victim))
            {
                _queuedReceivedUpdates.Remove((packet.Channel, id));
            }
        }

        internal bool TryTakeAll(List<InPacket> batch)
        {
            int folded;
            int dropped;
            var warnAboutBacklog = false;

            // Taken in one go, so the receive thread is held up once per frame rather than once per
            // message. What arrives while these are delivered waits for the next frame.
            lock (_queuedCommandsLock)
            {
                if (_queuedCommands.Count == 0)
                    return false;

                batch.AddRange(_queuedCommands);
                _queuedCommands.Clear();

                folded = _foldedReceivedCount;
                dropped = _droppedReceivedCount;
                if ((folded > 0 || dropped > 0) && !_hasWarnedAboutReceivedBacklog)
                {
                    _hasWarnedAboutReceivedBacklog = true;
                    warnAboutBacklog = true;
                }

                // The backlog, if there was one, is over.
                _isReceivedBacklog = false;
                _queuedReceivedUpdates.Clear();
                _droppableReceivedCount = 0;
                _foldedReceivedCount = 0;
                _droppedReceivedCount = 0;
            }

            if (warnAboutBacklog)
            {
                var lost = dropped > 0
                    ? $" and the {dropped} oldest messages were dropped, broadcasts first"
                    : "; nothing was dropped";
                Debug.LogWarning($"Colibri: {batch.Count + folded + dropped} received messages waited for Update, which did not run "
                    + "for a while (the app was paused, or the Editor was in the background without Run In Background). To keep memory "
                    + $"bounded, {folded} model updates were folded into the newest state of their object{lost}. Said once per connection.");
            }

            return true;
        }

        internal void ResetBacklogWarning()
        {
            lock (_queuedCommandsLock)
                _hasWarnedAboutReceivedBacklog = false;
        }
    }
}
