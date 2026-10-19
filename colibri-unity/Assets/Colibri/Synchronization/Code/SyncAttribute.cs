using System;
using UnityEngine.Scripting;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Marks a field or property of a <see cref="SyncBehaviour{T}"/> for synchronization.
    /// </summary>
    // Derives from PreserveAttribute: members are only reached by reflection, so stripping removes them.
    // The linker drops PreserveAttribute subclasses from the output unless [RequireAttributeUsages] is set.
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
    [RequireAttributeUsages]
    public class SyncAttribute : PreserveAttribute
    {
        public SyncAttribute()
        {
        }
    }
}
