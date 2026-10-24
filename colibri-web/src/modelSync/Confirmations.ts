interface Confirmation {
    sent: Map<string, string>; // JSON of the fields sent that differ from what the server showed
    replaced: Map<string, string | undefined>; // the server's JSON for those fields, if it had one
    props: string[]; // property names of the held changes
    shown: Map<string, unknown>; // latest value an update has shown for each sent field
    end: string; // askForEnd id
}

export class Confirmations {
    // Own models asked for again after sending their held changes (see sendOnTop), until the answers
    // to that are over (see endWait).
    private readonly confirming = new Map<string, Confirmation>();

    public start(id: string, confirmation: Confirmation): void {
        this.confirming.set(id, confirmation);
    }

    public get(id: string): Confirmation | undefined {
        return this.confirming.get(id);
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
