import * as Bird from './Colibri';

/**
 * @deprecated use {@link Colibri `new Colibri(...)`} instead
 */
const init = (
    app: string,
    server: string = window?.location?.hostname ?? '',
    port: number = 9011,
    version: string = '1'
) => new Bird.Colibri(app, server, port, version);

/**
 * @deprecated use {@link Colibri `new Colibri(...)`} instead
 */
export const Colibri = {
    init,
};

/**
 * @deprecated import from {@link Colibri `Colibri`} directly
 */
export const SendMessage = Bird.SendMessage;

/**
 * @deprecated import from {@link Colibri `Colibri`} directly
 */
export const RegisterChannel = Bird.RegisterChannel;

/**
 * @deprecated import from {@link Colibri `Colibri`} directly
 */
export const UnregisterChannel = Bird.UnregisterChannel;

/**
 * @deprecated import from {@link Colibri `Colibri`} directly
 */
export const RegisterOnce = Bird.RegisterOnce;
