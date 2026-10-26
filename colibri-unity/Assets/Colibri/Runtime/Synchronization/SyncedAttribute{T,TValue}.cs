using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// A [Sync] member of type <typeparamref name="TValue"/>, with typed accessors, and the factory of its
    /// <see cref="ChangeTracker{T,TValue}"/>.
    /// </summary>
    internal sealed class SyncedAttribute<T, TValue> : SyncedAttribute<T>
        where T : SyncBehaviour<T>
    {
        public Func<T, TValue> Getter;
        public Action<T, TValue> Setter;

        public override object GetBoxed(T target) => Getter(target);
        public override void SetBoxed(T target, object value) => Setter(target, (TValue)value);
        public override IChangeTracker<T> CreateTracker(T target) => new ChangeTracker<T, TValue>(Getter, target);
    }
}
