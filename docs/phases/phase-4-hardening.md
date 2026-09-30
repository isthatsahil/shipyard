# Phase 4 — Sandbox Hardening & Throughput

**Goal:** builds can be cancelled, the worker recovers cleanly from crashes, redundant builds are skipped, and repeat builds are fast.
**Time:** 3–5 days.
**Done when:** cancelling a running build stops the container within 2 s; killing the worker mid-build and restarting leaves no containers or temp dirs; a warm second build of `vite-react` is ≥ 50 % faster than cold.

Prerequisite: [Phase 3](phase-3-auth-github.md).

---

## Step 1 — Cancellation

### API — `apps/api/src/routes/deployments.ts`

```ts
deployments.post("/:id/cancel", async (req, res) => {
  const deployment = await ownedDeployment(req, req.params.id);
  if (deployment.status === "queued") {
    const job = await buildQueue.getJob(deployment.id);
    await job?.remove().catch(() => {});                     // may already be locked by a worker; that's fine, the worker checks status
    await prisma.deployment.update({ where: { id: deployment.id }, data: { status: "cancelled", finishedAt: new Date(), error: "Cancelled before start." } });
    await redis.publish(keys.status(deployment.id), "cancelled");
    return res.json({ ok: true });
  }
  if (["cloning", "detecting", "building", "uploading"].includes(deployment.status)) {
    await redis.publish(keys.cancel(deployment.id), "1");             // worker owns the container; ask it to stop
    return res.json({ ok: true, pending: true });
  }
  throw new HttpError(409, "api.cancel_not_allowed", { status: deployment.status });
});
```

### Worker — subscribe once, abort per job

`apps/worker/src/lib/cancel.ts`

```ts
import { createRedis } from "@shipyard/shared/redis";
import { env } from "./clients.js";

const controllers = new Map<string, AbortController>();
const sub = createRedis(env.REDIS_URL, { subscriber: true });
await sub.psubscribe("cancel:*");
sub.on("pmessage", (_pattern, channel) => controllers.get(channel.slice("cancel:".length))?.abort());

export function registerCancel(deploymentId: string) {
  const controller = new AbortController();
  controllers.set(deploymentId, controller);
  return { signal: controller.signal, release: () => controllers.delete(deploymentId) };
}
```

In `apps/worker/src/index.ts`:

```ts
const { signal, release } = registerCancel(job.data.deploymentId);
try { await runPipeline(job.data.deploymentId, signal); } finally { release(); }
```

`build.ts` already listens on `ctx.signal` and kills the container. Make `clone.ts` and `upload.ts` check `ctx.signal.aborted` between steps and throw `BuildCancelledError` so a cancel during clone/upload is honoured too. The pipeline's catch maps `BuildCancelledError` → status `cancelled`.

---

## Step 2 — Orphan cleanup

Every builder container carries `Labels: { "shipyard.deployment": id }` (set in Phase 1). On worker start and every 10 minutes:

`apps/worker/src/lib/janitor.ts`

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@shipyard/db";
import { docker, env, log } from "./clients.js";

const IN_PROGRESS = ["cloning", "detecting", "building", "uploading"] as const;

export async function reapOrphans(activeJobIds: Set<string>) {
  // 1. Containers whose deployment this worker is not currently running.
  const containers = await docker.listContainers({ all: true, filters: { label: ["shipyard.deployment"] } });
  for (const containerInfo of containers) {
    const id = containerInfo.Labels["shipyard.deployment"];
    if (activeJobIds.has(id)) continue;
    log.warn({ deploymentId: id, container: containerInfo.Id }, "removing orphaned build container");
    await docker.getContainer(containerInfo.Id).remove({ force: true }).catch(() => {});
  }

  // 2. Work dirs with no running job.
  for (const dir of await fs.readdir(env.BUILDS_DIR).catch(() => [] as string[])) {
    if (activeJobIds.has(dir)) continue;
    await fs.rm(path.join(env.BUILDS_DIR, dir), { recursive: true, force: true }).catch(() => {});
  }

  // 3. Deployments stuck in-progress beyond the timeout (worker died mid-build).
  const cutoff = new Date(Date.now() - env.BUILD_TIMEOUT_MS - 5 * 60_000);
  const stuck = await prisma.deployment.updateMany({
    where: { status: { in: [...IN_PROGRESS] }, startedAt: { lt: cutoff }, id: { notIn: [...activeJobIds] } },
    data: { status: "failed", error: "Build was interrupted (worker restarted).", finishedAt: new Date() },
  });
  if (stuck.count) log.warn({ count: stuck.count }, "marked stuck deployments as failed");
}
```

In `index.ts`, track active job ids in a `Set` (add in the processor, delete in `finally`), call `reapOrphans(active)` before `new Worker(...)` and on `setInterval(..., 10 * 60_000)`.

Step 3 there is only correct when a single worker host runs, because another host's in-flight job is not in this host's `activeJobIds`. With multiple hosts, key the check on BullMQ instead: `await buildQueue.getJob(id)` and skip if its state is `active`. Implement that variant when you add the second host in Step 5.

---

## Step 3 — Superseded builds

In `apps/api/src/services/deployments.ts`:

```ts
export async function createDeployment(projectId: string, meta: { commitSha?: string; commitMsg?: string } = {}) {
  // A queued-but-not-started build is pointless once a newer commit arrives: cancel it.
  const queued = await prisma.deployment.findMany({ where: { projectId, status: "queued", kind: "production" } });
  for (const stale of queued) {
    const job = await buildQueue.getJob(stale.id);
    if (job && (await job.getState()) === "waiting") {
      await job.remove();
      await prisma.deployment.update({ where: { id: stale.id }, data: { status: "cancelled", error: "Superseded by a newer commit.", finishedAt: new Date() } });
    }
  }
  // …create + enqueue as before
}
```

Builds already `building` are left to finish; `promote.ts` refuses to promote over a newer `ready` deployment, so the ordering stays correct even if the older build finishes last.

Optional flag `project.cancelInFlightOnPush` that additionally publishes `cancel:<id>` for in-progress builds — useful for busy repos, off by default.

---

## Step 4 — Dependency cache

Mount a per-project Docker volume at `/cache` and point each package manager's cache at it. The volume is scoped to the project, so tenants never share a cache.

Two changes. `build.ts` creates the volume, since that needs the Docker client, and passes its name in:

```ts
// build.ts
const cacheVolume = `shipyard-cache-${ctx.project.id}`;
await docker.createVolume({ Name: cacheVolume, Labels: { "shipyard.project": ctx.project.id } }).catch(e => { if (e.statusCode !== 409) throw e; });

const container = await docker.createContainer(buildContainerSpec({ /* …as before */ cacheVolume }));
```

`containerSpec.ts` mounts it and points the package managers at it. The sandbox constants don't change:

```ts
// containerSpec.ts
export interface ContainerSpecInput {
  // …as before
  cacheVolume?: string;   // per-project dependency cache, mounted at /cache
}

const CACHE_ENV = [
  "npm_config_cache=/cache/npm",
  "PNPM_STORE_PATH=/cache/pnpm",            // pnpm still hard-links into node_modules
  "YARN_CACHE_FOLDER=/cache/yarn",
  "YARN_ENABLE_GLOBAL_CACHE=true",
  "npm_config_prefer_offline=true",
];

// in buildContainerSpec
Env: [...input.envVars, "CI=true", "HOME=/tmp", ...(input.cacheVolume ? CACHE_ENV : [])],
// HostConfig
Binds: [`${input.hostRepoRoot}:/app`, ...(input.cacheVolume ? [`${input.cacheVolume}:/cache`] : [])],
```

Add a case to `containerSpec.test.ts` that passes a `cacheVolume` and checks the extra bind, and that the sandbox test still passes.

`ReadonlyRootfs: true` stays — `/cache` is a writable volume mount. Make sure the volume is created with uid 1000 ownership: the builder image already `chown`s `/cache`, and Docker copies image-path ownership onto a fresh named volume on first mount.

Eviction, in the janitor (daily): list volumes with label `shipyard.project`, and remove those whose project has no deployment in the last 14 days. `docker.getVolume(name).remove()` fails while mounted, which is the desired behaviour.

Measure: `vite-react` cold vs warm `npm ci` should drop from tens of seconds to a few.

---

## Step 5 — Throughput & multiple worker hosts

**Sizing:** a Vite build peaks around 1–1.5 GB RSS and saturates 1–2 cores. With `BUILD_MEMORY_BYTES=2 GiB` and `BUILD_CPUS=2`, set `BUILD_CONCURRENCY = floor(host_ram / 2.5 GiB)` capped at `host_cores / 2`.

**Second host:** install Docker, pull the worker image, run only the `worker` service with the same `DATABASE_URL`, `REDIS_URL`, `S3_*`, `ENCRYPTION_KEY`, and its own `BUILDS_HOST_PATH`. Nothing else changes — BullMQ distributes jobs, each job runs entirely on one host.

**Queue settings** (already in `queue.ts`): `attempts: 1` (never auto-retry a build — a flaky `npm install` retried silently hides real problems; the user redeploys), `removeOnComplete: 1000`, `removeOnFail: 5000`.

**Worker `lockDuration`** = `BUILD_TIMEOUT_MS + 60 s`, and `stalledInterval` default is fine. If a worker host dies, BullMQ marks the job stalled after `lockDuration` and, with `attempts: 1`, moves it to failed; the janitor's stuck-deployment sweep marks the DB row.

**Queue depth visibility:** expose `GET /admin/queue` (admin-only) returning `buildQueue.getJobCounts()`; it feeds the Phase 6 gauge.

---

## Step 6 — Extra sandbox tightening (optional, cheap)

- `Ulimits: [{ Name: "nofile", Soft: 65536, Hard: 65536 }, { Name: "fsize", Soft: 2 * 1024 ** 3, Hard: 2 * 1024 ** 3 }]` — cap open files and single-file size.
- **Output size (recommended, not optional):** check the total in `upload.ts` and fail above a configurable `MAX_OUTPUT_BYTES` (default 500 MB), or use `StorageOpt: { size: "5G" }` where the storage driver supports it. Without it, one build can fill the bucket.
- **Clone limits (recommended):** a timeout on the worker's clone (e.g. 2 min, aborting `simple-git` through its `abort` option) and a size cap (`--filter=blob:limit=…` as Phase 2's detect preview does, plus a check of the work folder's size after cloning). Today a huge repo can fill the host's disk or hold a build slot until the process is killed.
- **Log cap (recommended):** limit lines per build in `BuildLogger` (e.g. 50,000): `LTRIM` the Redis list and write one "log truncated" line. A build printing without end otherwise fills Redis's memory, and Redis is also the job queue.
- Seccomp: Docker's default profile is adequate; don't set `--privileged`, ever.
- Egress allow-list (optional tightening): builds already reach the internet only through `build-proxy` (Phase 0), which refuses private and metadata addresses but allows any public host. To also block crypto-mining or exfiltration to public hosts, add an allow-list to `docker/build-proxy/squid.conf` (`registry.npmjs.org`, `github.com`, `*.githubusercontent.com`, `registry.yarnpkg.com`). Some builds legitimately fetch fonts or Puppeteer binaries, so make it a per-project opt-in.

---

## Checklist

- [ ] Cancel during `building` → status `cancelled`, container gone, work dir removed
- [ ] Cancel during `queued` → job removed, never runs
- [ ] `docker kill shipyard-worker` mid-build; restart → orphan container removed, deployment `failed` with "interrupted"
- [ ] Two rapid pushes → first deployment `cancelled (superseded)`, second builds
- [ ] Warm build ≥ 50 % faster; `docker volume ls --filter label=shipyard.project` shows one volume per project
- [ ] Second worker host picks up jobs (check `worker` field in logs)
