// Warn once per channel: the same type may be registered again, e.g. on every render.
const warnedMinifiedNames = new Set<string>();

// Minifiers rename classes, typically to one or two letters or something with a '$', so a channel
// derived from the class name stops matching other builds and Unity.
export const warnIfMinified = (className: string, channel: string) => {
    if ((channel.length > 2 && !channel.includes('$')) || warnedMinifiedNames.has(channel)) return;
    warnedMinifiedNames.add(channel);
    console.warn(
        `Colibri: RegisterModelSync is syncing on channel '${channel}', derived from the class name ` +
            `'${className}', which looks minified. A minified build renames classes, so this will not ` +
            `sync with another build or with Unity. Pass the channel explicitly: ` +
            `RegisterModelSync({ name: '...', type: ${className || 'YourModel'} }).`
    );
};
