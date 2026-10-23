using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// The <see cref="IChangeTracker{T}"/> of a member of type <typeparamref name="TValue"/>. Latches a copy of an
    /// array or JObject value, which the application may change in place, and compares as on the wire.
    /// </summary>
    internal sealed class ChangeTracker<T, TValue> : IChangeTracker<T>
        where T : SyncBehaviour<T>
    {
        private static readonly Func<TValue, TValue, bool> _areEqual = SyncValues.EqualityFor<TValue>();
        private static readonly Func<TValue, TValue> _keep = SyncValues.CopyFor<TValue>();

        private readonly Func<T, TValue> _getter;
        private TValue _lastValue;

        public ChangeTracker(Func<T, TValue> getter, T target)
        {
            _getter = getter;
            _lastValue = _keep(getter(target));
        }

        public bool CaptureChange(T target)
        {
            var current = _getter(target);

            // Compared as on the wire (see SyncValues). Value types use EqualityComparer<TValue>.Default,
            // which does not box.
            if (_areEqual(current, _lastValue))
                return false;

            _lastValue = _keep(current);
            return true;
        }

        public void Latch(T target)
        {
            _lastValue = _keep(_getter(target));
        }
    }
}
