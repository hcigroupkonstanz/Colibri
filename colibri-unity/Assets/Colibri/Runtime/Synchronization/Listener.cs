using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    // A callback with the Unity object it belongs to, so the listener goes away with that object.
    internal readonly struct Listener<T>
    {
        public readonly Action<T> Callback;

        // Model listeners only: the id of the model, or null for a listener of every model on the channel.
        // Requested again after a reconnect.
        public readonly string FetchId;

        // SyncBehaviour model listeners only: called with the round when FetchId is requested again after a reconnect.
        public readonly Action<ReconnectRound> RequestedAgain;

        private readonly UnityEngine.Object _owner;
        private readonly bool _isOwned;

        public Listener(Action<T> callback, string fetchId = null, Action<ReconnectRound> requestedAgain = null)
        {
            Callback = callback;
            FetchId = fetchId;
            RequestedAgain = requestedAgain;
            _owner = ListenerOwner.Of(callback);
            _isOwned = !ReferenceEquals(_owner, null);
        }

        public bool IsOrphaned => _isOwned && _owner == null;
    }
}
