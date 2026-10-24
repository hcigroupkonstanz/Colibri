/**
 * Sends the REST store's requests in the Colibri media type. `uriFor` calls `Colibri.getRestUri`, so
 * a subclass that overrides it still decides the URI.
 */
export class RestStore {
    // Accept of every REST request, and Content-Type of setRestObject. colibri-server 2.x refuses a
    // value sent as plain application/json. The version in it lets a reverse proxy route by Accept.
    private readonly mediaType: string;

    public constructor(
        private readonly uriFor: (key: string) => string | null,
        protocolVersion: string
    ) {
        this.mediaType = `application/vnd.colibri.v${protocolVersion}+json`;
    }

    public async getRestObject(key: string): Promise<unknown> {
        const uri = this.uriFor(key);
        if (!uri) return null;

        const response = await fetch(uri, {
            method: 'GET',
            headers: {
                Accept: this.mediaType
            }
        });

        if (response.status >= 400) return null;
        else return response.json();
    }

    public async setRestObject(key: string, data: unknown): Promise<boolean> {
        const uri = this.uriFor(key);
        if (!uri) return false;

        const response = await fetch(uri, {
            method: 'PUT',
            headers: {
                Accept: this.mediaType,
                'Content-Type': this.mediaType
            },
            body: JSON.stringify(data)
        });

        return response.status >= 200 && response.status < 300;
    }

    public async deleteRestObject(key: string): Promise<boolean> {
        const uri = this.uriFor(key);
        if (!uri) return false;

        const response = await fetch(uri, {
            method: 'DELETE',
            headers: {
                Accept: this.mediaType
            }
        });

        return response.status >= 200 && response.status < 300;
    }
}
