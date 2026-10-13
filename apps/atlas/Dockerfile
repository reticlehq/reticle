# Atlas public demo. Build from the REPO ROOT (the app depends on workspace packages):
#   docker build -f apps/atlas/Dockerfile -t atlas-demo .
#   docker run -p 8080:8080 atlas-demo
# apps/atlas/Dockerfile.dockerignore trims the context (BuildKit picks it up for this -f path).

FROM node:24-slim AS build
RUN corepack enable
WORKDIR /repo
COPY . .
# The Vite plugin bakes the bridge pairing token into the bundle at build time. A visitor's daemon
# only accepts a page carrying ITS token, so the demo bakes a known, PUBLIC one; the visitor starts
# their daemon with RETICLE_TOKEN set to the same value. Not a secret — never reuse a real token here.
ARG ATLAS_DEMO_TOKEN=atlas-public-demo
ENV RETICLE_PAIRING_TOKEN_DIR=/tmp/reticle-demo
RUN mkdir -p "$RETICLE_PAIRING_TOKEN_DIR" && printf '%s' "$ATLAS_DEMO_TOKEN" > "$RETICLE_PAIRING_TOKEN_DIR/pairing-token"
# `.` = the root workspace, whose devDependencies (typescript, tsc-alias) the package builds run.
RUN pnpm install --frozen-lockfile --filter "@reticlehq/atlas..." --filter . \
 && pnpm --filter "@reticlehq/atlas^..." run build \
 && pnpm --filter @reticlehq/atlas run build:demo

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /repo/apps/atlas/dist ./dist
COPY --from=build /repo/apps/atlas/server/mock-api.ts /repo/apps/atlas/server/serve.ts ./server/
USER node
EXPOSE 8080
# Node 24 strips TypeScript types natively; no loader, no node_modules at runtime.
CMD ["node", "server/serve.ts"]
