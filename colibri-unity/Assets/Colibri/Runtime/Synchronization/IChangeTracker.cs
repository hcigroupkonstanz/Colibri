namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Remembers the last value of one [Sync] member of one model instance and tells whether it has changed since.
    /// Used from the main thread, by the poll of <see cref="SyncBehaviour{T}"/>.
    /// </summary>
    internal interface IChangeTracker<T>
        where T : SyncBehaviour<T>
    {
        /// <summary>Latches the current value; true if it differs from the one latched before.</summary>
        public bool CaptureChange(T target);

        /// <summary>Latches the current value without reporting it as a change.</summary>
        public void Latch(T target);
    }
}
