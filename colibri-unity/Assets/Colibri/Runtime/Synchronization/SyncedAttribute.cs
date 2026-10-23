using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Metadata of one [Sync] member of a model type, built once per type by <see cref="SyncMembers{T}"/>.
    /// Typed throughout, so the change comparison never boxes.
    /// </summary>
    internal abstract class SyncedAttribute<T>
        where T : SyncBehaviour<T>
    {
        public string Name;

        /// <summary>The C# name, which <see cref="SyncBehaviour{T}.IsSynced"/> is asked about.</summary>
        public string MemberName;

        public int Index;
        public Type PropertyType;

        /// <summary>Boxes, so only call it for a value that is about to be sent.</summary>
        public abstract object GetBoxed(T target);
        public abstract void SetBoxed(T target, object value);
        public abstract IChangeTracker<T> CreateTracker(T target);
    }
}
