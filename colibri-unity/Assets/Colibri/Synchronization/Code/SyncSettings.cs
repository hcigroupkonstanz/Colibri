using System;
using HCIKonstanz.Colibri.Setup;
using UnityEngine;

namespace HCIKonstanz.Colibri.Synchronization
{
    /// <summary>
    /// How the synchronization layer behaves, changeable from code while the app runs.
    /// </summary>
    public static class SyncSettings
    {
        private static int? _maxSendRate;
        private static bool _hasWarnedAboutConfiguredRate;

        /// <summary>
        /// The most updates per second one synced object - a <c>SyncTransform</c> or any other
        /// <see cref="SyncBehaviour{T}"/> - sends. 0 means no limit: an update in every frame in
        /// which something changed.
        /// </summary>
        /// <remarks>
        /// <para>
        /// The limit loses nothing. The first change after a quiet spell goes out in the frame it is
        /// made, as it always did. Changes within one interval (1 / MaxSendRate seconds) after that
        /// are collected, and their latest values go out together as soon as the interval is up -
        /// whether or not anything changes after them. Only the values in between never travel.
        /// Switching an object off or on is never held back, and neither is what is waiting when
        /// the app pauses or loses focus - the way out on Android and Quest. When the app quits,
        /// what is waiting is sent too, but the connection closes in the same teardown, so that
        /// last send is best effort.
        /// </para>
        /// <para>
        /// Why there is a limit: a headset renders 72 to 120 frames per second, and without one every
        /// moving object sends that many messages. Dozens of headsets, each moving a few objects,
        /// produce more traffic than one server and one Wi-Fi network can keep up with.
        /// </para>
        /// <para>
        /// Starts out as <see cref="ColibriConfig.MaxSendRate"/> (Window -> Colibri Configuration).
        /// Setting it here applies to this run of the app only and leaves the configuration alone.
        /// A negative value in the configuration is a mistake rather than a rate: it is reported
        /// once and the default, <see cref="ColibriConfig.DEFAULT_MAX_SEND_RATE"/>, is used.
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
        /// The configuration's rate. A negative one used to be clamped to 0 - no limit at all, every
        /// moving object sending in every frame - without a word. The setup window refuses to save
        /// one, but the configuration asset's own Inspector and a hand edit let it through.
        /// </summary>
        private static int ConfiguredRate()
        {
            var configured = ColibriConfig.Load().MaxSendRate;
            if (configured >= 0)
                return configured;

            // Read every frame, so said once per run rather than every time.
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
        /// Back to the configuration's value. Statics survive Play mode when domain reload is
        /// disabled, and a rate set from code in one session must not carry into the next - nor
        /// must having reported a negative configured rate keep the next session quiet about it.
        /// </summary>
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        internal static void ResetMaxSendRate()
        {
            _maxSendRate = null;
            _hasWarnedAboutConfiguredRate = false;
        }
    }
}
