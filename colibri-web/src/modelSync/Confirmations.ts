export interface Confirmation {
    sent: Map<string, string>; // JSON of the fields sent that differ from what the server showed
    replaced: Map<string, string | undefined>; // the server's JSON for those fields, if it had one
    props: string[]; // property names of the held changes
    shown: Map<string, unknown>; // latest value an update has shown for each sent field
    end: string; // askForEnd id
}

export class Confirmations {
    // Own models asked for again after their held changes or lost fields replaced server values
    // (OwnModelAnswers.sendOnTop), until the answers to that are over (OwnModelAnswers.endWait).
    private readonly confirming = new Map<string, Confirmation>();

    public start(id: string, confirmation: Confirmation): void {
        this.confirming.set(id, confirmation);
    }

    public has(id: string): boolean {
        return this.confirming.has(id);
    }

    public recordShown(id: string, modelData: object): void {
        const confirmation = this.confirming.get(id);
        if (!confirmation) return;
        for (const key of confirmation.sent.keys()) {
            if (key in modelData) confirmation.shown.set(key, (modelData as Record<string, unknown>)[key]);
        }
    }

    public sentKeys(id: string): Iterable<string> {
        return this.confirming.get(id)?.sent.keys() ?? [];
    }

    public end(id: string): Confirmation | undefined {
        const confirmation = this.confirming.get(id);
        this.confirming.delete(id);
        return confirmation;
    }

    public idEndedBy(end: string): string | undefined {
        return [...this.confirming].find(([, confirmation]) => confirmation.end === end)?.[0];
    }

    public ids(): string[] {
        return [...this.confirming.keys()];
    }
}

export const compareWithShown = (
    sent: Record<string, unknown>,
    shown: Record<string, unknown>
): Pick<Confirmation, 'sent' | 'replaced'> | undefined => {
    const differs = new Map<string, string>();
    for (const [key, value] of Object.entries(sent)) {
        const json = JSON.stringify(value) as string | undefined;
        // An undefined field is not sent, so no update shows it.
        if (key === 'id' || json === undefined) continue;
        if (!(key in shown) || JSON.stringify(shown[key]) !== json) differs.set(key, json);
    }
    if (differs.size === 0) return undefined;
    const replaced = new Map<string, string | undefined>();
    for (const key of differs.keys()) {
        replaced.set(key, key in shown ? JSON.stringify(shown[key]) : undefined);
    }
    return { sent: differs, replaced };
};

// `theirs` is the id and the fields another client set meanwhile, with their values, to apply here;
// `again` the fields to send again, as they did not arrive or were set back.
export const judgeConfirmation = (
    id: string,
    confirmation: Confirmation
): { theirs: Record<string, unknown>; again: string[] } => {
    const theirs: Record<string, unknown> = { id };
    const again: string[] = [];
    for (const [key, json] of confirmation.sent) {
        const shown = confirmation.shown.has(key)
            ? (JSON.stringify(confirmation.shown.get(key)) as string | undefined)
            : undefined;
        if (shown === json) continue;
        if (shown === undefined || shown === confirmation.replaced.get(key)) again.push(key);
        else theirs[key] = confirmation.shown.get(key);
    }
    return { theirs, again };
};
