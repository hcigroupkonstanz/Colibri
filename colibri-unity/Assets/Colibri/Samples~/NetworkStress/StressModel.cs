using HCIKonstanz.Colibri.Synchronization;
using UnityEngine;

namespace HCIKonstanz.Colibri.Samples
{
    /// <summary>
    /// A synchronized object that the stress harness creates and moves to generate load.
    /// </summary>
    // With SyncSettings.MaxSendRate set, one message can carry several Drive calls.
    public class StressModel : SyncBehaviour<StressModel>
    {
        /// <summary>
        /// Model messages received by all <see cref="StressModel"/> objects in this client.
        /// </summary>
        // Counted in the Seq setter only. Drive changes Seq on every call, so every message carries
        // it. Counting in every setter would count one message up to three times.
        public static long Received;

        /// <summary>
        /// Updates superseded before they were sent, counted from gaps in the sequence.
        /// </summary>
        // State sync coalesces, so a gap is usually values that never went on the wire. A lost
        // message also shows as a gap.
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

                // No gap is counted before the first update, while _seq is still 0.
                if (_seq != 0 && value > _seq + 1)
                    Coalesced += value - _seq - 1;

                _seq = value;
            }
        }

        /// <summary>Filler string that makes each update's payload larger.</summary>
        [Sync]
        public string Padding
        {
            get { return _padding; }
            set { _padding = value; }
        }

        /// <summary>
        /// Moves this object on the driving client; each call is a change because it always advances
        /// the sequence.
        /// </summary>
        // Writes the backing state directly, so the setters above do not count the move as received.
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
