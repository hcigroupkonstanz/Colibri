using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    internal sealed class ChangeTracker<T, TValue> : IChangeTracker<T>
        where T : SyncBehaviour<T>
    {
        private static readonly Func<TValue, TValue, bool> AreEqual = SyncValues.EqualityFor<TValue>();
        private static readonly Func<TValue, TValue> Keep = SyncValues.CopyFor<TValue>();

        private readonly Func<T, TValue> _getter;
        private TValue _lastValue;

        public ChangeTracker(Func<T, TValue> getter, T target)
        {
            _getter = getter;
            _lastValue = Keep(getter(target));
        }

        public bool CaptureChange(T target)
        {
            var current = _getter(target);

            // Compared as on the wire (see SyncValues). Value types use EqualityComparer<TValue>.Default,
            // which does not box.
            if (AreEqual(current, _lastValue))
                return false;

            _lastValue = Keep(current);
            return true;
        }

        public void Latch(T target)
        {
            _lastValue = Keep(_getter(target));
        }
    }
}
