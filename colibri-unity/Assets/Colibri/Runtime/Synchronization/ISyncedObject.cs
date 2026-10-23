namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Non-generic view of a SyncBehaviour, so components of any type are found with
    /// GetComponents&lt;ISyncedObject&gt;().
    /// </summary>
    internal interface ISyncedObject
    {
        public string Id { get; }

        // Id generated on this client: the server holds nothing for it yet.
        public bool MadeItsId { get; }

        // No-op if the id is set already.
        public void TakeId(string id, bool madeHere);

        // Part of a copy built from a remote update: keeps its Id.
        public void MarkAsCopy();

        // Part of a copy that is destroyed at once: sends no delete.
        public void MarkDiscarded();

        // A remote update moved a synced parent and this object with it: latches the pose so it is not sent
        // as a change.
        public void LatchMovedWithParent();

        public bool IsCopy { get; }

        // Null before Awake.
        public string RegisteredId { get; }

        // Restores the registered Id and ModelId if they changed, and logs an error.
        public void KeepRegisteredId();
    }
}
