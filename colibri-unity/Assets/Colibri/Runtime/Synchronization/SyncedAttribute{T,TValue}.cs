using System;

namespace HCIKonstanz.Colibri.Synchronization
{
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
