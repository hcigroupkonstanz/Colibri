// No imports: the TCP worker thread loads this module too.

/** A Buffer over the same bytes as `value`, without a copy. */
export const toBuffer = function (value: Buffer | Uint8Array): Buffer {
    if (Buffer.isBuffer(value)) return value;
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
};
