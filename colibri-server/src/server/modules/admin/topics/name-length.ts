// Longest app, channel, model id or client name a snapshot carries. A longer one is cut and its row
// flagged truncated; this bounds what an odd client can make a snapshot carry.
export const MAX_NAME_LENGTH = 512;

export const clip = function (text: string): string {
    return text.length > MAX_NAME_LENGTH ? text.slice(0, MAX_NAME_LENGTH) : text;
};

const isLong = function (text: string): boolean {
    return text.length > MAX_NAME_LENGTH;
};

export const truncatedFlag = function (...names: string[]): { truncated?: true } {
    return names.some(isLong) ? { truncated: true } : {};
};
