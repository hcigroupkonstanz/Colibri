using System.Collections.Generic;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>The deletes the server may not have read around an outage, kept so they can go out again.</summary>
    internal sealed class UnreadDeletes
    {
        // Deletes the server may not have read, oldest first: those sent again at an outage and every one sent
        // since, until the answers to the requests made after the reconnect are in (see ReconnectRound). Null while
        // none is in question. If the link drops again meanwhile they all go out again, however old: the
        // LocallyDeletedModels window is a minute and an outage can last longer.
        private List<(string Channel, string Id)> _deletes;
        private readonly HashSet<(string Channel, string Id)> _keys = new HashSet<(string Channel, string Id)>();

        internal void StartTracking() => _deletes ??= new List<(string Channel, string Id)>();

        public List<(string Channel, string Id)>.Enumerator GetEnumerator() => _deletes.GetEnumerator();

        internal void Note(string channel, string id)
        {
            if (_deletes != null && _keys.Add((channel, id)))
                _deletes.Add((channel, id));
        }

        // The id is in use again (asked for afresh): sending its delete once more would remove the new object
        // here and on every other client.
        internal void Forget(string channel, string id)
        {
            if (_deletes != null && _keys.Remove((channel, id)))
                _deletes.Remove((channel, id));
        }

        internal void ForgetAll()
        {
            _deletes = null;
            _keys.Clear();
        }
    }
}
