# Phase 5 — Production Serving

**Goal:** real domains with valid TLS, custom domains, a CDN in front, compressed assets, storage retention, and a deploy pipeline for the platform itself.
**Time:** ~1 week.
**Done when:** `https://<slug>.yourdomain.app` and a verified custom domain both serve with valid certs; assets come back `content-encoding: br` with a CDN `HIT` on the second request; old deployments disappear from storage on schedule.

Prerequisite: [Phase 4](phase-4-hardening.md).

---

## Step 1 — DNS and wildcard TLS

DNS records (Cloudflare shown; any provider with an API works for DNS-01):

| Type | Name | Value | Proxy |
|---|---|---|---|
| A | `api` | VM IP | off (SSE + webhooks are simpler un-proxied) |
| A | `app` | VM IP | on |
| A | `*` | VM IP | on (CDN for all deployed sites) |
| A | `cname` | VM IP | on — target for customers' CNAMEs |

Cloudflare API token with `Zone.DNS:Edit` for DNS-01 → `CF_API_TOKEN`.

`docker/Caddyfile.prod`

```caddyfile
{
  email ops@yourdomain.app
  on_demand_tls {
    ask http://api:4000/internal/domains/check
  }
}

api.yourdomain.app {
  reverse_proxy api:4000 {
    flush_interval -1          # stream SSE
  }
}

app.yourdomain.app {
  reverse_proxy web:80
}

*.yourdomain.app {
  tls {
    dns cloudflare {env.CF_API_TOKEN}
  }
  reverse_proxy router:4001
}

# Custom domains: any other hostname. Caddy asks the API before issuing a cert.
https:// {
  tls {
    on_demand
  }
  reverse_proxy router:4001
}
```

Use the `caddy-dns/cloudflare` build: `docker/caddy/Dockerfile`

```dockerfile
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare
FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
```

The `web` service in production serves the built dashboard with nginx (`apps/web/Dockerfile`: build stage → `nginx:alpine` with a `try_files $uri /index.html` rule).

### The `ask` endpoint (API)

Caddy calls this before issuing a certificate for an unknown hostname; without it, anyone could point a DNS record at your IP and burn your Let's Encrypt rate limit.

```ts
// apps/api/src/routes/internal.ts  — no auth; only reachable on the Docker network
internal.get("/domains/check", async (req, res) => {
  const host = String(req.query.domain ?? "").toLowerCase();
  const domain = await prisma.domain.findUnique({ where: { hostname: host }, select: { verified: true } });
  res.status(domain?.verified ? 200 : 404).end();
});
```

---

## Step 2 — Custom domains

### API — `apps/api/src/routes/domains.ts`

```ts
import { Router } from "express";
import { z } from "zod";
import dns from "node:dns/promises";
import { randomBytes } from "node:crypto";
import { prisma } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { validate } from "../middleware/validate.js";
import { redis, env } from "../lib/clients.js";
import { HttpError } from "../lib/httpError.js";

export const domains = Router();
const HOST_RE = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

domains.post("/projects/:id/domains", validate(z.object({ hostname: z.string().toLowerCase().regex(HOST_RE) })), async (req, res) => {
  const project = await ownedProject(req, req.params.id);
  const hostname = req.body.hostname;
  if (hostname.endsWith("." + env.BASE_DOMAIN)) throw new HttpError(400, "api.domain_is_subdomain");
  const domain = await prisma.domain.create({ data: { projectId: project.id, hostname, verificationToken: randomBytes(16).toString("hex") } });
  res.status(201).json({ ...d, instructions: {
    cname: { name: hostname, value: `cname.${env.BASE_DOMAIN}` },
    txt: { name: `_shipyard.${hostname}`, value: domain.verificationToken },
  }});
});

export async function verifyDomain(id: string) {
  const domain = await prisma.domain.findUniqueOrThrow({ where: { id } });
  let ok = false;
  try {
    const txt = (await dns.resolveTxt(`_shipyard.${domain.hostname}`)).flat();
    const cname = await dns.resolveCname(domain.hostname).catch(() => [] as string[]);
    // Apex domains can't CNAME; accept an A record pointing at us instead.
    const aRecords = cname.length ? [] : await dns.resolve4(domain.hostname).catch(() => [] as string[]);
    const pointsAtUs = cname.some(record => record.replace(/\.$/, "") === `cname.${env.BASE_DOMAIN}`) || aRecords.includes(env.PUBLIC_IP);
    ok = txt.includes(domain.verificationToken) && pointsAtUs;
  } catch {}
  const updated = await prisma.domain.update({
    where: { id }, data: ok ? { verified: true, failedChecks: 0 } : { failedChecks: { increment: 1 }, ...(domain.failedChecks + 1 >= 3 ? { verified: false } : {}) },
  });
  await redis.del(keys.routeHost(domain.hostname));
  return updated;
}

domains.post("/domains/:id/verify", async (req, res) => {
  const domain = await prisma.domain.findUnique({ where: { id: req.params.id }, include: { project: true } });
  if (!domain || domain.project.userId !== req.user!.id) throw new HttpError(404, "api.not_found");
  res.json(await verifyDomain(domain.id));
});

domains.delete("/domains/:id", async (req, res) => {
  const domain = await prisma.domain.findUnique({ where: { id: req.params.id }, include: { project: true } });
  if (!domain || domain.project.userId !== req.user!.id) throw new HttpError(404, "api.not_found");
  await prisma.domain.delete({ where: { id: domain.id } });
  await redis.del(keys.routeHost(domain.hostname));
  res.status(204).end();
});
```

Daily re-verification: a BullMQ repeatable job (`maintenance` queue, see Step 5) that calls `verifyDomain` for every domain. After three consecutive failures the domain is unverified and Caddy stops renewing its cert.

### Router — custom-host resolution

Extend `resolveHost` in `apps/router/src/resolve.ts`: when the hostname is not under `BASE_DOMAIN`,

```ts
const cached = await redis.get(keys.routeHost(hostname));
if (cached) return JSON.parse(cached);
const domain = await prisma.domain.findUnique({ where: { hostname, verified: true }, select: { project: { select: { activeDeploymentId: true, spaFallback: true } } } });
if (!domain?.project.activeDeploymentId) return null;
const target = { deploymentId: domain.project.activeDeploymentId, spaFallback: domain.project.spaFallback };
await redis.set(keys.routeHost(hostname), JSON.stringify(target), "EX", ROUTE_TTL_SECONDS);
return target;
```

On promote, also delete `route:host:*` for the project's domains (fetch them in the promote handler and in `promote.ts`).

---

## Step 3 — CDN

With Cloudflare proxying `*.yourdomain.app`:

- Cache rule: *Cache everything*, *Edge TTL: respect origin*, *Browser TTL: respect origin*. The router already emits `immutable` for hashed assets and `must-revalidate` for HTML, so HTML is revalidated on every request (cheap 304s) while assets stay cached for a year.
- Custom domains proxied through Cloudflare by the customer get the same treatment; un-proxied ones simply hit the router directly.

### Purge on promote — `packages/shared/src/cdn.ts`

```ts
export interface Cdn { purgeHosts(hosts: string[]): Promise<void> }

export const noopCdn: Cdn = { purgeHosts: async () => {} };

export function cloudflareCdn(zoneId: string, token: string): Cdn {
  return {
    async purgeHosts(hosts) {
      if (!hosts.length) return;
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ hosts }),
      });
      if (!response.ok) throw new Error(`cloudflare purge ${response.status}`);
    },
  };
}

export function cdnFromEnv(env: { CF_ZONE_ID?: string; CF_API_TOKEN?: string }) {
  return env.CF_ZONE_ID && env.CF_API_TOKEN ? cloudflareCdn(env.CF_ZONE_ID, env.CF_API_TOKEN) : noopCdn;
}
```

Call `cdn.purgeHosts([`${slug}.${BASE_DOMAIN}`, ...customHostnames])` after every promote (worker and API). Purge by host is available on all Cloudflare plans for your own zone; customers' zones are theirs to purge.

---

## Step 4 — Pre-compression

In `apps/worker/src/pipeline/upload.ts`, for each compressible file above 1 KB, upload two extra objects:

```ts
import { brotliCompressSync, gzipSync, constants } from "node:zlib";
import { COMPRESSIBLE } from "@shipyard/shared/contentType";

if (COMPRESSIBLE.test(rel) && size > 1024) {
  const buf = await fs.promises.readFile(abs);
  const brotli = brotliCompressSync(buf, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } });
  const gzipped = gzipSync(buf, { level: 9 });
  const common = { contentType: contentTypeFor(rel), cacheControl: cacheControlFor(rel) };
  await Promise.all([
    storage.put(`${prefix}${rel}.br`, brotli, { ...common, contentEncoding: "br", contentLength: brotli.length }),
    storage.put(`${prefix}${rel}.gz`, gzipped, { ...common, contentEncoding: "gzip", contentLength: gzipped.length }),
  ]);
}
```

In `apps/router/src/serve.ts`, inside `send()` before fetching the plain key (`store` is the injected `ObjectReader` from Phase 1):

```ts
const accept = req.headers["accept-encoding"] ?? "";
const variants = [/\bbr\b/.test(accept) && ".br", /\bgzip\b/.test(accept) && ".gz"].filter(Boolean) as string[];
for (const suffix of variants) {
  const obj = await store.get(key + suffix);
  if (obj) { res.setHeader("Vary", "Accept-Encoding"); /* write headers + pipe as before */ return true; }
}
```

The `.br`/`.gz` objects already carry `Content-Encoding` metadata, so the existing header-copying code handles them. Ensure `normalise()` in the router still rejects a *direct* request for `foo.js.br` if you don't want raw variants reachable — harmless either way.

---

## Step 5 — Retention / GC

A `maintenance` BullMQ queue with repeatable jobs, processed by the worker:

```ts
// apps/worker/src/maintenance.ts
import { Queue, Worker } from "bullmq";
import { prisma } from "@shipyard/db";
import { connectionFromUrl } from "@shipyard/shared/queue";
import { env, storage, log } from "./lib/clients.js";

const RETAIN_COUNT = Number(process.env.RETAIN_COUNT ?? 10);
const RETAIN_DAYS = Number(process.env.RETAIN_DAYS ?? 30);

export async function gcDeployments() {
  const projects = await prisma.project.findMany({ select: { id: true, activeDeploymentId: true } });
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86_400_000);
  for (const project of projects) {
    const rows = await prisma.deployment.findMany({
      where: { projectId: project.id, status: { in: ["ready", "failed", "cancelled"] } },
      orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, storagePrefix: true, status: true },
    });
    const victims = rows.filter((row, i) => row.id !== project.activeDeploymentId && (i >= RETAIN_COUNT || row.status !== "ready") && row.createdAt < cutoff);
    for (const victim of victims) {
      await storage.deletePrefix(victim.storagePrefix);
      await prisma.deployment.update({ where: { id: victim.id }, data: { status: "archived", fileCount: null, sizeBytes: null } });
    }
    if (victims.length) log.info({ projectId: project.id, count: victims.length }, "archived deployments");
  }
}

export function startMaintenance() {
  const connection = connectionFromUrl(env.REDIS_URL);
  const queue = new Queue("maintenance", { connection });
  queue.add("gc", {}, { repeat: { pattern: "0 3 * * *" }, jobId: "gc" });
  queue.add("verify-domains", {}, { repeat: { pattern: "0 */6 * * *" }, jobId: "verify-domains" });
  queue.add("evict-caches", {}, { repeat: { pattern: "30 3 * * *" }, jobId: "evict-caches" });
  new Worker("maintenance", async job => {
    if (job.name === "gc") await gcDeployments();
    if (job.name === "verify-domains") for (const domain of await prisma.domain.findMany()) await verifyDomain(domain.id);
    if (job.name === "evict-caches") await evictCacheVolumes();
  }, { connection, concurrency: 1 });
}
```

`archived` rows keep commit/status history visible in the dashboard (greyed out, no preview link). The router treats an `archived` deployment as absent.

---

## Step 6 — Deploying the platform

`docker/compose.prod.yaml` differs from dev in: images pulled from GHCR instead of built, `Caddyfile.prod`, `web` serving static nginx, env from `docker/.env` (never committed), and `restart: unless-stopped` on everything.

### Option A — Docker Bake (recommended)

`docker-bake.hcl` at the repo root describes every image once; `docker buildx bake` builds them in parallel with shared layer and registry caches. This replaces a per-app CI matrix.

```hcl
variable "REGISTRY" { default = "ghcr.io/your-org/shipyard" }
variable "TAG"      { default = "latest" }

group "default" { targets = ["api", "worker", "router", "web", "builder"] }

target "_app" {
  context  = "."
  platforms = ["linux/amd64"]
  cache-from = ["type=gha"]
  cache-to   = ["type=gha,mode=max"]
}

target "api"    { inherits = ["_app"]; dockerfile = "apps/api/Dockerfile";    tags = ["${REGISTRY}/api:${TAG}",    "${REGISTRY}/api:latest"] }
target "worker" { inherits = ["_app"]; dockerfile = "apps/worker/Dockerfile"; tags = ["${REGISTRY}/worker:${TAG}", "${REGISTRY}/worker:latest"] }
target "router" { inherits = ["_app"]; dockerfile = "apps/router/Dockerfile"; tags = ["${REGISTRY}/router:${TAG}", "${REGISTRY}/router:latest"] }
target "web"    { inherits = ["_app"]; dockerfile = "apps/web/Dockerfile";    tags = ["${REGISTRY}/web:${TAG}",    "${REGISTRY}/web:latest"] }

target "builder" {
  context = "docker/builder"
  name    = "builder-node${v}"
  matrix  = { v = ["20", "22", "24"] }
  dockerfile = "Dockerfile"
  args = { NODE_MAJOR = v }
  tags = ["${REGISTRY}/builder:node${v}"]
  cache-from = ["type=gha,scope=builder-${v}"]
  cache-to   = ["type=gha,scope=builder-${v},mode=max"]
}
```

`.github/workflows/deploy.yml`

```yaml
name: deploy
on: { push: { branches: [main] } }
jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions: { packages: write, contents: read }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/bake-action@v5
        with:
          push: true
        env:
          REGISTRY: ghcr.io/${{ github.repository }}
          TAG: ${{ github.sha }}
  rollout:
    needs: build-push
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PROD_HOST }}
          username: deploy
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/shipyard
            git pull --ff-only
            docker compose -f docker/compose.prod.yaml pull
            docker compose -f docker/compose.prod.yaml run --rm api pnpm --filter @shipyard/db migrate:deploy
            docker compose -f docker/compose.prod.yaml up -d --remove-orphans
            docker image prune -f
      - name: smoke test
        run: |
          curl -fsS https://api.yourdomain.app/health
          curl -fsS https://smoke-plain-html.yourdomain.app/ | grep -q '<title>plain-html</title>'
```

Locally, `docker buildx bake` builds everything and `docker buildx bake api` one target; `compose.yaml` can also reference the same targets, so dev and CI share one build definition.

### Option B — per-image matrix (legacy style)

Equivalent without Bake: one job per image with `docker/build-push-action`. Kept for reference; the Bake file above supersedes it.

`.github/workflows/deploy.yml`

```yaml
name: deploy
on: { push: { branches: [main] } }
jobs:
  build-push:
    runs-on: ubuntu-latest
    permissions: { packages: write, contents: read }
    strategy: { matrix: { app: [api, worker, router, web] } }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: apps/${{ matrix.app }}/Dockerfile
          push: true
          tags: ghcr.io/${{ github.repository }}/${{ matrix.app }}:${{ github.sha }},ghcr.io/${{ github.repository }}/${{ matrix.app }}:latest
  builder-image:
    runs-on: ubuntu-latest
    permissions: { packages: write }
    steps:
      - uses: actions/checkout@v4
      - uses: docker/login-action@v3
        with: { registry: ghcr.io, username: ${{ github.actor }}, password: ${{ secrets.GITHUB_TOKEN }} }
      - run: |
          for v in 20 22 24; do
            docker build --build-arg NODE_MAJOR=$v -t ghcr.io/${{ github.repository }}/builder:node$v docker/builder
            docker push ghcr.io/${{ github.repository }}/builder:node$v
          done
  rollout:
    needs: [build-push, builder-image]
    runs-on: ubuntu-latest
    steps:
      - uses: appleboy/ssh-action@v1
        with:
          host: ${{ secrets.PROD_HOST }}
          username: deploy
          key: ${{ secrets.PROD_SSH_KEY }}
          script: |
            cd /opt/shipyard
            git pull --ff-only
            docker compose -f docker/compose.prod.yaml pull
            docker compose -f docker/compose.prod.yaml run --rm api pnpm --filter @shipyard/db migrate:deploy
            docker compose -f docker/compose.prod.yaml up -d --remove-orphans
            docker image prune -f
      - name: smoke test
        run: |
          curl -fsS https://api.yourdomain.app/health
          curl -fsS https://smoke-plain-html.yourdomain.app/ | grep -q '<title>plain-html</title>'
```

Set `BUILDER_IMAGE_PREFIX=ghcr.io/<org>/shipyard/builder:node` on the prod worker so it uses the pushed images; the worker host needs `docker login ghcr.io` once (or a pull-through mirror).

**Backups:** nightly `pg_dump` to the storage bucket under `backups/`, and the `ENCRYPTION_KEY` stored in your password manager — without it, every stored token and env var is unrecoverable.

**Host hardening:** the VM exposes only 80/443/22; Postgres/Redis/MinIO bind to the Docker network only; `ufw` default deny; unattended-upgrades on.

- **Credentials:** a Redis password (`requirepass`, and `REDIS_URL=redis://:<password>@redis:6379`) and non-default Postgres and MinIO credentials, all from `docker/.env`. The dev defaults are public.
- **The worker's Docker socket is root on the host.** Anything that takes over the worker process (a bug in it, or in a dependency) can start a privileged container and own the machine. Options, in rising order of protection:
  1. A socket proxy (e.g. `tecnativa/docker-socket-proxy`) that exposes only the container create/start/attach/wait/kill/delete endpoints. It blocks most of the Docker API, but it can't check a create request's *contents*, so a compromised worker could still bind-mount `/`. It raises the bar; it doesn't contain.
  2. Run build containers under a user-space kernel: gVisor (`runtime: runsc`) or Sysbox. Build code then never touches the host kernel, so a kernel bug doesn't turn into a host escape. This is the main protection for the builds themselves, which run untrusted code.
  3. Rootless Docker for the daemon the worker talks to, so even full control of that daemon is only an unprivileged user on the host.

  Do 2 before accepting builds from people you don't know; add 1 or 3 for the worker itself.

---

## Checklist

- [ ] `https://x.yourdomain.app` valid wildcard cert; `curl -I` shows `cf-cache-status: HIT` on second fetch of a hashed asset
- [ ] Custom domain flow: add → DNS instructions → verify → cert issued on first request → serves the site
- [ ] Unverified hostname pointed at the IP gets no cert (Caddy logs `ask` denial)
- [ ] `curl -H 'accept-encoding: br' -I …/assets/index-*.js` → `content-encoding: br`
- [ ] Run `gcDeployments()` manually → only non-active, old, out-of-window prefixes removed; dashboard shows them as archived
- [ ] Push to `main` → images built → rollout → smoke test green
