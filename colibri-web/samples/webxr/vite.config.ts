import { fileURLToPath } from 'node:url';
import basicSsl from '@vitejs/plugin-basic-ssl';
import { defineConfig } from 'vite';

// Served over https:// with a self-signed certificate: a headset's browser offers WebXR only on a
// secure page, and http:// is secure on localhost alone. Reachable from the network, so a headset
// can open it.
//
// @hcikn/colibri comes from dist, the build npm publishes (`npm run samples/webxr` builds it first),
// not from src as in the Node samples: no browser runs the decorators of src yet, and Vite passes
// them through.
export default defineConfig({
    root: fileURLToPath(new URL('.', import.meta.url)),
    plugins: [basicSsl()],
    resolve: {
        alias: {
            '@hcikn/colibri': fileURLToPath(new URL('../../dist/index.js', import.meta.url))
        }
    },
    server: {
        host: true
    }
});
