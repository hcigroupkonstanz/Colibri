namespace HCIKonstanz.Colibri.Synchronization
{
    internal interface IChangeTracker<T>
        where T : SyncBehaviour<T>
    {
        /// <summary>Latches the current value; true if it differs from the one latched before.</summary>
        bool CaptureChange(T target);

        /// <summary>Latches the current value without reporting it as a change.</summary>
        void Latch(T target);
    }
}
