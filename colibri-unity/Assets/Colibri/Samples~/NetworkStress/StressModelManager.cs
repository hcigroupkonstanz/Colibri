using HCIKonstanz.Colibri.Synchronization;

namespace HCIKonstanz.Colibri.Samples
{
    /// <summary>
    /// Instantiates a <see cref="StressModel"/> locally for every one another client creates.
    /// Without it in the scene, a client would send its own objects perfectly well and show
    /// nothing at all for the other side's - which under load reads as total message loss.
    /// </summary>
    public class StressModelManager : SyncBehaviourManager<StressModel>
    {
    }
}
