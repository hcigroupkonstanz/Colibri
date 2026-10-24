// An app id as the voice server's log and recording names show it: 0x and 8 hex digits.
export const formatAppId = (appId: number): string => `0x${appId.toString(16).padStart(8, '0')}`;
