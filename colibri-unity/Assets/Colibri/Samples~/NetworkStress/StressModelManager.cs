using HCIKonstanz.Colibri.Synchronization;

namespace HCIKonstanz.Colibri.Samples
{
    /// <summary>
    /// Builds a local <see cref="StressModel"/> from <c>Template</c> for each one another client
    /// creates. Without this component in the scene, remote objects do not appear.
    /// </summary>
    public class StressModelManager : SyncBehaviourManager<StressModel>
    {
    }
}
