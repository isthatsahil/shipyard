# Phase 6 — Operations & Stretch Features

**Goal:** you can see what the platform is doing and get paged when it misbehaves; then the features that turn it from "hosting" into "Vercel-like": PR previews, a CLI, teams and quotas.
**Time:** ongoing; observability first (2–3 days), each stretch item 2–5 days.

Prerequisite: [Phase 5](phase-5-production.md).

---

## Step 1 — Structured logging

Already in place since Phase 0: `createLogger(service, level)` in `packages/shared/src/logger.ts` adds `service`, ISO timestamps and redaction of credentials. Each service creates one in `lib/clients.ts` and passes it to `pino-http`. Logs are JSON on stdout (pretty-printed when stdout is a terminal), and `docker/compose.yaml` caps each container's log file at 3 × 10 MB. What's left here is binding per-job context and shipping the logs.

In the worker, bind context once per job: `const jobLog = log.child({ deploymentId, projectId })` and pass it through `BuildContext` instead of importing a global. Ship logs with the Docker `json-file` driver + Promtail/Loki, or `awslogs`, whichever you already run. Nothing else is needed at this scale.

---

## Step 2 — Metrics

`packages/shared/src/metrics.ts`

```ts
import { Registry, Histogram, Gauge, Counter, collectDefaultMetrics } from "prom-client";
export const registry = new Registry();
collectDefaultMetrics({ register: registry });

export const buildDuration = new Histogram({
  name: "build_duration_seconds", help: "wall time of a build",
  labelNames: ["framework", "status"], buckets: [10, 30, 60, 120, 300, 600, 900], registers: [registry],
});
export const buildsQueued = new Gauge({ name: "builds_queued", help: "jobs waiting", registers: [registry] });
export const buildsActive = new Gauge({ name: "builds_active", help: "jobs running on this worker", registers: [registry] });
export const routerRequests = new Counter({ name: "router_responses_total", help: "responses by status", labelNames: ["status"], registers: [registry] });
export const routerDuration = new Histogram({ name: "router_request_duration_seconds", help: "router latency", buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1], registers: [registry] });
export const storageOps = new Counter({ name: "storage_ops_total", help: "S3 calls", labelNames: ["op", "ok"], registers: [registry] });
```

- Worker: observe `buildDuration` in the pipeline's `finally`; update `buildsQueued` from `buildQueue.getJobCounts()` every 15 s.
- Router: middleware timing every request; label with `res.statusCode`.
- Each service exposes `GET /metrics` on a separate port (`METRICS_PORT`, default 9100) bound only on the Docker network; Prometheus scrapes it. Add a `prometheus` + `grafana` pair to the prod Compose file, or push to Grafana Cloud.

**Alerts (Prometheus rules):**

```yaml
groups:
  - name: shipyard
    rules:
      - alert: HighBuildFailureRate
        expr: sum(rate(build_duration_seconds_count{status="failed"}[15m])) / sum(rate(build_duration_seconds_count[15m])) > 0.2
        for: 15m
      - alert: BuildQueueBacklog
        expr: builds_queued > 3 * sum(builds_active) + 3
        for: 10m
      - alert: RouterErrors
        expr: sum(rate(router_responses_total{status=~"5.."}[5m])) / sum(rate(router_responses_total[5m])) > 0.01
        for: 5m
      - alert: ServiceDown
        expr: up == 0
        for: 2m
```

Health endpoints: `/health` on API and router return dependency checks (DB, Redis, storage `HeadBucket`); the worker exposes `/health` on the metrics port reporting `docker.ping()` and active job count. Compose `healthcheck`s hit them so `restart: unless-stopped` cycles a wedged process.

---

## Step 3 — PR preview deployments

### Webhook

Register hooks with `events: ["push", "pull_request"]`. In `webhooks.ts`:

```ts
if (event === "pull_request") {
  const pullRequest = payload.pull_request;
  if (payload.action === "closed") {
    const previews = await prisma.deployment.findMany({ where: { projectId: project.id, kind: "preview", prNumber: pullRequest.number } });
    for (const preview of previews) { await storage.deletePrefix(preview.storagePrefix); await prisma.deployment.update({ where: { id: preview.id }, data: { status: "archived" } }); }
    return res.status(202).end();
  }
  if (["opened", "synchronize", "reopened"].includes(payload.action)) {
    if (pullRequest.head.repo.full_name !== payload.repository.full_name) return res.status(202).json({ skipped: "fork" });  // never build forks' code with the owner's secrets
    const deployment = await createDeployment(project.id, { commitSha: pullRequest.head.sha, commitMsg: pullRequest.title, kind: "preview", prNumber: pullRequest.number, ref: pullRequest.head.ref });
    return res.status(201).json({ deploymentId: deployment.id });
  }
}
```

`createDeployment` gains `kind`, `prNumber`, `ref`; the worker clones `ref` instead of `project.branch` when set; `promote.ts` skips promotion for `kind === "preview"`.

### Preview hostname

`pr-<n>-<slug>.<base>` → router: in `resolveHost`, match `/^pr-(\d+)-(.+)$/` and look up the latest `ready` preview deployment for that project and PR number (cache under `route:pr:<slug>:<n>`).

### PR comment

After a preview goes `ready`, post/update a single comment (find an existing one whose body contains `<!-- shipyard -->`):

```ts
await githubFetch(token, `/repos/${owner}/${repo}/issues/${prNumber}/comments`, { method: "POST", body: JSON.stringify({
  body: `<!-- shipyard -->\n**Preview ready:** https://pr-${prNumber}-${slug}.${BASE_DOMAIN}\n\nCommit ${sha.slice(0, 7)} · [build logs](${WEB_URL}/deployments/${id})`,
})});
```

Also emit a GitHub commit status (`/repos/…/statuses/<sha>` with `state: pending|success|failure`, `context: "shipyard/preview"`) so the PR checks list shows the build.

---

## Step 4 — CLI

`packages/cli` published as `@shipyard/cli`; binary `shipyard`.

- `shipyard login` — device flow against the API: `POST /auth/device` → API returns a code + URL; the user opens the dashboard page, approves, and the CLI polls `GET /auth/device/:code` until it receives a personal access token (new `ApiToken` table: `id, userId, hash, name, lastUsedAt`). Stored in `~/.config/shipyard/config.json`.
- `shipyard link` — pick a project (or create one with `--create`) and write `.shipyard.json` (`{ projectId }`) into the cwd.
- `shipyard deploy [dir]` — tars `dir` (default: the project's `outputDir`, or `dist`), streams it to `POST /projects/:id/deployments/upload` (multipart, 200 MB cap), prints the deployment URL and follows the log stream until done. `--prod` promotes; otherwise it's a preview.
- API: `upload` route stores the tarball at `uploads/<deploymentId>.tar` and enqueues a job with `source: "upload"`; the worker's pipeline replaces `clone`+`detect`+`build` with `extract` (using `tar` with `--no-same-owner`, path traversal checks) and continues from `resolveOutput`.

Auth middleware accepts `Authorization: Bearer <token>` in addition to the session cookie; `checkOrigin` is skipped for bearer requests.

---

## Step 5 — Teams, quotas, badges

### Schema

```prisma
model Organization { id String @id @default(cuid()); name String; slug String @unique; members Membership[]; projects Project[]; plan String @default("free") }
model Membership   { userId String; orgId String; role Role; user User @relation(...); org Organization @relation(...); @@id([userId, orgId]) }
enum Role { owner admin member }
model ApiToken     { id String @id @default(cuid()); userId String; name String; hash String @unique; lastUsedAt DateTime?; createdAt DateTime @default(now()) }
model UsageMonth   { orgId String; month String; builds Int @default(0); buildSeconds Int @default(0); bytesStored BigInt @default(0); @@id([orgId, month]) }
```

`Project.userId` becomes `Project.orgId`; every user gets a personal org on first login so existing code paths stay the same. `ownedProject(req, id)` becomes `accessibleProject(req, id)` checking membership. Invite flow: `POST /orgs/:id/invites { login }` — since everyone authenticates with GitHub, invite by GitHub login and resolve on their next login.

### Quotas

`plans.ts` with `{ free: { buildsPerMonth: 100, buildMinutesPerMonth: 300, storageBytes: 1e9 }, pro: … }`. Enforce in `createDeployment` (builds, minutes — estimated from the project's last five builds) and in `upload.ts` (bytes, after computing the size, before writing). Increment `UsageMonth` in the worker's `finally`. A 402 response with a clear message; the dashboard shows usage bars on the org page.

### Badges

```ts
projects.get("/:id/badge.svg", async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { activeDeployment: { select: { status: true } } } });
  const status = project?.activeDeployment?.status ?? "none";
  const color = status === "ready" ? "#2ea44f" : status === "failed" ? "#d73a49" : "#9e9e9e";
  res.type("image/svg+xml").setHeader("Cache-Control", "max-age=60")
     .send(`<svg xmlns="http://www.w3.org/2000/svg" width="110" height="20"><rect width="60" height="20" fill="#555"/><rect x="60" width="50" height="20" fill="${color}"/><text x="30" y="14" fill="#fff" font-family="sans-serif" font-size="11" text-anchor="middle">deploy</text><text x="85" y="14" fill="#fff" font-family="sans-serif" font-size="11" text-anchor="middle">${status}</text></svg>`);
});
```

Public (no auth), keyed by project id which is unguessable.

---

## Step 6 — Runbook (keep in `docs/runbook.md`)

- **Builds stuck in `queued`**: `docker compose logs worker`; check `builds_active` vs concurrency; `redis-cli LLEN bull:builds:wait`. Restart the worker; the janitor reaps orphans.
- **Router 5xx spike**: check MinIO/S3 health first (`storage_ops_total{ok="false"}`), then Redis. The router degrades to Postgres lookups if Redis is down but not if storage is.
- **Cert issuance failing**: `docker compose logs caddy | grep -i acme`; for wildcards, verify `CF_API_TOKEN` scope; for custom domains, verify the `ask` endpoint returns 200 for the hostname.
- **Rotate `ENCRYPTION_KEY`**: add `ENCRYPTION_KEY_OLD`, make `decrypt()` try both, run a one-off script that re-encrypts `users.accessToken`, `projects.envVars`, `projects.webhookSecret`, then drop the old key.
- **Restore**: `pg_restore` the latest dump; storage is unaffected. Deployments whose prefixes exist but rows don't will be cleaned by GC — run it after restore.

---

## Checklist

- [ ] Grafana dashboard: build duration p50/p95 by framework, queue depth, failure rate, router latency, 4xx/5xx
- [ ] Alert fires when the worker is stopped for > 2 min
- [ ] Open a PR on a linked repo → commit status pending → preview URL comment → status success; close PR → preview archived
- [ ] `shipyard deploy dist --prod` from a laptop publishes without git
- [ ] Second org member can see and deploy the project; a non-member gets 404
- [ ] Exceeding the free build quota returns 402 with a readable message
- [ ] README badge renders the current status
