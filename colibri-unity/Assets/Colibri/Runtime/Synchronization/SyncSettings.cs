using System;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// Settings of the synchronization layer that code can change while the app runs.
    /// </summary>
    public static class SyncSettings
    {
        private static int? _maxSendRate;
        private static bool _hasWarnedAboutConfiguredRate;

        /// <summary>
        /// The most updates per second that one synced object sends, a <c>SyncTransform</c> or any
        /// other <see cref="SyncBehaviour{T}"/>. 0 means no limit: an update in every frame in which
        /// something changed.
        /// </summary>
        /// <remarks>
        /// <para>
        /// The limit keeps the latest state. A change after a quiet spell is sent in the frame it is
        /// made. Later changes within one interval (1 / MaxSendRate seconds) are merged, and their
        /// latest values go out when the interval is up, even if the object does not change again.
        /// Intermediate values are not sent.
        /// </para>
        /// <para>
        /// Switching an object on or off is not delayed. Waiting changes are sent at once when the app
        /// pauses or loses focus. On Android and Quest that can be the last chance, as quit may never
        /// be called there. On quit they are sent too, but that send is best effort: the connection
        /// closes in the same teardown.
        /// </para>
        /// <para>
        /// Starts out as <see cref="ColibriConfig.MaxSendRate"/> (Window -> Colibri Configuration).
        /// Setting it here applies to this run of the app only and leaves the configuration alone.
        /// A negative configured value is reported once, and <see cref="ColibriConfig.DEFAULT_MAX_SEND_RATE"/>
        /// is used instead.
        /// </para>
        /// </remarks>
        /// <exception cref="ArgumentOutOfRangeException">On a negative value.</exception>
        public static int MaxSendRate
        {
            get => _maxSendRate ?? ConfiguredRate();
            set
            {
                if (value < 0)
                    throw new ArgumentOutOfRangeException(nameof(value), value,
                        "MaxSendRate is in updates per second and cannot be negative. 0 turns the limit off.");

                _maxSendRate = value;
            }
        }

        /// <summary>
        /// The configuration's rate, or the default when the configured one is negative. The setup
        /// window rejects a negative rate, but a hand edit of the asset does not.
        /// </summary>
        private static int ConfiguredRate()
        {
            var configured = ColibriConfig.Load().MaxSendRate;
            if (configured >= 0)
                return configured;

            // Called every frame through SendInterval, so warn once per run.
            if (!_hasWarnedAboutConfiguredRate)
            {
                _hasWarnedAboutConfiguredRate = true;
                Debug.LogWarning($"Colibri: Max Send Rate in the Colibri configuration is {configured}, which is not a rate. "
                    + $"Using the default, {ColibriConfig.DEFAULT_MAX_SEND_RATE} updates per second per synced object. "
                    + "Set it in Window -> Colibri Configuration: 0 turns the limit off.");
            }

            return ColibriConfig.DEFAULT_MAX_SEND_RATE;
        }

        /// <summary>Seconds between two updates of one object, or 0 without a limit.</summary>
        internal static double SendInterval
        {
            get
            {
                var rate = MaxSendRate;
                return rate > 0 ? 1.0 / rate : 0.0;
            }
        }

        /// <summary>
        /// Clears the rate set from code and the one-time warning flag at the start of each run.
        /// Statics survive Play mode when domain reload is disabled, so both would carry into the
        /// next run.
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        internal static void ResetMaxSendRate()
        {
            _maxSendRate = null;
            _hasWarnedAboutConfiguredRate = false;
        }
    }
}
