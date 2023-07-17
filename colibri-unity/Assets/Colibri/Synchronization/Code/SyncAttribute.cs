using System;

namespace HCIKonstanz.Colibri.Synchronization
{
    [AttributeUsage(AttributeTargets.Field | AttributeTargets.Property)]
    public class SyncAttribute : Attribute
    {
        public SyncAttribute()
        {
        }
    }
}
