// The members (clients or client ids) of each app. An app's entry exists only while it has a member, so
// has() and size tell the apps that are in use. No imports: the TCP worker thread loads this too.
export class AppIndex<T> {
    private readonly membersByApp = new Map<string, Set<T>>();

    // Number of apps that have at least one member.
    public get size(): number {
        return this.membersByApp.size;
    }

    // Adds a member to an app and returns how many members the app has now.
    public add(app: string, member: T): number {
        let members = this.membersByApp.get(app);
        if (!members) {
            members = new Set();
            this.membersByApp.set(app, members);
        }
        members.add(member);
        return members.size;
    }

    // Removes a member and returns how many are left, or undefined if the app has no entry.
    public remove(app: string, member: T): number | undefined {
        const members = this.membersByApp.get(app);
        if (!members) return undefined;

        members.delete(member);
        if (members.size === 0) {
            this.membersByApp.delete(app);
        }
        return members.size;
    }

    // In insertion order.
    public get(app: string): ReadonlySet<T> | undefined {
        return this.membersByApp.get(app);
    }

    public has(app: string): boolean {
        return this.membersByApp.has(app);
    }

    public clear(): void {
        this.membersByApp.clear();
    }

    // False if the app has no member, or if its only member is the one the message came from.
    public hasRecipients(app: string, except?: T): boolean {
        const members = this.membersByApp.get(app);
        if (!members || members.size === 0) return false;
        if (except !== undefined && members.size === 1 && members.has(except)) return false;
        return true;
    }
}
