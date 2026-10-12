using System.Runtime.CompilerServices;

// The sync loop's hot path is deliberately internal - SyncTicker's registration list and the
// ITickable seam are implementation detail, not API. Testing them through reflection works but
// breaks silently on a rename, and the one bug that most needs a regression test (a ticker
// surviving Play mode and then double-ticking every registered object) lives entirely in there.
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.Tests")]
[assembly: InternalsVisibleTo("HCIKonstanz.Colibri.E2E")]
