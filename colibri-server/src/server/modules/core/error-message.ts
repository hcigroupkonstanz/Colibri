// No imports: the TCP worker thread loads this module too.

/** The message of an Error, or the string form of anything else that was thrown. */
export const errorMessage = function (error: unknown): string {
    return error instanceof Error ? error.message : String(error);
};
