using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    /// <summary>
    /// One synchronized object of load. The stress harness spawns as many of these as you ask it
    /// for and moves some fraction of them every frame; Colibri's sync ticker then sends each
    /// object's changes, at most <c>SyncSettings.MaxSendRate</c> messages a second per object,
    /// which is how a real scene generates traffic.
    /// </summary>
    /// <remarks>
    /// The harness owns this type on purpose. Driving the load through <c>SyncTransform</c> would
    /// exercise the same code path, but nothing outside it could see how many updates actually
    /// arrived - the numbers would be inferred from the object count rather than measured.
    /// </remarks>
    public class StressModel : SyncBehaviour<StressModel>
    {
        /// <summary>
        /// Inbound model messages seen by every <see cref="StressModel"/> in this client.
        /// </summary>
        /// <remarks>
        /// Counted in the <see cref="Seq"/> setter and nowhere else. One message carries every
        /// attribute that changed, so counting in each setter would treble the figure - and Seq is
        /// the one attribute the driver changes on every single update, by construction, so
        /// counting there is exactly one count per message.
        /// </remarks>
        public static long Received;

        /// <summary>
        /// Updates that were superseded before they were sent, measured from gaps in the sequence.
        /// </summary>
        /// <remarks>
        /// Deliberately not called "lost". State synchronization is last-write-wins and coalesces:
        /// if the sender changes a value three times between two sends - a frame apart, or one
        /// interval of the send-rate limit - two of those values never go on the wire, and that is
        /// the design working. A dropped *message* is a different thing, and the harness's probe
        /// channel is what measures that.
        /// </remarks>
        public static long Coalesced;

        private int _seq;
        private string _padding = "";

        [Sync]
        public Vector3 Position
        {
            get { return transform.localPosition; }
            set { transform.localPosition = value; }
        }

        [Sync]
        public int Seq
        {
            get { return _seq; }
            set
            {
                Received++;

                // _seq == 0 is this object's first update, which has nothing to be a gap from.
                if (_seq != 0 && value > _seq + 1)
                    Coalesced += value - _seq - 1;

                _seq = value;
            }
        }

        /// <summary>Ballast, so the payload size can be turned up without changing anything else.</summary>
        [Sync]
        public string Padding
        {
            get { return _padding; }
            set { _padding = value; }
        }

        /// <summary>
        /// Moves this object on the driving client. Writes the backing state rather than going
        /// through the properties above, so a locally driven change is never counted as a received
        /// one, and always bumps the sequence, so every call is a change: the harness counts the
        /// calls as changes made, and the receiving side counts the gaps in the sequence as
        /// changes coalesced. An unchanged value produces no message at all.
        /// </summary>
        public void Drive(Vector3 position, string padding)
        {
            transform.localPosition = position;
            _padding = padding;
            _seq++;
        }

        public static void ResetCounters()
        {
            Received = 0;
            Coalesced = 0;
        }
    }
}
