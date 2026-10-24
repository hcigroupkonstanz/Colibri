import { hostPort, normalizeAddress } from '../net/addresses.js';

// A voice source as the log names it, and its key in VoiceServer's `clients`. An IPv4 sender is named
// by its IPv4 address, also on a dual-stack VOICE_HOST, where the socket reports it as
// ::ffff:<IPv4 address>. The packets to it still go to the address the socket reported (VoiceClient.ip).
export const voiceClientKey = (address: string, port: number): string => hostPort(normalizeAddress(address), port);
