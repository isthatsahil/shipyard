# Work Plan: Vercel-Style Multi-Framework Deploy Platform

A platform that takes a GitHub repo URL, detects the framework, runs `npm install && npm run build` inside a sandboxed container, and serves the resulting `dist`/`build`/`out` folder on a live subdomain — for React, Vue, Svelte, Next.js (static export), Vite, and plain HTML/static sites.

This plan is informed by the architecture of [DeployX](https://github.com/bharath200415/Deploy_X) (a working reference implementation) but extends it with framework auto-detection, Docker-isolated builds, immutable deployments with rollback, and a relational data model.

---

## 1. Core Idea

Almost every modern frontend framework converges on the same contract:

```
npm install
npm run build
→ produces a folder of static files (dist / build / out / public)
```

So the platform doesn't need framework-specific logic for React vs Vue vs Svelte — it needs:
1. A way to **detect** what the output folder will be named (varies by framework/config).
2. A **sandboxed environment** to run arbitrary `npm install` / `npm run build` safely.
3. A way to **store and serve** the resulting static files per deployment.

The platform-side contract, independent of framework:

| Contract | Rule |
|---|---|
| Install | `npm ci` (fallback `npm install`); pnpm/yarn if the lockfile says so |
| Build | `package.json` `scripts.build` (overridable per project) |
| Output | First existing directory among configured → `dist/` → `build/` → `out/` → `public/` → repo root (plain HTML, no build script) |
| Routing | Static files + optional SPA fallback to `index.html` |

Next.js is the one exception — it needs `output: 'export'` in `next.config.js` to produce a static `out/` folder; otherwise it needs a Node server, which is out of scope for a static-hosting platform. This is a v1 limitation and the detector should surface it as a warning in the UI, not just in docs.

---

## 2. High-Level Architecture

```
 Browser (React dashboard)
      │ REST + SSE
      ▼
 ┌─────────────────┐    enqueue     ┌──────────┐    dequeue    ┌─────────────────────┐
 │  API Service    │ ─────────────► │  Redis   │ ────────────► │  Build Worker(s)    │
 │  (Express)      │   BullMQ       │ queue +  │               │  git clone, then    │
 │  auth, projects │ ◄───────────── │ pub/sub  │ ◄──────────── │  build in a Docker  │
 │  deployments    │  log events    └──────────┘  log lines    │  container          │
 └───────┬─────────┘                                           └──────────┬──────────┘
         │                                                                │ upload output
         ▼                                                                ▼
 ┌─────────────────┐                                           ┌───────────────────┐
 │  Postgres       │                                           │ Object storage    │
 │ users, projects │                                           │ (S3 / R2 / MinIO) │
 │ deployments     │                                           │ deployments/<id>/ │
 └─────────────────┘                                           └─────────▲─────────┘
                                                                          │ GET
 Visitor ──► *.yourdomain.app ──► Request Router (Express) ───────────────┘
                                   subdomain → active deployment id
                                   (Redis cache), stream file, SPA fallback
```

Four deployable services plus infrastructure:

| Service | Responsibility | Stack |
|---|---|---|
| **Frontend** | Paste repo URL, see live build logs, manage deployments, rollback | React + Vite + Tailwind |
| **API Service** | Auth, project CRUD, create deployments, enqueue jobs, SSE logs, GitHub webhooks | Node.js + Express + TypeScript |
| **Build Worker** | Pull job, clone repo, detect framework, build inside Docker, upload output | Node.js + BullMQ + dockerode |
| **Request Router** | Wildcard subdomain → serve the active deployment's files from storage | Node.js + Express |
| **Postgres** | Users, projects, deployments, domains | Prisma |
| **Redis** | BullMQ job queue, live log pub/sub + replay list, route cache | — |
| **Object Storage** | Build output per deployment (immutable prefixes) | S3-compatible (Cloudflare R2 / AWS S3 / MinIO for local dev) |

**Difference from DeployX:** DeployX clones in the upload service, pushes the *source* to object storage, and the build worker downloads it back. That round trip only exists because the two processes had no shared disk. Here the worker clones directly into a temp volume, so source is never stored at rest and two transfers are skipped.

---

## 3. Framework Auto-Detection

This is what makes the platform "support any framework" instead of one hardcoded build path. Implemented as an isolated, independently testable module — `detectFramework(repoPath)` — returning `{ framework, installCmd, buildCmd, outputDir, warnings[] }`.

**Resolution order (first match wins for each field):**

1. **User override** — the UI always exposes optional "Install command", "Build command" and "Output directory" fields so a misdetection is correctable rather than a black box.
2. **Config file parse** — look for an `outDir`/`distDir`/`build.outDir` override in `vite.config.*`, `next.config.*`, `vue.config.js`, `svelte.config.js`.
3. **`package.json` signatures** in `dependencies`/`devDependencies`:
   - `next` → Next.js, output `out/`; warn if `output: 'export'` is not found in the config
   - `vite` → Vite-based (React/Vue/Svelte/Solid) → `dist/`
   - `react-scripts` (CRA) → `build/`
   - `@vue/cli-service` → `dist/`
   - `@sveltejs/kit` → `build/` (requires `adapter-static`; warn otherwise)
   - `svelte` without vite → check `rollup.config.js`
   - `astro` → `dist/`
   - No `package.json`, or no `scripts.build` → **plain static HTML**: serve repo root, skip install/build entirely
4. **Package manager** — `pnpm-lock.yaml` → pnpm, `yarn.lock` → yarn, otherwise npm (`npm ci` when `package-lock.json` exists).
5. **Post-build scan (catch-all)** — after the build runs, if the resolved output dir doesn't exist, scan the repo root for a newly created directory containing an `index.html`. This is what keeps detection from becoming an endless per-framework special-casing exercise and covers frameworks not explicitly listed.

---

## 4. Build Sandboxing (Security-Critical)

DeployX runs `npm install && npm run build` as a raw Node child process on the host — fine for a personal project, but running arbitrary code from arbitrary GitHub repos this way is a real security risk (malicious `postinstall` scripts, resource exhaustion, network abuse). Repos are untrusted input by definition, so sandboxing is part of Phase 1, not a later hardening step.

- **Every build runs in an ephemeral Docker container** managed by the worker via `dockerode`.
  - Prebuilt `builder:node<major>` images (20 / 22 / 24, default 22) with npm, pnpm, yarn and git already installed so builds don't pay for toolchain setup.
  - Cloned repo mounted at `/app`; read-only root filesystem with tmpfs `/tmp`.
  - Non-root user, `--cap-drop ALL`, `--security-opt no-new-privileges`, no Docker socket inside.
  - Egress-only network (no access to internal services); optionally an npm registry proxy.
  - Hard limits: `--memory 2g --cpus 2 --pids-limit 512`, wall-clock timeout **15 minutes** by default (configurable per project; 5 min is too tight for a cold `npm ci` on a mid-size Next/SvelteKit repo).
  - Project env vars injected at run time only, never written to disk.
- Cancellation = `docker kill`; on worker start, clean up orphaned containers and volumes.
- This also gives reproducible builds and trivial horizontal scaling — a worker host just needs Docker.

---

## 5. Deployment Pipeline (Worker)

```
job {deploymentId}
  ├─ 1. status=cloning; git clone --depth 1 --branch <b> into temp volume
  │      (accept an optional GitHub token for private repos from day one, even
  │       if the OAuth flow ships later)
  ├─ 2. status=detecting; detectFramework() → install/build/output + warnings
  ├─ 3. status=building; docker run (section 4), stream stdout/stderr line-by-line
  │      → PUBLISH logs:<id>  and  RPUSH logs:<id> (EXPIRE 24h)
  ├─ 4. resolve output dir (config → default → post-build scan); fail if empty
  │      or missing index.html
  ├─ 5. status=uploading; walk output dir → deployments/<id>/<path> with correct
  │      Content-Type; immutable cache headers for hashed assets, no-cache for
  │      index.html; pre-compress .br/.gz variants
  ├─ 6. status=ready; set projects.active_deployment_id; DEL route:<slug>;
  │      persist final log to deployments/<id>/_logs.txt
  └─ on failure: status=failed + error, keep logs, clean temp dir
```

**Immutable deployments:** every build writes to its own `deployments/<id>/` prefix and is never modified. "Promoting" a deployment is a pointer flip on the project, which makes rollback instant, gives every build a preview URL (`<deploymentId>.yourdomain.app`), and makes GC "delete prefixes that are not active and older than N days".

**Superseded builds:** if a new commit for the same project arrives while a build is still queued, cancel or skip the older job.

---

## 6. Request Router

```
GET https://myapp.yourdomain.app/settings/profile

1. Extract host → "myapp". If it looks like a deployment id → preview mode.
2. Resolve: Redis GET route:myapp → deploymentId (fallback Postgres, cache 60s).
3. Normalise path: "/" → "/index.html"; "/docs/" → "/docs/index.html";
   reject any ".." after normalisation.
4. Fetch deployments/<id>/<path>
     → 404, no file extension, spa_fallback on → serve /index.html
     → 404 otherwise → /404.html if present, else generic 404
5. Stream object; set Content-Type, ETag, Cache-Control, Content-Encoding
   (serve .br/.gz variant when accepted), security headers.
   Never serve keys starting with "_" (logs/meta).
```

Production: Caddy in front (wildcard TLS via DNS-01 for `*.yourdomain.app`, on-demand TLS for custom domains), CDN keyed on host+path so the router only handles cache misses; purge on promote.

---

## 7. Live Logs

- Worker publishes each line to `logs:<id>` (pub/sub) and appends to a list of the same name for late joiners.
- API exposes `GET /deployments/:id/logs` as **Server-Sent Events**: replay the list, then subscribe. SSE is one-way, auto-reconnects, and needs no sticky sessions — simpler than WebSockets here.
- Final log archived to storage when the build finishes so Redis can expire it.

---

## 8. Tech Stack

| Layer | Choice | Why |
|---|---|---|
| Frontend | React + Vite + TailwindCSS | Fast dev, matches existing skill set |
| API / Worker / Router | Node.js + Express + TypeScript | Matches DeployX; good ecosystem for Git, S3, Redis, Docker clients |
| Database | Postgres + Prisma 7 (`@prisma/adapter-pg`) | Projects ↔ deployments is relational; history, rollback and users need it from Phase 1. Prisma 7 has no built-in pool, so the pg driver adapter is required — see Phase 0, Step 3 |
| Queue | BullMQ on Redis | Retries, timeouts, cancellation, concurrency limits and dead-letter queue out of the box instead of hand-rolled Redis lists |
| Logs / cache | Redis pub/sub + lists | Simple, fast, expiring |
| Git operations | `simple-git` | Clone/checkout without shelling out manually |
| Build isolation | Docker via `dockerode` | Sandboxed, resource-limited, reproducible builds |
| Object storage | Cloudflare R2 (prod) / MinIO (dev) via AWS SDK v3 | S3-compatible, no egress fees on R2 |
| Reverse proxy / TLS | Caddy | Zero-config wildcard + on-demand certs, gzip/brotli |
| Platform deployment | Docker Compose (dev, first prod VM) → separate worker hosts → Kubernetes only if needed | Each service is already a container |

---

## 9. Data Model (Postgres)

```
users         id, github_id, login, avatar_url, access_token (encrypted)
projects      id, user_id, name, slug (unique → subdomain), repo_url, branch,
              root_dir, install_cmd, build_cmd, output_dir, node_version,
              spa_fallback, env_vars (encrypted jsonb),
              active_deployment_id, webhook_id
deployments   id, project_id, commit_sha, commit_msg,
              status (queued|cloning|detecting|building|uploading|ready|failed|cancelled),
              framework, resolved_build_cmd, resolved_output_dir,
              started_at, finished_at, updated_at, error, storage_prefix,
              file_count, size_bytes
domains       id, project_id, hostname (unique), verified, ssl_status
```

Redis holds only ephemeral state:

```
bull:builds:*      BullMQ queue
logs:<id>          list + pub/sub channel, EXPIRE 24h
route:<slug>       → deploymentId, TTL 60s
```

Slugs: validated `[a-z0-9-]{3,40}`, reserved list (`api`, `www`, `admin`, …).

---

## 10. Phased Work Plan

Each phase ends in something demo-able. Sizing assumes one engineer.

### Phase 0 — Setup (1–2 days)
- Monorepo (pnpm workspaces): `apps/api`, `apps/worker`, `apps/router`, `apps/web`, `packages/shared` (types, storage client, config).
- `docker/compose.yaml` (Compose v2): Postgres, Redis, MinIO, Caddy with `*.localhost` routing, the four apps; per-app Dockerfiles use BuildKit cache mounts.
- `docker/builder/Dockerfile` (parameterised by `NODE_MAJOR`) → `builder:node22` image, plus `node20` and `node24` variants built from the same file via `docker/builder/docker-bake.hcl` for per-project version selection.
- Prisma schema + first migration for the tables in section 9.

### Phase 1 — End-to-end pipeline (1–2 weeks)
- API: `POST /projects`, `POST /projects/:id/deployments`, `GET /deployments/:id` (no auth yet).
- Worker: BullMQ consumer → clone → `detectFramework()` with post-build scan → Docker build with resource limits and timeout → upload to `deployments/<id>/` → mark ready and promote.
- Router: host → slug → active deployment, streaming from MinIO, SPA fallback.
- Fixture repos as integration tests: Vite React, Vue, SvelteKit (static adapter), Next.js export, CRA, plain HTML. These stay in CI for every later phase.

### Phase 2 — Logs, dashboard, history (1 week)
- Redis pub/sub + list, SSE endpoint.
- Dashboard: project list, "new project" form pre-filled from detection with override fields and warnings, deployment page with live log terminal, status badges, "Visit site" link.
- Deployment history per project with promote / rollback; preview URL per deployment.
- Failure UX: exit code + last N log lines shown prominently.

### Phase 3 — Auth, GitHub integration (1 week)
- GitHub OAuth login; encrypted token storage.
- Repo picker via GitHub API; private repo cloning.
- Auto-register push webhook; `X-Hub-Signature-256` verification; auto-deploy on push to the configured branch.
- Per-project env vars (encrypted), Node version select.
- Rate-limit deployments per user.

### Phase 4 — Sandbox hardening & throughput (3–5 days)
- Cancellation (`docker kill`), orphan cleanup on worker start, dead-letter handling.
- Dedupe superseded queued builds.
- Optional dependency cache volume keyed by lockfile hash.
- Worker concurrency tuning; add worker hosts horizontally.

### Phase 5 — Production serving (1 week)
- Caddy with wildcard DNS + wildcard cert; CDN in front with purge on promote.
- Custom domains: add → CNAME verification → on-demand TLS.
- Pre-compressed assets, correct cache headers.
- Retention/GC of non-active deployment prefixes older than N days.

### Phase 6 — Operations & stretch (ongoing)
- Structured logging (pino), `/health` per service, metrics (build duration, queue depth, router p95, 4xx/5xx), alerts on failed-build rate and backlog.
- Preview deployments per PR (deploy on `pull_request`, comment the URL).
- CLI (`deploy`) that uploads a local `dist/` directly, skipping git.
- Teams/organisations, usage quotas, build badges.

---

## 11. Key Risks to Plan For

- **Arbitrary code execution** — the single biggest thing to get right; Docker sandboxing is in Phase 1, not a later hardening step.
- **Build output ambiguity** — output dirs are user-configurable; the post-build "scan for a new folder with `index.html`" fallback is what keeps this from becoming per-framework special-casing.
- **Long-running / hanging builds** — hard 15-minute timeout, configurable; misconfigured `postinstall` scripts can hang indefinitely.
- **Superseded builds** — a push during an in-flight build must not race the older one to `active_deployment_id`; only promote if the deployment is the newest for that project.
- **Storage cost at scale** — immutable prefixes make GC simple, but a retention policy must actually run.

---

**Reference implementation to study further:** [DeployX repo](https://github.com/bharath200415/Deploy_X) — its `uploadService`, `deployService`, and `reqHandler` folders map to the API service, build worker, and request router here. The main additions on top are the framework-detection module, Docker sandboxing, BullMQ, Postgres-backed projects/deployments, and immutable deployments with rollback.

**Detailed implementation plan:** see [deploy-platform-implementation-plan.md](deploy-platform-implementation-plan.md) for per-phase tasks, file layout, interfaces and acceptance criteria.
