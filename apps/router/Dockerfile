# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/router/package.json apps/router/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# Cache mount: the pnpm store persists across image builds on the same host / CI runner,
# so a lockfile change re-downloads only the packages that changed.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# `prisma generate` first: the client is written into the source tree at
# packages/db/generated/prisma, which is gitignored and so absent from the context.
RUN pnpm --filter @shipyard/db generate && pnpm --filter @shipyard/router build
# Prune to a self-contained production tree: only @shipyard/router's `files`
# (dist/) plus its `dependencies`. Dev tooling and the workspace packages
# (already inlined into the bundle) are excluded.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @shipyard/router --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Documents the port for `docker run -P`, Compose and image inspectors.
# Must match the PORT this service is given; it publishes nothing by itself.
EXPOSE 4001
CMD ["node", "dist/server.js"]
