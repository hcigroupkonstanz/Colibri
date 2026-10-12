# ---- Builder: full devDependencies, Angular toolchain, TypeScript sources ----
FROM node:24-alpine AS builder

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
# The commit the admin UI shows. The build context has no .git (see .dockerignore), so it comes in
# as a build argument: `npm run publish` passes it, and so can any build:
# docker build --build-arg COLIBRI_COMMIT=$(git rev-parse HEAD) .
# Without it, the server reports its commit as unknown.
ARG COLIBRI_COMMIT
ARG COLIBRI_COMMIT_DIRTY
RUN npm run build

# ---- Runtime: production dependencies and build output only ----
FROM node:24-alpine AS runtime

# Express (and finalhandler under it) then answers an error with its status text instead of the
# stack trace, paths under /srv/colibri/node_modules included. Runtime stage only: the builder's
# npm ci needs the devDependencies this would leave out.
ENV NODE_ENV=production

# su-exec is how the entrypoint drops from root to the node user once the data directory is
# node's; see docker-entrypoint.sh.
RUN apk add --no-cache su-exec

WORKDIR /srv/colibri/

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY --from=builder /srv/colibri/dist ./dist

# The sed undoes a Windows checkout's CRLF line endings, which would otherwise leave the
# container unable to start ("no such file or directory" for /bin/sh\r).
COPY docker-entrypoint.sh /usr/local/bin/colibri-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/colibri-entrypoint.sh && chmod 755 /usr/local/bin/colibri-entrypoint.sh

# The data directory is the only place the server writes, so it is the only thing the node user
# owns. Everything else, the server's own code included, stays root's and read-only to it. A
# chown -R over /srv/colibri also copied node_modules and dist into a layer of their own (17 MB).
# A named volume mounted here starts out owned by node as well.
RUN mkdir data && chown node:node data

# Webserver
EXPOSE 9211
# TCP (Unity) Port
EXPOSE 9212
# Voice
EXPOSE 9213/udp

# Probes the web server where it actually listens: WEBSERVER_HOST and WEBSERVER_PORT (default
# 9211), from the environment or a .env in the working directory, as the server reads them -
# a wildcard host on loopback. A probe hard-coded to 127.0.0.1 and the default port left a
# container with any other WEBSERVER_PORT, or a host such as localhost (which Node binds to
# ::1), unhealthy for good, and an orchestrator restarting it over and over. /api/store rather
# than /, which is only the admin UI while BASE_URL is empty.
#
# Over HTTPS when TLS_CERT and TLS_KEY are set, since the server then serves nothing else, and
# without checking the certificate: one that is self-signed, or names the server's public address
# rather than this loopback one, is no reason to call the container unhealthy. (fetch cannot be
# told not to check it, hence http and https.)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e " \
        try { process.loadEnvFile(); } catch {} \
        const { WEBSERVER_HOST: h = '', WEBSERVER_PORT: port = '', TLS_CERT: cert = '', TLS_KEY: key = '' } = process.env; \
        const host = h === '' || h === '0.0.0.0' || h === '::' ? '127.0.0.1' : h; \
        const tls = cert.trim() !== '' && key.trim() !== ''; \
        require(tls ? 'https' : 'http') \
            .get({ host, port: port || '9211', path: '/api/store', rejectUnauthorized: false }, \
                r => process.exit(r.statusCode >= 200 && r.statusCode < 300 ? 0 : 1)) \
            .on('error', () => process.exit(1))"

# Starts as root only long enough to give /srv/colibri/data to the node user, then runs the
# server as node. node itself, not npm, so the server is PID 1 and receives docker stop's SIGTERM.
ENTRYPOINT [ "colibri-entrypoint.sh" ]
CMD [ "node", "--enable-source-maps", "dist/server/main.js" ]
