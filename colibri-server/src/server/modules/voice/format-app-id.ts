export const formatAppId = (appId: number): string => `0x${appId.toString(16).padStart(8, '0')}`;
