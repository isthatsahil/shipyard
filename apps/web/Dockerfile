# syntax=docker/dockerfile:1
# Context is the repo root: the lockfile lives there, not in apps/web.
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

# Local development (docker/compose.yaml uses `target: dev`). Compose
# bind-mounts apps/web/src and packages/shared/src over the copies below, so
# host edits hot-reload.
FROM deps AS dev
# packages/shared/tsconfig.json extends it; Vite reads it when transforming shared code.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
WORKDIR /repo/apps/web
EXPOSE 5173
CMD ["pnpm", "dev"]

FROM deps AS build
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web
RUN pnpm --filter @shipyard/web build

# Production (default target): the dashboard is plain static files, so nginx
# serves them and no Node process runs at all.
FROM nginx:alpine AS runtime
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 80
