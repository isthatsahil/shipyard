# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/worker/package.json apps/worker/
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
RUN pnpm --filter @shipyard/db generate && pnpm --filter @shipyard/worker build
# Prune to a self-contained production tree: only @shipyard/worker's `files`
# (dist/) plus its `dependencies`. Dev tooling and the workspace packages
# (already inlined into the bundle) are excluded.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @shipyard/worker --prod /out

FROM base AS runtime
# `git` is a RUNTIME dependency here, not a build one: simple-git shells out to
# the git binary to clone and checkout user repositories. ca-certificates gives
# it the TLS roots for https:// remotes.
# The Docker CLI is deliberately NOT installed — dockerode speaks the Engine API
# over /var/run/docker.sock directly.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# No EXPOSE: the worker serves no HTTP. It pulls jobs from Redis and talks
# outbound to Postgres, S3 and the Docker socket.
CMD ["node", "dist/index.js"]
