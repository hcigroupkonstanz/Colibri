using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The requests made again after one reconnect, from when they go out until the answers to all of them have
    /// arrived. During it a SyncBehaviour compares what it receives with what it sent before the outage (see
    /// SyncBehaviour's OnModelUpdate), and the deletes sent again ahead of the requests may not have reached
    /// the server.
    /// </summary>
    // An answer is an ordinary model::update, so it cannot be told from an update relayed from another client, and
    // answers cannot be counted. What can be told is the end: the server handles one client's messages in order and
    // answers in the same order, so the answer to a final request comes after all the others. That request asks for
    // an id no model has, on a channel with no models (Sync.ReconnectRoundChannel), so its bare { id } answer is
    // unmistakable. Whatever arrives before it was sent before the server read the request, so before anything this
    // client sends in reply; relayed updates in that stretch hold the server's values like the answers and are
    // judged with them. Once it arrives, the server has read everything queued ahead of the request, the resent
    // deletes included.
    // A SyncBehaviour that keeps changes of its own at its first answer opens a round of its own (see
    // Sync.AskForEndOfAnswers).
    internal sealed class ReconnectRound
    {
        // When the outage was noticed, on SyncTicker's clock: an earlier one if the link dropped again before the
        // previous round was over. Negative infinity for a round an object opened at its first answer, which
        // follows no outage: everything the object sends counts.
        internal readonly double DisconnectedAt;

        internal readonly string EndMarkerId = Guid.NewGuid().ToString();

        internal bool IsOver;

        internal ReconnectRound(double disconnectedAt) => DisconnectedAt = disconnectedAt;
    }
}
