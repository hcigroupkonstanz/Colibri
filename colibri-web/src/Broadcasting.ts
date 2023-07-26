import { SendMessage } from './Networking';


export const sendNumber = (channel: string, num: number) => {
    SendMessage(channel, 'broadcast::int', num);
};
