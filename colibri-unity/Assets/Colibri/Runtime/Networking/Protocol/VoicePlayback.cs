using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Whose voice a VoiceReceiver plays, if anyone's, and the buffer it plays from.
    /// <see cref="Start"/> and <see cref="Stop"/> are for the main thread, <see cref="Read"/> for
    /// the audio thread. No <c>UnityEngine</c> dependency, so EditMode tests use it directly.
    /// </summary>
    internal sealed class VoicePlayback
    {
        private readonly Action<short> _addListener;
        private readonly Action<short> _removeListener;

        // Written on the main thread, read on the audio thread too.
        private volatile bool _isPlaying;

        private short _id;

        /// <param name="addListener">Starts delivering the voice of an id to the buffer.</param>
        /// <param name="removeListener">Stops that delivery.</param>
        internal VoicePlayback(VoicePlaybackBuffer buffer, Action<short> addListener, Action<short> removeListener)
        {
            Buffer = buffer ?? throw new ArgumentNullException(nameof(buffer));
            _addListener = addListener ?? throw new ArgumentNullException(nameof(addListener));
            _removeListener = removeListener ?? throw new ArgumentNullException(nameof(removeListener));
        }

        internal VoicePlaybackBuffer Buffer { get; }

        internal bool IsPlaying => _isPlaying;

        /// <summary>The voice id played, or last played.</summary>
        internal short Id => _id;

        /// <summary>
        /// Main thread: plays the voice of <paramref name="voiceId"/>, replacing any other. False,
        /// and nothing changes, if it plays that id already.
        /// </summary>
        internal bool Start(short voiceId)
        {
            // A second listener for the same id would deliver every packet twice.
            if (_isPlaying && voiceId == _id)
                return false;

            if (_isPlaying)
            {
                _isPlaying = false;
                _removeListener(_id);
            }

            // Drop what is left of the previous playback. _isPlaying goes true only after this,
            // so the audio thread never reads those samples.
            Buffer.Clear();
            _id = voiceId;
            _addListener(voiceId);
            _isPlaying = true;
            return true;
        }

        /// <summary>Main thread: stops playing. False if it was not playing.</summary>
        internal bool Stop()
        {
            if (!_isPlaying)
                return false;

            _isPlaying = false;
            _removeListener(_id);
            return true;
        }

        /// <summary>
        /// Audio thread: fills <paramref name="data"/> as <see cref="VoicePlaybackBuffer.Read"/>
        /// does, or with silence while nothing plays. Returns the samples read.
        /// </summary>
        internal int Read(float[] data, int channels, int fastForwardAbove = int.MaxValue, int keep = 0)
        {
            if (!_isPlaying)
            {
                Array.Clear(data, 0, data.Length);
                return 0;
            }
            return Buffer.Read(data, channels, fastForwardAbove, keep);
        }
    }
}
