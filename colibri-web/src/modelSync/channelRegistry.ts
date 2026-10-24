// Per channel, each registration's check for an own model with a given id. Every registration on a
// channel receives the answers to the others' requests, and a bare id may be one of those.
const ownOnChannel = new Map<string, Set<(id: string) => boolean>>();

// Per channel, each registration's guard (see guardFrom): all of them receive the answers to the
// others' requests.
const guardsOnChannel = new Map<string, Set<(end: string) => void>>();

export const joinChannel = (name: string, hasOwn: (id: string) => boolean, guard: (end: string) => void) => {
    const onChannel = ownOnChannel.get(name);
    if (onChannel) onChannel.add(hasOwn);
    else ownOnChannel.set(name, new Set([hasOwn]));

    const guards = guardsOnChannel.get(name);
    if (guards) guards.add(guard);
    else guardsOnChannel.set(name, new Set([guard]));
};

export const ownedElsewhere = (name: string, self: (id: string) => boolean, id: string) =>
    [...(ownOnChannel.get(name) ?? [])].some(has => has !== self && has(id));

export const guardChannel = (name: string, end: string) => {
    for (const guardOnChannel of guardsOnChannel.get(name) ?? []) guardOnChannel(end);
};
