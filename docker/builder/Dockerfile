# One image per Node major, selected with --build-arg NODE_MAJOR (see docker-bake.hcl).
ARG NODE_MAJOR=22
FROM node:${NODE_MAJOR}-bookworm-slim

# Keep corepack's cached package managers outside /root so the `builder` user can use them.
ENV COREPACK_HOME=/opt/corepack

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/* \
 && corepack enable \
 && corepack prepare pnpm@12.5.1 --activate \
 && corepack prepare yarn@4.5.0 --activate \
 # pnpm 12 fetches its native binary on first run; do it now so it lands in the image.
 && pnpm --version \
 && chmod -R a+rX "$COREPACK_HOME" \
 # The node image already has uid 1000 (`node`); rename it rather than add a second user.
 && groupmod -n builder node \
 && usermod -l builder -d /home/builder -m -s /bin/sh node \
 && mkdir -p /app /cache && chown builder:builder /app /cache

USER builder
WORKDIR /app
ENV CI=true \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1
