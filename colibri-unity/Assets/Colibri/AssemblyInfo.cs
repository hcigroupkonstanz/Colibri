using System.Runtime.CompilerServices;

// The sync loop's hot path (SyncTicker's registration list, ITickable seam) is internal: not API.
// Tests see it through InternalsVisibleTo, since reflection works but breaks silently on a rename.
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.Tests")]
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.E2E")]
