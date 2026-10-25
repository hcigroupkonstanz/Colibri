using System;

namespace HCIKonstanz.Colibri.Communication.Codecs
{
    /// <summary>The mode an Opus encoder is tuned for: voice, general audio or lowest delay.</summary>
    [Obsolete("Becomes internal in Colibri 3.0, as only Colibri's voice components use it.")]
    public enum OpusApplication
    {
        VOIP = 2048,
        AUDIO = 2049,
        RESTRICTED_LOWDELAY = 2051
    }
}
