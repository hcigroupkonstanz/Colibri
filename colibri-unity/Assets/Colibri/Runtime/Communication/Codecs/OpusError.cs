using System;

namespace HCIKonstanz.Colibri.Communication.Codecs
{
    /// <summary>Result codes of libopus calls: OK, or a negative error code.</summary>
    [Obsolete("Becomes internal in Colibri 3.0, as only Colibri's voice components use it.")]
    public enum OpusError
    {
        OK = 0,
        BAD_ARG = -1,
        BUFFER_TOO_SMALL = -2,
        INTERNAL_ERROR = -3,
        INVALID_PACKET = -4,
        UNIMPLEMENTED = -5,
        INVALID_STATE = -6,
        ALLOC_FAIL = -7
    }
}
