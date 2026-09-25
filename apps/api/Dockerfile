# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
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
RUN pnpm --filter @shipyard/db generate && pnpm --filter @shipyard/api build
# Prune to a self-contained production tree: only @shipyard/api's `files`
# (dist/) plus its `dependencies`, with workspace links resolved to real
# directories. Dev tooling (tsup, tsx, vitest, typescript, prisma) is excluded.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @shipyard/api --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Documents the port for `docker run -P`, Compose and image inspectors.
# Must match the PORT this service is given; it publishes nothing by itself.
EXPOSE 4000
CMD ["node", "dist/server.js"]
