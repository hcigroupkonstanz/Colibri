namespace HCIKonstanz.Colibri.Synchronization
{
    internal static class WireName
    {
        /// <summary>The wire name of a C# name, for a model type or a [Sync] member.</summary>
        // Invariant, not ToLower(): that turns 'I' into a dotless i on Turkish and Azerbaijani systems,
        // and the name would no longer match the one other clients use.
        internal static string Of(string name) => name.ToLowerInvariant();
    }
}
