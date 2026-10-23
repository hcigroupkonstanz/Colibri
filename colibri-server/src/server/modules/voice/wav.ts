import { endianness } from 'os';

// Recordings can run for minutes at 48kHz, so a plain number[] would mean millions of
// boxed-double pushes. This keeps samples in a flat Int16Array, growing (doubling) only
// when the current capacity is exhausted, same trade-off as FrameReader's growable buffer.
export class GrowableInt16Buffer {
    private data: Int16Array;
    private len = 0;

    public constructor(initialCapacity = 48000) {
        this.data = new Int16Array(initialCapacity);
    }

    public get length(): number {
        return this.len;
    }

    public push(value: number): void {
        if (this.len >= this.data.length) {
            const grown = new Int16Array(this.data.length * 2);
            grown.set(this.data);
            this.data = grown;
        }
        this.data[this.len++] = value;
    }

    public toTypedArray(): Int16Array {
        return this.data.subarray(0, this.len);
    }
}

const WAV_HEADER_LENGTH = 44;

/**
 * The 44-byte RIFF header of a mono, 16-bit PCM .wav file holding `dataBytes` bytes of samples.
 *
 * Written by hand because it is all a recording needs: building the file with wavefile
 * (fromScratch, then toBuffer) re-encoded every sample on the main thread, which held up all
 * TCP and Socket.IO relaying for seconds when a long recording was saved.
 */
export const wavHeader = function (samplingRate: number, dataBytes: number): Buffer {
    // The sizes are 32-bit. Past 4 GiB (12 h at 48 kHz) they say "as much as there is", which
    // players read to the end of the file, instead of failing the save and losing it all.
    const size = (value: number) => Math.min(value, 0xFFFFFFFF);
    const header = Buffer.alloc(WAV_HEADER_LENGTH);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(size(WAV_HEADER_LENGTH - 8 + dataBytes), 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16); // fmt chunk size
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(samplingRate, 24);
    header.writeUInt32LE(samplingRate * 2, 28); // bytes per second
    header.writeUInt16LE(2, 32); // bytes per sample frame
    header.writeUInt16LE(16, 34); // bits per sample
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(size(dataBytes), 40);
    return header;
};

/** The samples as the little-endian bytes a .wav file holds, without copying them where it can. */
export const littleEndianBytes = function (samples: Int16Array): Buffer {
    const bytes = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
    return endianness() === 'LE' ? bytes : Buffer.from(bytes).swap16();
};
