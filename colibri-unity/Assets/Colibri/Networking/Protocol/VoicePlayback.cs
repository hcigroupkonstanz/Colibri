using System;

namespace HCIKonstanz.Colibri.Networking.Protocol
{
    /// <summary>
    /// Whose voice a VoiceReceiver plays, if anyone's, and the buffer it plays from.
    /// <see cref="Start"/> and <see cref="Stop"/> are for the main thread, <see cref="Read"/> for
    /// the audio thread.
    ///
    /// StartPlayback said it was playing before it had a buffer, so the audio thread could find
    /// none, and it added a listener every time: started twice for the same voice id, it played
    /// each packet twice. Here the buffer is emptied before playback starts, a second start for
    /// the same id changes nothing, a start for another id replaces the first, and the listener is
    /// added and removed once each.
    ///
    /// Free of any <c>UnityEngine</c> dependency, so plain NUnit EditMode tests exercise it.
    /// </summary>
    internal sealed class VoicePlayback
    {
        private readonly Action<short> addListener;
        private readonly Action<short> removeListener;

        // Written on the main thread, read on the audio thread too.
        private volatile bool isPlaying;

        private short id;

        /// <param name="addListener">Has the voice of an id delivered to the buffer from now on.</param>
        /// <param name="removeListener">Has it no longer delivered.</param>
        internal VoicePlayback(VoicePlaybackBuffer buffer, Action<short> addListener, Action<short> removeListener)
        {
            Buffer = buffer ?? throw new ArgumentNullException(nameof(buffer));
            this.addListener = addListener ?? throw new ArgumentNullException(nameof(addListener));
            this.removeListener = removeListener ?? throw new ArgumentNullException(nameof(removeListener));
        }

        internal VoicePlaybackBuffer Buffer { get; }

        internal bool IsPlaying => isPlaying;

        /// <summary>The voice id played, or last played.</summary>
        internal short Id => id;

        /// <summary>
        /// Main thread: plays the voice of <paramref name="voiceId"/>, instead of any other. False
        /// if it is playing that already, which changes nothing.
        /// </summary>
        internal bool Start(short voiceId)
        {
            if (isPlaying && voiceId == id)
                return false;

            if (isPlaying)
            {
                isPlaying = false;
                removeListener(id);
            }

            // What is left of the last playback is not this one's.
            Buffer.Clear();
            id = voiceId;
            addListener(voiceId);
            isPlaying = true;
            return true;
        }

        /// <summary>Main thread: stops playing. False if it was not playing.</summary>
        internal bool Stop()
        {
            if (!isPlaying)
                return false;

            isPlaying = false;
            removeListener(id);
            return true;
        }

        /// <summary>
        /// Audio thread: fills <paramref name="data"/> as <see cref="VoicePlaybackBuffer.Read"/>
        /// does, or with silence while nothing plays. Returns the samples read.
        /// </summary>
        internal int Read(float[] data, int channels, int fastForwardAbove = int.MaxValue, int keep = 0)
        {
            if (!isPlaying)
            {
                Array.Clear(data, 0, data.Length);
                return 0;
            }
            return Buffer.Read(data, channels, fastForwardAbove, keep);
        }
    }
}
