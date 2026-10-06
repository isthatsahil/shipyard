# Phase 2 — Live Logs, Dashboard, History

**Goal:** a browser UI where you paste a repo URL, watch the build stream live, and promote/rollback deployments.
**Time:** ~1 week.
**Done when:** log lines appear in the browser within ~200 ms of the container printing them; an SSE reconnect resumes without duplicates; rollback flips the live site in one click without a rebuild.

Prerequisite: [Phase 1](phase-1-pipeline.md).

---

## How the pieces fit

Phase 1 already produces everything this phase shows. The worker's `BuildLogger` writes each log line twice under `logs:<deploymentId>`: `RPUSH` onto a Redis list (history) and `PUBLISH` on a channel of the same name (live). `setStatus` publishes every status change on `status:<deploymentId>`. The router serves whatever `Project.activeDeploymentId` points to. What's missing is a way for a browser to **read** all of that, and buttons to **change** the pointer.

```text
container stdout ──► BuildLogger ──► Redis  RPUSH logs:<id>   (history, 24 h TTL)
                                            PUBLISH logs:<id> (live)
                     setStatus   ──► Redis  PUBLISH status:<id>
                                              │
                    API  GET /deployments/:id/logs  (SSE)
                         1. LRANGE  → replay what already happened
                         2. SUBSCRIBE → forward what happens next
                                              │
                    browser  EventSource ──► useLogStream ─┬─► lines  → logStore (Zustand) ──► LogTerminal
                                                           └─► status → query cache (TanStack Query) ──► badge, pages
```

The phase has five steps:

1. **SSE log endpoint**: streams a deployment's log to the browser, replaying history first and then following it live. The worker archives the finished log to storage so it outlives Redis.
2. **Detect endpoint**: runs Phase 1's framework detection from the API so the "new project" form can be pre-filled before anything is built.
3. **History, promote, rollback, delete**: the API endpoints the dashboard needs to list deployments and move the live pointer.
4. **Dashboard**: the React app that ties it together, with TanStack Query for server data and Zustand for the streamed log.
5. **Router check**: confirms preview URLs survive promotions.

---

## Step 1 — SSE log endpoint (API)

The browser needs a stream of log lines that arrives within a fraction of a second, survives a dropped connection, and works for a build that finished yesterday. This step uses **Server-Sent Events (SSE)**:

- **Why SSE, not WebSockets.** Data only flows one way (server → browser). SSE is a plain HTTP response that never ends, so it passes through Caddy, CORS and cookies like any other request, and needs no library on either side. The browser's `EventSource` reconnects on its own and, crucially, sends back the id of the last event it received (`Last-Event-ID`), which gives resume-without-duplicates almost for free. WebSockets would need a library, a custom reconnect loop and a custom resume protocol.
- **Why not polling.** Polling every 200 ms to meet the latency goal would mean five requests a second per open tab, each re-reading the list. Polling less often misses the goal.

### `apps/api/src/routes/logs.ts`

```ts
import { Router } from "express";
import { prisma } from "@shipyard/db";
import { createRedis, keys } from "@shipyard/shared/redis";
import { logsKey } from "@shipyard/shared/storageKeys";
import { env, redis, storage } from "../lib/clients.js";
import { HttpError } from "../lib/httpError.js";

export const logs = Router();
const TERMINAL = new Set(["ready", "failed", "cancelled", "archived"]);

logs.get("/:id/logs", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({ where: { id: req.params.id }, select: { id: true, status: true, storagePrefix: true } });
  if (!deployment) throw new HttpError(404, "api.not_found");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",          // disable proxy buffering (nginx); Caddy streams by default
  });
  res.flushHeaders();

  const send = (event: string | null, data: string, id?: number) => {
    if (id !== undefined) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  };

  // 1. Replay. Resume from Last-Event-ID (index into the list) after a reconnect.
  const from = Number(req.headers["last-event-id"] ?? -1) + 1;
  const key = keys.logs(deployment.id);
  let lines = await redis.lrange(key, from, -1);
  let index = from;

  if (lines.length === 0 && from === 0 && TERMINAL.has(deployment.status)) {
    // Redis expired the list: fall back to the archived log in storage.
    const archived = await storage.get(logsKey(deployment.storagePrefix));
    if (archived) {
      const text = await new Promise<string>((resolve, reject) => { let collected = ""; archived.body.on("data", chunk => collected += chunk).on("end", () => resolve(collected)).on("error", reject); });
      lines = text.split("\n").filter(Boolean);
    }
  }
  for (const line of lines) send(null, line, index++);

  if (TERMINAL.has(deployment.status)) { send("done", deployment.status); return res.end(); }

  // 2. Live tail. Dedicated subscriber connection; pub/sub connections cannot run other commands.
  const sub = createRedis(env.REDIS_URL, { subscriber: true });
  await sub.subscribe(key, keys.status(deployment.id));
  sub.on("message", (channel, message) => {
    if (channel === key) send(null, message, index++);
    else if (TERMINAL.has(message)) { send("done", message); cleanup(); }
    else send("status", message);
  });

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  const cleanup = () => { clearInterval(heartbeat); sub.quit().catch(() => {}); res.end(); };
  req.on("close", cleanup);
});
```

Mount it in `index.ts`: `app.use("/deployments", logs)` alongside the existing deployments router. Express tries routers in order, and the two don't share a path (`/:id/logs` vs `/:id`), so order doesn't matter.

**Walking through the handler:**

- **Look up the deployment before writing anything.** Once `writeHead` has sent a `200` and `text/event-stream`, the response can no longer become a JSON `404`. So the only check that can fail cleanly (does this deployment exist?) runs first, and a thrown `HttpError` reaches the Phase 1 error middleware like on any other route (Express 5 forwards rejected promises from async handlers). Only the three columns the handler uses are selected.
- **The headers turn the response into a stream.**
  - `Content-Type: text/event-stream` is what makes `EventSource` accept it.
  - `Cache-Control: no-cache, no-transform`: `no-cache` stops anything from caching a live stream; `no-transform` tells proxies not to compress it. Compression buffers output until it has enough bytes to be worth compressing, which would hold log lines back for seconds.
  - `Connection: keep-alive` keeps the socket open on HTTP/1.1 (HTTP/2 ignores it).
  - `X-Accel-Buffering: no` turns off nginx's response buffering if one is ever put in front of the API. Caddy streams without it.
  - `flushHeaders()` sends the headers immediately instead of waiting for the first `write`. The browser sees the stream as open (`onopen`) even if the build hasn't printed anything yet.
- **`send` writes the SSE wire format.** Each event is a few `field: value` lines followed by a blank line. `id:` is what the browser will send back as `Last-Event-ID`; `event:` names the event (unnamed events go to `onmessage`, named ones to `addEventListener(name)`); `data:` is the payload. A `data:` value must not contain a newline, or the browser reads the rest as a new field. `BuildLogger.pipe` already splits output on newlines, so log lines are single-line. If you ever log a multi-line string with `logger.line`, split it there too.
- **The event id is the line's index in the Redis list.** This is what makes resuming cheap. During a build the list only ever grows at the end, so index `n` always means the same line. When a connection drops, `EventSource` reconnects and sends `Last-Event-ID: n`; the handler computes `from = n + 1` and replays with `LRANGE key from -1`. No per-client cursor is stored anywhere. With no header, `-1 + 1 = 0` replays from the start.
- **Replay first, then follow.** Someone who opens the page halfway through a build needs everything printed so far (`LRANGE`), then everything printed from now on (`SUBSCRIBE`). `index` continues counting from the replay into the live messages.
- **Live messages get the right ids because of how the worker writes.** `BuildLogger.flush` runs `RPUSH` and the matching `PUBLISH`es in one `MULTI`, in the same order. So the *n*th line published is also the *n*th line in the list, and `index++` on each live message produces the same number `LRANGE` would. That's why a reconnect in the middle of the live phase still resumes at the right place.
- **Old logs come from storage.** The Redis list expires `LOG_TTL_SECONDS` (24 h) after the last line, so memory doesn't grow with every build ever run. The worker archives the full log to `_logs.txt` (next section). The fallback runs only when all three are true: the list is empty, this is a fresh open (`from === 0`, not a reconnect), and the build has finished (a running build's list simply hasn't got any lines yet). The archive is a `Readable` stream, collected into a string and split back into lines; its line order is the list's order, so the ids match what the Redis replay would have produced.
- **A finished build ends the stream with `done`.** After the replay there's nothing more to wait for, so the handler sends a `done` event carrying the final status and closes the response. Ending the response alone isn't enough: `EventSource` treats a closed response as a dropped connection and reconnects forever. The client closes its `EventSource` when it sees `done` (see `useLogStream`).
- **Each open log gets its own Redis subscriber connection.** A Redis connection in subscribe mode can only run (un)subscribe commands, so the shared `redis` client can't be used; it would stop serving every other request. `createRedis(..., { subscriber: true })` sets `maxRetriesPerRequest: null` so the subscription survives a Redis restart instead of erroring out. The cost is one Redis connection per open log tab, which is fine at this scale. If it ever isn't, replace it with one shared subscriber per API process that fans messages out to open responses through a `Map<channel, Set<res>>`.
- **Two channels, one connection.** `logs:<id>` carries lines; `status:<id>` carries status changes from `setStatus`. A non-final status becomes a `status` event, so the badge and step indicator update live without polling. A final status (`ready`, `failed`, `cancelled`) becomes `done` and closes everything. The worker flushes its log before each status change, so the last lines arrive before `done`.
- **The heartbeat keeps quiet streams alive.** A line starting with `:` is an SSE comment: `EventSource` ignores it. It exists because proxies and load balancers close connections that have been idle for a while (often 30–60 s), and a long `npm install` or a slow build step can print nothing for that long. Writing to a closed socket also lets Node notice a client that vanished without a clean close.
- **`cleanup` runs when either side is done.** On `done` it stops the stream from the server side; on `req.on("close")` (tab closed, navigated away, network lost) it stops it from the client side. Without it, every closed tab would leak a Redis connection and a timer. It can run twice (after `done`, the client's close event fires too); that's harmless: `clearInterval` and `res.end()` are safe to repeat, and a second `quit()` rejection is caught. `cleanup` is used inside the message handler above its declaration; that's fine because the handler only runs later, once the `const` exists.

**The replay/subscribe gap.** A small race exists between the `LRANGE` replay and `SUBSCRIBE`: a line published in that gap is missed. `LRANGE` returns lines 0–9, the worker pushes and publishes line 10, and only then does `SUBSCRIBE` complete, so line 10 was published to nobody and is never replayed. The window is one Redis round trip, so it's rare, but it breaks the "no line lost" goal. Subscribing first turns a possible **lost** line into a possible **duplicate**, but a buffered message doesn't say which list index it is, so it can't simply be compared with `index`. The fix in `apps/api/src/routes/logs.ts` uses a marker:

1. Subscribe to the log and status channels **and** a private channel for this connection (`keys.logSync(<uuid>)`).
2. In one `MULTI`, run the `LRANGE` and `PUBLISH` a `snapshot` marker on the private channel. A `MULTI` is atomic, so no worker flush can land between the two.
3. One subscriber connection receives messages in publish order. Every log line that arrives **before** the marker was pushed before the snapshot, so it's already in the replay and is dropped. Every line **after** it is new, and its index continues from the replay. Events that arrive while the replay is still being written are queued and sent after it.

The same handler closes a related gap: a build that finishes between the status lookup and the `SUBSCRIBE` publishes its final status to nobody, and the stream would stay open forever. After the replay, the handler re-reads the status from Postgres. If it's final, it publishes that status on its private channel. The worker flushes lines before it changes the status, so the marker arrives after every remaining line, and `done` is sent only once they're out.

### Worker: archive the log on completion

In `apps/worker/src/pipeline/index.ts`, inside `finally` before the `rm`:

```ts
const all = await logger.all();
await storage.put(logsKey(deployment.storagePrefix), Buffer.from(all.join("\n")), { contentType: "text/plain" }).catch(() => {});
```

- **Why archive at all.** Redis holds logs in memory and expires them after 24 h. Object storage is cheap, durable, and already holds the deployment's files, so the log goes next to them as `_logs.txt`. This is the file the SSE endpoint's fallback reads.
- **Why in `finally`.** It runs after success, failure and cancellation alike. Failed builds are the ones whose logs matter most, so archiving only on success would miss the important case.
- **`logger.all()` flushes first**, then reads the whole list back, so the last buffered lines (including the `[error]` line written in `catch`) are included.
- **Under the deployment's `storagePrefix`.** Deleting a deployment calls `deletePrefix`, which removes the log along with the site files, with no extra bookkeeping. The router never serves `_logs.txt` because Phase 1 treats files with that prefix as platform files.
- **`.catch(() => {})`: archiving is best-effort.** A storage hiccup here must not throw out of `finally`; that would replace the pipeline's real outcome with an unrelated error. The cost of a failed archive is that the log disappears when Redis expires it.
- **Joined with `"\n"`**, which is exactly what the SSE fallback splits on.

---

## Step 2 — Detect endpoint (API)

Pre-fills the "new project" form. Shallow-clones into a temp dir on the API host and runs `detectFramework` — it does **not** run any user code (detection is pure file reads).

**Why:** without it, the user's first feedback about their build settings is a failed build a minute later. With it, the form shows "Detected Vite · pnpm · Node 20", fills in the commands, and shows warnings (like Next.js without `output: 'export'`) *before* anything is queued, so the user can fix them up front.

**Why it's safe to run in the API.** Builds run untrusted code, which is why they happen in locked-down containers. Detection only reads files (`package.json`, lockfiles, framework configs) and parses them with regexes and `JSON.parse`, never `require` or `import`. Phase 1's `readRepoFile` already refuses symlinks that lead out of the repo, devices, and oversized files, so a hostile repo can't make it read `/proc/self/environ` or `/dev/zero`.

Move `apps/worker/src/detect/` to `packages/shared/src/detect/` so both API and worker import it. Then:

- add `"./detect": "./src/detect/index.ts"` to the `exports` of `packages/shared/package.json` (one entry per module; see Phase 0);
- in the worker, change the `../detect/index.js` imports in `pipeline/detect.ts` and `pipeline/resolveOutput.ts` to `@shipyard/shared/detect`;
- move the detection unit tests along with it. Their fixture path (`../../../../../fixtures`) stays the same: `packages/shared/src/detect/__tests__` is as deep as `apps/worker/src/detect/__tests__`, so it still reaches the repo-root `fixtures/`.

`readRepoFile.ts` imports `isInside` from the worker's `lib/paths.ts`; move `paths.ts` to `packages/shared/src/paths.ts` as well, add `"./paths": "./src/paths.ts"` to the `exports`, and point the worker's imports at `@shipyard/shared/paths`. The shared module then doesn't reach back into the worker, and the API can use `resolvesInside` below.

**Why move it instead of copying.** The form promises what the build will do. If the API had its own copy of detection, the two would drift, and the form would pre-fill `dist` while the worker looks for `build`. One implementation means the preview and the real build always agree.

### `apps/api/src/routes/detect.ts`

```ts
import { Router } from "express";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { detectFramework } from "@shipyard/shared/detect";
import { resolvesInside } from "@shipyard/shared/paths";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl } from "../service/project.js";

export const detect = Router();
const CLONE_TIMEOUT_MS = 20_000;

detect.post("/", validate(z.object({ repoUrl: z.string(), branch: z.string().default("main"), rootDir: z.string().default(".") })), async (req, res) => {
  const { url } = normaliseRepoUrl(req.body.repoUrl);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "detect-"));
  // Aborting kills the git process, so a timed-out clone stops instead of running on in the background.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLONE_TIMEOUT_MS);
  try {
    try {
      await simpleGit({ abort: controller.signal }).clone(url, dir, ["--depth", "1", "--branch", req.body.branch, "--single-branch", "--filter=blob:limit=256k"]);
    } catch {
      // git's message can echo the URL; send only the code.
      throw new HttpError(400, "pipeline.clone_failed", { branch: req.body.branch });
    } finally {
      clearTimeout(timer);
    }
    const root = path.resolve(dir, req.body.rootDir);
    // Follows symlinks: a committed `site -> /` passes a plain text check but resolves outside the clone.
    if (!(await resolvesInside(dir, root))) throw new HttpError(400, "api.invalid_root_dir");
    res.json(detectFramework(root));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
```

Mount it in `index.ts` with `app.use("/detect", detect)`.

- **Validation with defaults.** zod fills in `branch: "main"` and `rootDir: "."` when they're omitted, so the handler never has to check for `undefined`.
- **`normaliseRepoUrl` is the same check project creation uses.** It only accepts `github.com/<owner>/<repo>` and rebuilds the URL itself as `https://github.com/<owner>/<repo>.git`. Whatever the user typed, git is never asked to fetch `file:///etc`, an `ssh://` URL, or an internal host, so this endpoint can't be used to make the API server reach arbitrary addresses (SSRF).
- **`mkdtemp` gives every request its own folder** (`/tmp/detect-a1B2c3`), so two people detecting at once never clone into the same place.
- **The clone flags fetch as little as possible.** Detection needs a handful of small text files from one commit.
  - `--depth 1`: only the latest commit, no history.
  - `--branch <b> --single-branch`: only that branch's refs.
  - `--filter=blob:limit=256k`: a partial clone that skips any file over 256 KB (images, videos, fonts, vendored bundles). Config files are far smaller. A repo with hundreds of MB of assets clones in seconds.
- **The 20 s timeout kills the clone, not just the wait.** The timer aborts an `AbortController` whose signal is passed to simple-git as `abort`; simple-git then kills the git child process and the `clone` call rejects. A huge or unreachable repo can't leave the form spinning, and, unlike a `Promise.race` against a timer, git doesn't keep running in the background (downloading, using CPU, writing into a folder `finally` is deleting). `clearTimeout` in the inner `finally` stops the timer once the clone has finished either way. simple-git's `timeout: { block }` option isn't used because it only fires when git goes *silent* for that long; a slow but steady download would never trip it.
- **Clone errors become one generic error code.** git's error text can contain the repo URL (and, once Phase 3 adds GitHub tokens, the token in it). The client only gets `pipeline.clone_failed` with the branch name, which the dashboard translates ("Couldn't clone branch `main`"). The most common cause is a misspelled branch, hence the parameter. A timeout lands here too.
- **`rootDir` can't escape the clone, even through symlinks.** `path.resolve(dir, "../../etc")` produces `/etc`, and a repo can also commit a symlink such as `site -> /` that looks like it's inside the clone but leads to the whole filesystem. `resolvesInside` (the helper the worker uses, now in `packages/shared`) resolves both paths with `realpath`, following every symlink, and accepts `root` only if it really is `dir` or below it. It compares with `+ path.sep`, so `/tmp/detect-abc` doesn't match a different request's `/tmp/detect-abcX`. Comparing real paths on both sides also handles macOS, where `/tmp` is itself a symlink to `/private/tmp`. A `rootDir` that doesn't exist fails the check too, which gives the user a clear "invalid root directory" instead of an empty detection result. Without this check, `readRepoFile`'s own guard wouldn't help: it refuses files outside the root, but with `site -> /` the root *is* `/`.
- **`finally` always deletes the folder**, whether detection succeeded, the clone failed or the timeout fired, so `/tmp` doesn't fill up with abandoned clones.

---

## Step 3 — History, promote, rollback, delete (API)

These are the endpoints behind the project list, the deployment history table, and the Promote / Rollback / Delete buttons. The central idea comes from Phase 1: **every deployment is immutable** (its files live under their own `deployments/<id>/` prefix and are never overwritten), and **"live" is just a pointer** (`Project.activeDeploymentId`). So promoting and rolling back don't copy or rebuild anything; they move the pointer and clear the router's cache.

### Additions to `apps/api/src/routes/projects.ts`

```ts
const ACTIVE_DEPLOYMENT = { select: { id: true, status: true, commitSha: true, framework: true, createdAt: true, finishedAt: true } } as const;

const ProjectsPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["updated", "name", "created"]).default("updated"),
});
const PROJECT_ORDER = { updated: { updatedAt: "desc" }, name: { name: "asc" }, created: { createdAt: "desc" } } as const;

projects.get("/", validate(ProjectsPage, "query"), async (req, res) => {
  const { page, pageSize, q, sort } = req.query as unknown as z.infer<typeof ProjectsPage>;
  const contains = { contains: q, mode: "insensitive" } as const;
  const where = q ? { OR: [{ name: contains }, { slug: contains }, { repoUrl: contains }] } : {};
  const [items, total] = await prisma.$transaction([
    prisma.project.findMany({
      where,
      orderBy: [PROJECT_ORDER[sort], { id: "desc" }],                  // id breaks ties
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        activeDeployment: ACTIVE_DEPLOYMENT,
        deployments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 1, select: { id: true, status: true, commitSha: true, commitMsg: true, createdAt: true } },
      },
    }),
    prisma.project.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

// Replaces the Phase 1 handler: adds the live deployment and a deployment count.
projects.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      activeDeployment: ACTIVE_DEPLOYMENT,
      deployments: { orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 10 },
      _count: { select: { deployments: true } },
    },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  const { _count, deployments, ...rest } = project;
  res.json({
    ...rest,
    deploymentCount: _count.deployments,
    deployments: deployments.map(row => ({ ...row, sizeBytes: row.sizeBytes?.toString() ?? null })),
  });
});

const DeploymentsPage = z.object({ cursor: z.string().optional() });

projects.get("/:id/deployments", validate(DeploymentsPage, "query"), async (req, res) => {
  const take = 20;
  const { cursor } = req.query as z.infer<typeof DeploymentsPage>;
  const rows = await prisma.deployment.findMany({
    where: { projectId: req.params.id },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],                  // id breaks createdAt ties
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const items = rows.slice(0, take);
  // The cursor is the last row returned; `skip: 1` above skips it on the next request.
  const next = rows.length > take ? items[items.length - 1]!.id : null;
  res.json({ items: items.map(row => ({ ...row, sizeBytes: row.sizeBytes?.toString() ?? null })), next });
});

projects.delete("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { deployments: { select: { storagePrefix: true } } } });
  if (!project) throw new HttpError(404, "api.not_found");
  await prisma.project.delete({ where: { id: project.id } });           // cascades deployments + domains
  await redis.del(keys.route(project.slug));
  // Storage cleanup is best-effort and async; the retention job (Phase 5) catches stragglers.
  void Promise.all(project.deployments.map(deployment => storage.deletePrefix(deployment.storagePrefix)))
    .catch(err => log.warn({ err, projectId: project.id }, "storage cleanup failed"));
  res.status(204).end();
});
```

**`GET /projects`: the project list, with page numbers, search and sort.** The dashboard's project list ([UI design §5.2](ui-design.md#52-project-list--projects)) shows "Showing 13–24 of 48", numbered page links, a search box and a sort menu, all kept in the URL (`/projects?page=2&q=blog&sort=name`). This endpoint returns exactly what that screen needs: `{ items, total, page, pageSize }`.

- **The query string is validated and coerced.** Query values always arrive as strings; `z.coerce.number()` turns `"2"` into `2`, `.default` fills in what's missing, and `validate` replaces `req.query` with the parsed result. A bad value (`?page=0`, `?sort=size`) gets a clean `400` instead of reaching Prisma. `pageSize` is capped at 50 so one request can't ask for the whole table. The `as unknown as` cast is needed because Express still types `req.query` as strings.
- **Numbered pages here, a cursor for deployments.** The project list needs a total and the ability to jump to page 4, which only offset pagination (`skip`/`take`) gives. Its weakness, rows shifting when new ones are added, matters little here: projects are created far less often than deployments, and the list is sorted by the user's choice rather than always newest first. The deployment history keeps its cursor (below), where new rows arrive constantly at the top.
- **One `$transaction` for the page and the count.** Both queries run on the same snapshot, so `total` can't disagree with `items` because a project was created between them.
- **Search is case-insensitive across name, slug and repo URL.** `mode: "insensitive"` makes Postgres use `ILIKE`, so "Blog" finds `my-blog`. The `where` object is built once and shared by both queries, so the count matches the filtered list. On a few thousand projects this needs no index; a trigram index on these columns would speed it up beyond that.
- **The sort options map to fixed `orderBy` objects** (`PROJECT_ORDER`), so the client picks a name and never sends a column. `id` is added as a second key so projects with the same name or timestamp keep a stable order across pages, the same reason as for deployments below.
- **One query for the whole page.** Each card shows the project, what's live, and the latest build (status, SHA, message, time). `include` fetches the live deployment and the single newest deployment (`take: 1`) with the projects, so Prisma runs a fixed number of queries instead of one per project (the "N+1" problem). Only the columns the card shows are selected, keeping the response small and keeping `BigInt` columns out of it.

**`GET /projects/:id`: now includes the live deployment.** This replaces the Phase 1 handler. The project page needs to know *when* the live deployment was created, to label older rows "Rollback to this" (see `ProjectPage`). The Phase 1 version only returned `activeDeploymentId`, so the label could never be computed.

- **`activeDeployment` is the same small selection** as in the list (`ACTIVE_DEPLOYMENT`), shared so the two endpoints return the same shape. It includes `framework` for the project summary's Framework stat.
- **`deploymentCount`** comes from Prisma's `_count`, a `COUNT` done in the same query. The project summary in the UI design shows it. `_count` is renamed on the way out so the API doesn't expose Prisma's naming.
- **`sizeBytes` is converted to a string** on the included deployments. The Phase 1 handler returned the rows as they were, and `res.json` throws on the `BigInt` as soon as one of them has finished uploading.

**`GET /projects/:id/deployments`: deployment history, paginated by cursor.**

- **Why a cursor instead of `?page=2`.** New deployments are added at the top of the list. With offset pagination (`skip: 20`), a build that starts while you're reading page 1 pushes every row down by one, and page 2 then repeats the last row of page 1. A cursor says "the rows after *this* one", which stays correct no matter what's added above. It's also faster on large tables: the database seeks to the cursor row through the index instead of counting past `skip` rows.
- **`take: take + 1` answers "is there another page?" without a `COUNT`.** Fetch 21 rows; if 21 come back, there's more. Only the first 20 are returned (`items`); the 21st was fetched just to find out that it exists.
- **The cursor is the last row the client received**, and `skip: 1` skips it. Prisma's `cursor` starts the page *at* that row, including it; the client already has it, so `skip: 1` moves one past it. The cursor and the skip have to agree: had `next` been the 21st row (the first row of the *next* page, which the client hasn't seen), `skip: 1` would drop it and every page boundary would lose one deployment. The client stops when `next` is `null`.
- **`id` breaks ties on `createdAt`.** Two deployments created in the same millisecond have no defined order, and the database may return them in a different order on the next request, so a page boundary between them could repeat one and skip the other. Adding `id` as a second sort key makes the order total and the same on every request.
- **`sizeBytes` becomes a string.** It's a `BigInt` column (a site can exceed the 2 GB limit of a 32-bit `Int`), and `JSON.stringify` throws `TypeError: Do not know how to serialize a BigInt`. A string rather than a `Number` avoids silently losing precision above 2^53; the dashboard formats it for display.
- **`validate(..., "query")`** checks `req.query` rather than the body, so a malformed cursor is a clean `400`.

**`DELETE /projects/:id`: delete a project and everything under it.**

- **Read the storage prefixes before deleting.** The delete cascades (`onDelete: Cascade` in the schema) to the project's deployments and domains. After it, the prefixes are gone from the database, so they're collected first.
- **Database first, then cache, then files.** Once the row is gone, nothing points at the files any more. Deleting `route:v2:<slug>` makes the router stop serving the site on the next request, instead of for up to `ROUTE_TTL_SECONDS` from its cache.
- **File deletion is fire-and-forget.** A project can have thousands of files across many deployments; the user shouldn't wait for that. Anything left behind (the API restarted mid-delete, S3 error) is orphaned files with no row pointing at them, which the retention job in Phase 5 removes. `void` marks the promise as intentionally not awaited, and the `.catch` is required, not optional: an un-awaited promise that rejects becomes an unhandled rejection, which by default stops the Node process, so one S3 error would take the whole API down. The failure is logged instead (`log` comes from `../lib/clients.js`, alongside `redis` and `storage`).
- **`204 No Content`**: success with no body. The dashboard's `req` helper checks for this status and doesn't try to parse JSON.

### Additions to `apps/api/src/routes/deployments.ts`

```ts
deployments.post("/:id/promote", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({ where: { id: req.params.id }, include: { project: true } });
  if (!deployment) throw new HttpError(404, "api.not_found");
  if (deployment.status !== "ready") throw new HttpError(409, "api.promote_not_ready");
  await prisma.project.update({ where: { id: deployment.projectId }, data: { activeDeploymentId: deployment.id } });
  await redis.del(keys.route(deployment.project.slug));
  res.json({ ok: true, activeDeploymentId: deployment.id });
});

deployments.delete("/:id", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({ where: { id: req.params.id }, include: { activeFor: true } });
  if (!deployment) throw new HttpError(404, "api.not_found");
  if (deployment.activeFor) throw new HttpError(409, "api.delete_active");
  if (!TERMINAL.has(deployment.status)) throw new HttpError(409, "api.deployment_in_progress");
  await prisma.deployment.delete({ where: { id: deployment.id } });
  void storage.deletePrefix(deployment.storagePrefix)
    .catch(err => log.warn({ err, deploymentId: deployment.id }, "storage cleanup failed"));
  res.status(204).end();
});
```

**`POST /deployments/:id/promote`: make this deployment live.**

- **Only `ready` deployments.** `ready` guarantees the build succeeded and all its files are in storage. Promoting a failed or half-uploaded deployment would put a broken site live. `409 Conflict` means "valid request, but not in this state".
- **Promotion is the same two operations as in the worker's `promote`:** set `activeDeploymentId`, then delete the `route:v2:<slug>` cache entry so the router re-reads the pointer on the next request. The switch is atomic from a visitor's point of view: each request is served entirely from the old files or entirely from the new ones.
- **No "newer wins" check here, on purpose.** The worker's automatic promotion refuses to replace a newer deployment with an older one, because two builds finishing out of order shouldn't roll a site back by accident. A click on "Promote" is an explicit decision, so it always wins.
- **The response returns the new pointer**, so the dashboard can update without guessing.

**Rollback is not a separate endpoint** — the UI calls `promote` on an older row. Because old deployments are kept intact under their own prefix, "roll back" and "promote" are the same operation pointed at different rows. That's what makes rollback take one click and no rebuild.

**`DELETE /deployments/:id`: remove one deployment.**

- **The live deployment can't be deleted (409).** The schema would allow it (`onDelete: SetNull` would clear the pointer), but the site would then silently go offline. Refusing makes the user promote something else first, a deliberate choice.
- **A running build can't be deleted (409).** The worker is still writing into its prefix and will call `setStatus` on its row; deleting under it would leave half-uploaded files behind and make the worker fail on a missing row. Phase 4's cancel is the way to stop a running build.
- **"Finished" is `TERMINAL`** (from `../utils/consts.js`, the same set the log endpoint uses), so `archived` deployments can be deleted too. A hand-written `["ready", "failed", "cancelled"]` list would refuse them with a misleading "still in progress".
- **Files are removed in the background**, same as for projects, with the same `.catch` so a storage error is logged rather than crashing the API. That also removes the archived `_logs.txt`.

---

## Step 4 — Dashboard (`apps/web`)

This step builds the screens that use Steps 1–3: the project list, the "new project" form, a project's deployment history with Promote/Rollback, and a deployment's live log. The snippets here define the **data flow** (queries, mutations, the log stream, state) and use plain Tailwind for markup.

**Look and layout come from [UI design](ui-design.md); structure and components from [UI implementation](ui-implementation.md).** When you build the pages, take the markup from the shadcn components, tokens and page specs in those files and keep the data flow from here. The UI implementation doc also adds what isn't shown here: the landing page at `/`, layouts, error pages, the `NetworkError` handling in the API client, optimistic promote with undo, and virtualised long logs.

### Dependencies

From `apps/web`:

```bash
pnpm add react-router @tanstack/react-query zustand
pnpm dlx shadcn@latest add sonner
```

- **`react-router` (v8, currently 8.4.0)** maps URLs to pages, so every project and deployment has a shareable link and the back button works. Everything ships from the single `react-router` package; `react-router-dom` is the older (v6) package name for the same library.
- **`@tanstack/react-query`** owns all **server state**: anything the API returns. It caches responses by key, refetches on an interval, de-duplicates identical requests, and tracks loading and error state.
- **`zustand`** owns **client state that several components share**. Here that's the build log assembled from the SSE stream (see the next section).
- **`sonner`** (added through shadcn, so it matches the other components) shows a toast when an action such as Promote fails.

Already in the repo, so not added: `cn` ([lib/utils.ts](../../apps/web/src/lib/utils.ts)) for conditional class names, and react-i18next. Dates use the browser's `Intl` formatters, so neither `clsx` nor `date-fns` is needed.

### State: who owns what

Every piece of state in the dashboard has exactly one owner:

| State | Owner | Examples | Why there |
| --- | --- | --- | --- |
| Data the server owns | **TanStack Query** | projects, deployment history, a deployment's row and status | It can always be fetched again. The browser only keeps a cached copy, and Query decides when that copy is stale. |
| Data the browser assembles and several components read | **Zustand** | the log lines of the deployment being viewed | It can't be refetched as a whole (it arrives line by line over SSE), and the log view, the failure box and later the log line components all read it. |
| Data only one component uses | **`useState`** | form fields, the log view's follow mode | Nobody else needs it; a store would only add indirection. |

Two rules keep the owners from overlapping:

- **Never copy query data into Zustand** (or into `useState`). A copy goes stale the moment the server changes; the query cache is the single copy.
- **Live status from SSE goes into the query cache, not into Zustand.** A deployment's status is server data that happens to arrive over SSE. Writing it into the `["deployment", id]` query with `setQueryData` means every component reading that deployment updates together, and the next refetch simply overwrites it with the same value.

**Why Zustand for the log, rather than `useState` inside the hook:**

- **Several readers, without re-rendering the page.** The log view, the failed-build box (last 20 lines) and, with the UI doc's design, each log line read the log. With `useState`, the lines would live in the page and be passed down as props, so the whole page (header, step tracker, links) would re-render on every batch of lines during an `npm install`. With a store, each component subscribes with a selector and only the components that read the lines re-render.
- **Keyed by deployment id.** The store holds logs per deployment, so moving from one deployment to another can never show the previous log, and no remount trick is needed.
- **The logic is plain functions.** De-duplication and batching are store actions that can be unit-tested by calling them, without rendering a component or faking an `EventSource`.
- **Small and provider-free.** About 1 kB, no context provider, and readable outside React (`useLogStore.getState()`), which the stream hook uses.

The cost is one more concept for contributors. The table above is the rule to follow when adding new state.

### Folder layout

The files follow [UI implementation §3](ui-implementation.md#3-folder-structure):

```text
apps/web/src/
├─ main.tsx                        providers + <RouterProvider>
├─ app/
│  ├─ provider.tsx                 QueryClient (toasts for failed actions), Toaster
│  └─ router.tsx                   routes
├─ api/
│  ├─ client.ts                    req(), ApiError, api.*
│  ├─ types.ts                     response types
│  └─ queries.ts                   query keys + useQuery/useMutation hooks
├─ stores/
│  └─ logStore.ts                  Zustand: log lines per deployment
├─ hooks/
│  └─ useLogStream.ts              SSE → log store + query cache
├─ lib/
│  └─ format.ts                    formatRelative()
├─ components/
│  ├─ StatusBadge.tsx
│  └─ log/LogTerminal.tsx
└─ features/
   ├─ projects/ProjectListPage.tsx  NewProjectPage.tsx  ProjectPage.tsx
   └─ deployments/DeploymentPage.tsx
```

Imports use the `@/` alias for `src/` (already set up in `tsconfig.app.json` and Vite).

**i18n.** All UI text goes through react-i18next (`src/i18n/`): `t("key")` for UI copy in `locales/<lng>/common.json`, and `formatUserMessage(i18n, { code, params }, fallback)` for anything the server sends (API errors and `deployment.errorCode`). Don't render `error.message` or `deployment.error` directly. Dates and sizes use `Intl.DateTimeFormat`/`Intl.NumberFormat`/`Intl.RelativeTimeFormat` with `i18n.language`. The snippets below keep inline English for brevity; move each string into `common.json` when you build the page.

Why the split between `code` and `message`: the server sends a stable machine-readable code (`pipeline.clone_failed`) with parameters (`{ branch: "main" }`), plus an English fallback. The dashboard looks the code up in the user's language and fills in the parameters. The English `message` is only used if the code is unknown, e.g. a newer server talking to an older dashboard.

### `src/api/types.ts`

The shapes of the API's JSON responses.

```ts
export type DeploymentStatus = "queued" | "cloning" | "detecting" | "building" | "uploading" | "ready" | "failed" | "cancelled" | "archived";

/** Statuses a deployment never leaves; the log stream ends with one of these. */
export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ["ready", "failed", "cancelled", "archived"];
export const isTerminal = (status: DeploymentStatus) => TERMINAL_STATUSES.includes(status);

export interface Deployment {
  id: string; projectId: string; status: DeploymentStatus;
  commitSha: string | null; commitMsg: string | null; framework: string | null;
  error: string | null; errorCode: string | null; errorParams: Record<string, string | number> | null;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
  fileCount: number | null; sizeBytes: string | null;
}
export type DeploymentDetail = Deployment & { project: { slug: string } };
export type ActiveDeployment = Pick<Deployment, "id" | "status" | "commitSha" | "framework" | "createdAt" | "finishedAt">;
export type LatestDeployment = Pick<Deployment, "id" | "status" | "commitSha" | "commitMsg" | "createdAt">;

export interface Project {
  id: string; name: string; slug: string; repoUrl: string; branch: string; rootDir: string;
  activeDeploymentId: string | null; activeDeployment: ActiveDeployment | null;
  createdAt: string; updatedAt: string;
}
export type ProjectListItem = Project & { deployments: LatestDeployment[] };
export type ProjectDetail = Project & { deploymentCount: number; deployments: Deployment[] };

export type ProjectSort = "updated" | "name" | "created";
export interface ProjectListParams { page: number; pageSize: number; q?: string; sort: ProjectSort }

/** A numbered page (`GET /projects`). */
export interface Page<T> { items: T[]; total: number; page: number; pageSize: number }
/** A cursor page (`GET /projects/:id/deployments`); `next` is null on the last page. */
export interface CursorPage<T> { items: T[]; next: string | null }

export interface DetectResult { framework: string; packageManager: string; installCmd: string | null; buildCmd: string | null; outputDir: string | null; nodeVersion: string; warnings: string[] }
export interface CreateProject { repoUrl: string; branch?: string; slug?: string; name?: string; rootDir?: string; installCmd?: string; buildCmd?: string; outputDir?: string; spaFallback?: boolean }
```

- **They describe the JSON, not the database.** Dates are ISO **strings** (that's how JSON encodes them) and `sizeBytes` is a string (see Step 3). Parse dates where you display them.
- **`archived` is included.** The worker's state machine moves `ready` deployments to `archived` when retention deletes their files (Phase 5), and the API returns whatever is in the row. Leaving it out would make TypeScript claim a value can't occur when it can.
- **`isTerminal` is the one definition of "finished"**, used by polling, the log hook and the pages. It matches the server's `TERMINAL` set in the log endpoint. Writing `["ready", "failed", "cancelled"].includes(...)` in several places is how `archived` got missed before.
- **One type per response shape.** A list item, a project detail and a deployment detail include different related rows, so each gets its own type, and a page can't read a field its endpoint doesn't send.

### `src/api/client.ts`

The one place the dashboard talks to the API. Components never call `fetch`; they use the hooks in `queries.ts`, which call `api.*`.

```ts
import type { CreateProject, CursorPage, Deployment, DeploymentDetail, DetectResult, Page, Project, ProjectDetail, ProjectListItem, ProjectListParams } from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "https://api.localhost";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, { credentials: "include", headers: { "content-type": "application/json" }, ...init });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body.error);
  return body;
}

/** A failed API call. Render it with `formatUserMessage(i18n, err, err.message)`. */
export class ApiError extends Error {
  status: number;
  code?: string;
  params?: Record<string, string | number>;
  constructor(status: number, error?: { code: string; params?: Record<string, string | number>; message: string }) {
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = error?.code;
    this.params = error?.params;
  }
}

const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(params).flatMap(([key, value]) => (value === undefined ? [] : [[key, String(value)]]))).toString();

export const api = {
  projects: (params: ProjectListParams) => req<Page<ProjectListItem>>(`/projects?${query({ ...params })}`),
  project: (id: string) => req<ProjectDetail>(`/projects/${id}`),
  createProject: (body: CreateProject) => req<{ project: Project; deployment: Deployment | null }>("/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  detect: (body: { repoUrl: string; branch?: string; rootDir?: string }) => req<DetectResult>("/detect", { method: "POST", body: JSON.stringify(body) }),
  deploy: (projectId: string) => req<Deployment>(`/projects/${projectId}/deployments`, { method: "POST" }),
  deployments: (projectId: string, cursor?: string) => req<CursorPage<Deployment>>(`/projects/${projectId}/deployments?${query({ cursor })}`),
  deployment: (id: string) => req<DeploymentDetail>(`/deployments/${id}`),
  promote: (id: string) => req<{ ok: true; activeDeploymentId: string }>(`/deployments/${id}/promote`, { method: "POST" }),
  logsUrl: (id: string) => `${BASE}/deployments/${id}/logs`,
};
```

- **`BASE` comes from the build environment** (`VITE_API_URL`), with the local Caddy URL as the default, so the same code works locally and in production.
- **`credentials: "include"`** sends cookies to the API even though it's on another subdomain. Nothing needs them yet, but Phase 3's login session is a cookie, and this way no call site has to change then.
- **`204` is handled before parsing.** A `204` has no body, and `response.json()` would throw on it.
- **Errors become an `ApiError` with the server's `code` and `params`.** A plain `Error` would only carry the English message; this keeps the code so the UI can translate it. A non-JSON error response (a proxy's HTML 502 page, say) makes `response.json()` throw a `SyntaxError` instead; the UI still shows *an* error, just an untranslated one. The UI implementation doc adds a `NetworkError` for "no response at all".
- **`query()` builds query strings safely.** `URLSearchParams` encodes values (a search for `a&b` stays one parameter), and `undefined` values are left out, so `?q=` isn't sent for an empty search.
- **Every call is typed.** `req<T>` casts the JSON to `T`, so pages get autocompletion and type errors if they use a field that doesn't exist. The cast isn't checked at runtime, so `types.ts` must match what the API really returns.
- **`logsUrl` returns a URL instead of fetching**, because the log stream is opened by `EventSource`, not `fetch`.

**If every request fails with "Failed to fetch":** the dashboard calls `https://api.localhost` in the background, and the browser rejects the certificate, because Caddy's local CA isn't trusted. Background requests (`fetch`, `EventSource`) never show the "proceed anyway" warning, so they just fail. Trust the CA once ([Phase 0 → Trusting the Caddy CA](phase-0-setup.md#trusting-the-caddy-ca)), or open `https://api.localhost` in a tab and accept the warning.

Keep `BASE` on Caddy's HTTPS URL rather than `http://localhost:4000`. Caddy serves HTTP/2, so every open log stream shares one connection. Over plain HTTP the browser allows about 6 connections per host, and a few open `EventSource`s leave no room for other requests, so the dashboard freezes.

### `src/api/queries.ts`

Every query key and every server call the pages make, as hooks. Pages import `useProject(id)`, not `useQuery` with a hand-written key.

```ts
import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "./client";
import { isTerminal, type ProjectListParams } from "./types";

export const qk = {
  projects: (params: ProjectListParams) => ["projects", params] as const,
  project: (id: string) => ["project", id] as const,
  deployments: (projectId: string) => ["deployments", projectId] as const,
  deployment: (id: string) => ["deployment", id] as const,
};

export const useProjects = (params: ProjectListParams) =>
  useQuery({ queryKey: qk.projects(params), queryFn: () => api.projects(params), placeholderData: keepPreviousData });

export const useProject = (id: string) =>
  useQuery({ queryKey: qk.project(id), queryFn: () => api.project(id) });

export const useDeployments = (projectId: string) =>
  useInfiniteQuery({
    queryKey: qk.deployments(projectId),
    queryFn: ({ pageParam }) => api.deployments(projectId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: lastPage => lastPage.next ?? undefined,
    // Fast while a build is running, slow otherwise (a push can still start one).
    refetchInterval: query => (query.state.data?.pages[0]?.items.some(row => !isTerminal(row.status)) ? 5_000 : 30_000),
  });

export const useDeployment = (id: string) =>
  useQuery({
    queryKey: qk.deployment(id),
    queryFn: () => api.deployment(id),
    // Polls for fields SSE doesn't carry (commit SHA and message); stops once the build is over.
    refetchInterval: query => (query.state.data && isTerminal(query.state.data.status) ? false : 3_000),
  });

// `silent`: the form shows these errors inline, so the global toast skips them.
export const useDetect = () => useMutation({ mutationFn: api.detect, meta: { silent: true } });
export const useCreateProject = () => useMutation({ mutationFn: api.createProject, meta: { silent: true } });

export function useDeploy(projectId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.deploy(projectId),
    onSuccess: deployment => {
      void queryClient.invalidateQueries({ queryKey: qk.deployments(projectId) });
      navigate(`/deployments/${deployment.id}`);
    },
  });
}

export function usePromote(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.promote,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.project(projectId) });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
```

- **Query keys live in one object (`qk`).** A key is just an array; a typo like `["deployment", id]` vs `["deployments", id]` would silently miss the cache or invalidate nothing. With `qk`, every reader and every invalidation use the same function. Keys are hierarchical: `["projects"]` matches every `["projects", params]`, which is how one call invalidates every page of the project list.
- **`keepPreviousData` on the project list** keeps the current page on screen while the next page loads, instead of flashing an empty grid between pages.
- **Deployment history is an infinite query.** `useInfiniteQuery` stores the pages fetched so far and asks `getNextPageParam` for the next cursor, which is the API's `next` (`undefined` means no more pages). The page shows them as one list with a "Load more" button.
- **Polling adapts to what's happening.** The history refetches every 5 s while a build in it is running and every 30 s otherwise, so a build started by a push still appears without a reload. The deployment query polls every 3 s for fields SSE doesn't carry (the commit SHA and message, known only after cloning) and stops at a final status. The `refetchInterval` function is re-evaluated after every fetch, which is what lets it switch itself off.
- **Mutations invalidate what they change.** Deploy adds a row to the history; Promote changes the project's live deployment (shown on its page and in the list). Invalidation marks those queries stale and refetches the ones on screen. The pages never edit cached data by hand for these, so it can't drift from the server. (The UI doc's promote updates the cache optimistically first, then confirms the same way.)
- **Deploy navigates to the new build's log**, the screen the user wants right after clicking.
- **`meta: { silent: true }`** marks mutations whose errors the form shows next to its fields; the global error toast (in `provider.tsx`) skips them, so the user doesn't get the same error twice.
- **Detection is a mutation even though it only reads.** `useQuery` is for data tied to what's on screen, fetched automatically and cached by key. Detection is triggered by an event (leaving the URL field), and its result is copied into the form once, which is what mutations are for.

### `src/app/provider.tsx` and `src/main.tsx`

```tsx
// src/app/provider.tsx
import { MutationCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "i18next";
import { toast } from "sonner";
import { Toaster } from "@/components/ui/sonner";
import { ApiError } from "@/api/client";
import { formatUserMessage } from "@/i18n/formatMessage";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      // A 4xx won't succeed on retry; a network blip or a 5xx might.
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
  mutationCache: new MutationCache({
    onError: (err, _variables, _context, mutation) => {
      if (mutation.meta?.silent) return;
      toast.error(formatUserMessage(i18n, err as ApiError, err.message));
    },
  }),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      {children}
      <Toaster />
    </QueryClientProvider>
  );
}
```

```tsx
// src/main.tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router";
import "@/i18n";
import "@/index.css";
import { Providers } from "@/app/providers";
import { router } from "@/app/router";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Providers>
      <RouterProvider router={router} />
    </Providers>
  </StrictMode>,
);
```

- **One `QueryClient` for the whole app**, created once at module level (not inside a component, which would create a new, empty cache on every render). `QueryClientProvider` wraps the router, so every page shares one cache: a deployment loaded from the project page is already there when you open it.
- **`staleTime: 10_000`**: data younger than 10 s counts as fresh, so moving between pages doesn't refetch everything at once. Polling and invalidation still fetch whenever they need to.
- **Retries only where they can help.** By default TanStack Query retries every failure three times. A `404` or `409` will fail the same way again, so only network errors and `5xx` are retried, twice.
- **Every failed mutation shows a toast, in one place.** Without this, each button (Deploy, Promote, Delete) needs its own error display, and the ones that forget fail silently, as Promote did in the earlier version of this page. A `MutationCache` `onError` sees every mutation's error; it translates it with `formatUserMessage` and shows a toast. Mutations with `meta.silent` (the form's) are skipped because they render their errors inline. Mutation errors never replace the page; the UI doc routes failed *page loads* to error screens instead.
- **`i18n` is the default i18next instance**, the one `src/i18n` initialises, imported directly because this code runs outside components, where `useTranslation` isn't available.
- **`StrictMode` stays on.** In development it runs every effect twice to expose missing cleanup. The log hook below is written to handle that.

### `src/app/router.tsx`

```tsx
import { createBrowserRouter } from "react-router";

export const router = createBrowserRouter([
  { path: "projects", lazy: () => import("@/features/projects/ProjectListPage") },
  { path: "new", lazy: () => import("@/features/projects/NewProjectPage") },
  { path: "projects/:id", lazy: () => import("@/features/projects/ProjectPage") },
  { path: "deployments/:id", lazy: () => import("@/features/deployments/DeploymentPage") },
]);
```

- **`lazy` loads each page as its own chunk** the first time its route is visited, so the first load doesn't download every page. Each page module exports its component as `Component`, React Router's convention for lazy routes.
- **This is the minimal route table.** [UI implementation §4.2](ui-implementation.md#42-routes--approuterts) wraps these routes in layouts and adds the landing page at `/`, the auth pages (Phase 3), error elements and the `*` 404.

### `src/stores/logStore.ts`

The Zustand store holding the build log of each deployment being viewed.

```ts
import { create } from "zustand";

/** One log line as it arrives: its index in the deployment's log, and its text. */
export interface LogEntry { id: number; line: string }

interface DeploymentLog {
  lines: string[];
  /** Index of the last line stored; any line at or below it is a repeat. */
  lastId: number;
}

interface LogStore {
  logs: Record<string, DeploymentLog>;
  /** Adds new lines to a deployment's log, dropping any already stored. */
  append: (deploymentId: string, entries: LogEntry[]) => void;
  /** Forgets a deployment's log, e.g. when nobody is viewing it any more. */
  clear: (deploymentId: string) => void;
}

const EMPTY: DeploymentLog = { lines: [], lastId: -1 };

export const useLogStore = create<LogStore>()(set => ({
  logs: {},
  append: (deploymentId, entries) =>
    set(state => {
      const log = state.logs[deploymentId] ?? EMPTY;
      const added: string[] = [];
      let lastId = log.lastId;
      for (const entry of entries) {
        if (entry.id <= lastId) continue;           // already have it (reconnect or replay overlap)
        lastId = entry.id;
        added.push(entry.line);
      }
      if (added.length === 0) return state;          // nothing new: no update, no re-render
      return { logs: { ...state.logs, [deploymentId]: { lines: log.lines.concat(added), lastId } } };
    }),
  clear: deploymentId =>
    set(state => {
      const logs = { ...state.logs };
      delete logs[deploymentId];
      return { logs };
    }),
}));

const NO_LINES: string[] = [];

/** The lines received so far for one deployment. Re-renders only when that deployment's log changes. */
export const useLogLines = (deploymentId: string) =>
  useLogStore(state => state.logs[deploymentId]?.lines ?? NO_LINES);
```

- **Logs are stored per deployment id.** `logs["abc"]` and `logs["xyz"]` can't mix, so a page showing one deployment never sees another's lines, even for a moment while switching between them.
- **De-duplication is part of `append`.** Each line's id is its index in the log, and ids only increase, so any id at or below `lastId` is a repeat. Repeats happen in three ways: the subscribe-first fix from Step 1 can deliver a line twice, an `EventSource` reconnect can overlap lines already received, and React Strict Mode opens the stream twice in development. Doing it in the store means every way lines get in goes through the same check.
- **Updates are immutable.** `append` builds a new `lines` array (`concat`) and a new `logs` object instead of pushing into the existing ones. Zustand compares a selector's result with `Object.is`; mutating the old array in place would leave the reference unchanged, and no component would re-render.
- **Returning `state` unchanged skips the update.** When every line in a batch is a repeat, nothing is set and no subscriber re-renders.
- **`clear` frees memory.** A build log can have tens of thousands of lines. The stream hook clears a deployment's log when the page closes; coming back replays it from Redis, which is fast.
- **`useLogLines` returns the same empty array every time** (`NO_LINES`) when there's no log yet. A selector must return a stable reference when nothing changed: `?? []` would create a new array on every call, Zustand would see a "change" on every check, and React would loop with "Maximum update depth exceeded". For the same reason, derive values such as `lines.slice(-20)` in the component after selecting, not inside the selector (or wrap the selector in Zustand's `useShallow`).
- **Actions live in the store but are read with `getState()` in effects.** The stream hook calls `useLogStore.getState().append(...)` instead of subscribing to the actions, so the hook never re-renders because of the store.

### `src/hooks/useLogStream.ts`

Opens the SSE stream for one deployment. Lines go into the log store; status changes go into the query cache.

```ts
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { qk } from "@/api/queries";
import type { DeploymentDetail, DeploymentStatus } from "@/api/types";
import { useLogStore, type LogEntry } from "@/stores/logStore";

/** Streams a deployment's build log into the log store. Read the lines with `useLogLines(deploymentId)`. */
export function useLogStream(deploymentId: string | null) {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!deploymentId) return;
    const { append, clear } = useLogStore.getState();

    // Lines are collected here and written to the store at most once per animation frame.
    const pending: LogEntry[] = [];
    let frame = 0;
    const flush = () => { frame = 0; append(deploymentId, pending.splice(0)); };

    // Opened for finished builds too: the server replays their log, then sends `done`.
    const events = new EventSource(api.logsUrl(deploymentId), { withCredentials: true });
    // EventSource sends Last-Event-ID automatically on reconnect; the id is the line index.
    events.onmessage = event => {
      pending.push({ id: Number(event.lastEventId), line: event.data });
      frame ||= requestAnimationFrame(flush);
    };
    events.addEventListener("status", event => {
      const status = (event as MessageEvent).data as DeploymentStatus;
      queryClient.setQueryData<DeploymentDetail>(qk.deployment(deploymentId), prev => prev && { ...prev, status });
    });
    events.addEventListener("done", () => {
      events.close();
      cancelAnimationFrame(frame);
      flush();
      // Refetch instead of setting the final status here: the row brings status, error code and finish time together.
      for (const queryKey of [qk.deployment(deploymentId), ["deployments"], ["project"], ["projects"]]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    });
    events.onerror = () => { /* EventSource retries by itself */ };

    return () => {
      events.close();
      cancelAnimationFrame(frame);
      clear(deploymentId);
    };
  }, [deploymentId, queryClient]);
}
```

- **The hook returns nothing.** Components read what they need with `useLogLines(id)` (the store) and `useDeployment(id)` (the query cache). The page that opens the stream doesn't have to be the component that reads it, and it doesn't re-render on every line.
- **`deploymentId` can be `null`**, for pages that don't know which deployment to show yet; hooks can't be called conditionally, so the hook is always called and does nothing until there's an id.
- **The stream is opened for every deployment, finished or not.** For a finished build the server replays the whole log (from Redis, or from `_logs.txt` once Redis has expired it) and then sends `done`. The hook doesn't need to know up front whether the build is over, and the same code shows a live build and one from last week.
- **Lines are batched per animation frame.** An `npm install` can send hundreds of lines a second. Writing each to the store would re-render the log view hundreds of times a second. Instead, lines collect in `pending`, and `requestAnimationFrame` schedules one `append` before the next paint (about every 16 ms). `frame ||= ...` schedules only if no flush is pending. `pending.splice(0)` takes everything collected and empties the array in one step.
- **`status` events update the query cache.** `setQueryData` patches the cached deployment row, so the badge and step tracker move the moment the worker changes stage, with no refetch. `prev && ...` leaves the cache alone if the row hasn't loaded yet; the first fetch will bring the current status anyway.
- **`done` refetches instead of setting the final status.** When a build fails, the row gains `errorCode`, `errorParams` and `finishedAt` along with the status. Setting `status: "failed"` locally would show the failure box before its error code had arrived (for up to 3 s, until the next poll), with a generic message. Invalidating the deployment refetches the whole row, so status and error appear together. It also refreshes the history, the project (whose live deployment may have changed) and the project list, which show this build's status. Prefix keys such as `["deployments"]` match those queries for every project; only the ones on screen refetch now, the rest when next shown.
- **On `done`, everything pending is written before the stream closes** (`cancelAnimationFrame` + `flush`), so the last lines aren't lost to a cancelled frame. Closing on `done` is essential: otherwise `EventSource` would treat the server ending the response as a dropped connection and reconnect every few seconds forever.
- **`onerror` does nothing on purpose.** On a network error `EventSource` waits (about 3 s by default) and reconnects by itself, sending `Last-Event-ID` so the server resumes where it left off; the store drops any overlap.
- **`withCredentials: true`** is `EventSource`'s version of `credentials: "include"`: it sends cookies cross-origin (needed from Phase 3).
- **Cleanup closes the stream, cancels a pending flush and clears the log.** It runs when the page closes or `deploymentId` changes. In development, Strict Mode runs effect → cleanup → effect: the first stream is closed and its log cleared, and the second replays from the start, so the log isn't doubled.

### `src/lib/format.ts`

```ts
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000], ["month", 2_592_000], ["week", 604_800], ["day", 86_400], ["hour", 3_600], ["minute", 60], ["second", 1],
];

/** "3 minutes ago", "yesterday", "il y a 2 heures": a past or future date relative to now, in the user's language. */
export function formatRelative(date: string | Date, locale: string, now = Date.now()) {
  const seconds = Math.round((new Date(date).getTime() - now) / 1000);
  const [unit, size] = UNITS.find(([, size]) => Math.abs(seconds) >= size) ?? ["second", 1];
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(Math.round(seconds / size), unit);
}
```

`Intl.RelativeTimeFormat` is built into every browser and translates the phrase itself ("3 minutes ago", "vor 3 Minuten"), so no date library is needed. The function picks the largest unit the difference reaches (a 90-minute-old build is "2 hours ago", not "90 minutes ago"); `numeric: "auto"` produces "yesterday" instead of "1 day ago". Pass `i18n.language` so it follows the dashboard's language, not just the browser's. `now` is a parameter so tests can fix the clock.

### `src/components/log/LogTerminal.tsx`

Renders a deployment's log in a terminal-style box, colour-coded by build step, and keeps it scrolled to the bottom unless the user is reading something further up.

```tsx
import { useEffect, useRef, useState } from "react";
import { useLogLines } from "@/stores/logStore";

const COLOR: Record<string, string> = { clone: "text-sky-400", detect: "text-violet-400", build: "text-zinc-200", warn: "text-amber-400", error: "text-red-400", upload: "text-emerald-400", promote: "text-emerald-400", done: "text-emerald-400", output: "text-zinc-400" };

export function LogTerminal({ deploymentId }: { deploymentId: string }) {
  const lines = useLogLines(deploymentId);
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, follow]);

  const onScroll = () => {
    const terminal = ref.current!;
    setFollow(terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 8);   // pause auto-scroll when the user scrolls up
  };

  return (
    <div className="relative">
      <pre ref={ref} onScroll={onScroll} className="h-128 overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5">
        {lines.map((line, i) => {
          const match = /^\[(\w+)\] (.*)$/.exec(line);
          const step = match?.[1] ?? "build", text = match?.[2] ?? line;
          return <div key={i} className={COLOR[step] ?? "text-zinc-300"}><span className="select-none text-zinc-600">{step.padEnd(7)}</span> {text}</div>;
        })}
      </pre>
      {!follow && <button onClick={() => setFollow(true)} className="absolute bottom-3 right-3 rounded bg-zinc-800 px-2 py-1 text-xs">Jump to bottom</button>}
    </div>
  );
}
```

- **It reads the lines from the store itself.** The page passes only the deployment id. When a batch of lines arrives, this component re-renders, and the page around it doesn't.
- **Follow mode is local state.** Only this component cares whether it's following, so it's `useState`, not the store. While `follow` is on, every new batch scrolls the box to the bottom, like `tail -f`. As soon as the user scrolls up to read an error, following stops, so new lines don't yank the view away. Scrolling back to the bottom, or clicking "Jump to bottom", turns it back on.
- **"At the bottom" allows 8 px of slack** (`scrollHeight - scrollTop - clientHeight < 8`). Browsers report fractional scroll positions on zoomed or high-DPI screens, so an exact `=== 0` check would often think the user is 0.5 px away from the bottom and stop following.
- **Each line is parsed back into step and text.** The worker stored it as `[step] text`; the regex splits it so the step can pick the colour and be shown as a fixed-width label (`padEnd(7)` lines the text up in a column). Lines that don't match are shown as build output.
- **The step label is `select-none`**, so copying a range of log lines copies the output without the labels.
- **`key={i}` is safe here**, even though index keys are usually discouraged: lines are only ever appended, never inserted or reordered, so index `i` always refers to the same line.
- **The terminal colours are fixed**, not theme tokens: the log stays dark in light mode too ([UI design](ui-design.md)). Very long logs (tens of thousands of lines) render slowly as plain DOM; the UI implementation doc memoises rows and virtualises the list above about 5,000 lines.

### `src/components/StatusBadge.tsx`

```tsx
import type { DeploymentStatus } from "@/api/types";
import { cn } from "@/lib/utils";

const STYLE: Record<DeploymentStatus, string> = {
  queued: "bg-zinc-700 text-zinc-200", cloning: "bg-sky-900 text-sky-200", detecting: "bg-violet-900 text-violet-200",
  building: "bg-amber-900 text-amber-200 animate-pulse", uploading: "bg-amber-900 text-amber-200",
  ready: "bg-emerald-900 text-emerald-200", failed: "bg-red-900 text-red-200", cancelled: "bg-zinc-800 text-zinc-400",
  archived: "bg-zinc-800 text-zinc-500",
};
export const StatusBadge = ({ status }: { status: DeploymentStatus }) =>
  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", STYLE[status])}>{status}</span>;
```

One status → one colour, used everywhere a status is shown (history table, deployment header, project cards), so a status looks the same on every page. Each pipeline step gets the same colour as its log lines in `LogTerminal`. `building` pulses because it's the long step, and the motion shows the build is still alive. The map is typed `Record<DeploymentStatus, string>`, so adding a status to the type without giving it a style is a compile error; that's how `archived` gets its muted grey. `cn` joins the classes (and merges conflicting Tailwind classes, if a caller ever passes its own).

### `src/features/projects/ProjectListPage.tsx`

All projects as cards, with search, sort and page numbers kept in the URL.

```tsx
import { Link, useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useProjects } from "@/api/queries";
import type { ProjectSort } from "@/api/types";
import { StatusBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";

const SORTS: ProjectSort[] = ["updated", "name", "created"];
const PAGE_SIZE = 12;

export function ProjectListPage() {
  const { i18n } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const page = Math.max(1, Number(searchParams.get("page")) || 1);
  const q = searchParams.get("q") || undefined;
  const sort = SORTS.find(option => option === searchParams.get("sort")) ?? "updated";
  const { data } = useProjects({ page, pageSize: PAGE_SIZE, q, sort });

  // Every control writes to the URL; changing search or sort goes back to page 1.
  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(changes)) if (value) next.set(key, value); else next.delete(key);
    setSearchParams(next);
  };
  if (!data) return null;
  const pageCount = Math.max(1, Math.ceil(data.total / data.pageSize));

  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <div className="flex items-center gap-3">
        <input key={q} defaultValue={q} placeholder="Search projects" className="flex-1 rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
          onKeyDown={event => event.key === "Enter" && update({ q: event.currentTarget.value.trim(), page: null })} />
        <select value={sort} onChange={event => update({ sort: event.target.value, page: null })} className="rounded border border-zinc-700 bg-zinc-900 px-2 py-2 text-sm">
          <option value="updated">Recently updated</option><option value="name">Name</option><option value="created">Newest</option>
        </select>
        <Link to="/new" className="rounded bg-white px-3 py-2 text-sm text-black">New project</Link>
      </div>
      <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.items.map(project => {
          const latest = project.deployments[0];
          return (
            <li key={project.id} className="rounded-lg border border-zinc-800 p-4 text-sm">
              <div className="flex items-center justify-between">
                <Link to={`/projects/${project.id}`} className="font-medium">{project.name}</Link>
                {latest && <StatusBadge status={latest.status} />}
              </div>
              <p className="mt-1 text-zinc-400">{latest ? `${latest.commitSha?.slice(0, 7) ?? "…"} · ${formatRelative(latest.createdAt, i18n.language)}` : "No deployments yet"}</p>
            </li>
          );
        })}
      </ul>
      {pageCount > 1 && (
        <nav className="flex items-center justify-between text-sm text-zinc-400">
          <span>Showing {(page - 1) * data.pageSize + 1}–{(page - 1) * data.pageSize + data.items.length} of {data.total}</span>
          <span className="space-x-3">
            <button disabled={page <= 1} onClick={() => update({ page: String(page - 1) })}>Previous</button>
            <button disabled={page >= pageCount} onClick={() => update({ page: String(page + 1) })}>Next</button>
          </span>
        </nav>
      )}
    </div>
  );
}

export { ProjectListPage as Component };
```

- **The URL is the source of truth.** `page`, `q` and `sort` are read from `?page=2&q=blog&sort=name`, not from `useState`. A refresh, a shared link or the back button shows the same list, and there's no second copy of the state to keep in sync. Every control writes to the URL with `update`, and the query key changes with it.
- **The search box is uncontrolled and keyed by `q`.** It submits on Enter. `key={q}` resets it when `q` changes from outside (back button, a link), which `defaultValue` alone wouldn't do.
- **URL values are untrusted input.** `?page=abc` becomes `1`, and an unknown `?sort=` falls back to `"updated"`, so a hand-edited URL can't send the API a value it rejects.
- **Changing search or sort resets to page 1** (`page: null` removes it). Page 3 of the old results may not exist in the new ones.
- **`keepPreviousData` (in `useProjects`)** keeps the current cards on screen while the next page loads.
- **Each card shows its latest build**, from the single deployment the API includes per project.
- **The pager is hidden on a single page.** The UI implementation doc replaces Previous/Next with numbered page links and debounces the search box so it searches as you type.

### `src/features/projects/NewProjectPage.tsx`

The "paste a repo URL and deploy" form. It detects the framework when the URL is entered, pre-fills the build settings, and on submit creates the project and jumps straight to its first build's live log.

```tsx
import { useState } from "react";
import { useNavigate } from "react-router";
import { useTranslation } from "react-i18next";
import { useCreateProject, useDetect } from "@/api/queries";
import type { ApiError } from "@/api/client";
import { formatUserMessage } from "@/i18n/formatMessage";

export function NewProjectPage() {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const [form, setForm] = useState({ repoUrl: "", branch: "main", rootDir: ".", slug: "", installCmd: "", buildCmd: "", outputDir: "", spaFallback: true });
  const set = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));
  const detect = useDetect();
  const create = useCreateProject();
  const detected = detect.data;
  const errorText = (error: Error) => formatUserMessage(i18n, error as ApiError, error.message);

  const runDetect = () => {
    if (!form.repoUrl) return;
    detect.mutate({ repoUrl: form.repoUrl, branch: form.branch, rootDir: form.rootDir }, {
      onSuccess: result => setForm(prev => ({ ...prev, installCmd: result.installCmd ?? "", buildCmd: result.buildCmd ?? "", outputDir: result.outputDir ?? "" })),
    });
  };
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate(
      { ...form, slug: form.slug || undefined, installCmd: form.installCmd || undefined, buildCmd: form.buildCmd || undefined, outputDir: form.outputDir || undefined },
      { onSuccess: created => navigate(created.deployment ? `/deployments/${created.deployment.id}` : `/projects/${created.project.id}`) },
    );
  };

  return (
    <form className="mx-auto max-w-xl space-y-4" onSubmit={submit}>
      <h1 className="text-xl font-semibold">New project</h1>
      <Field label="GitHub repository URL"><input value={form.repoUrl} onChange={set("repoUrl")} onBlur={runDetect} placeholder="https://github.com/owner/repo" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Branch"><input value={form.branch} onChange={set("branch")} /></Field>
        <Field label="Root directory"><input value={form.rootDir} onChange={set("rootDir")} /></Field>
      </div>
      {detect.isPending && <p className="text-sm text-zinc-400">Detecting framework…</p>}
      {detect.error && <p className="text-sm text-amber-400">{errorText(detect.error)}</p>}
      {detected && (
        <div className="rounded-lg border border-zinc-800 p-3 text-sm">
          <p>Detected <b>{detected.framework}</b> · {detected.packageManager} · Node {detected.nodeVersion}</p>
          {detected.warnings.map((warning, i) => <p key={i} className="mt-1 text-amber-400">⚠ {warning}</p>)}
        </div>
      )}
      <details className="rounded-lg border border-zinc-800 p-3" open={!!detected?.warnings.length}>
        <summary className="cursor-pointer text-sm">Build settings</summary>
        <div className="mt-3 space-y-3">
          <Field label="Install command"><input value={form.installCmd} onChange={set("installCmd")} placeholder="npm ci" /></Field>
          <Field label="Build command"><input value={form.buildCmd} onChange={set("buildCmd")} placeholder="npm run build" /></Field>
          <Field label="Output directory"><input value={form.outputDir} onChange={set("outputDir")} placeholder="dist" /></Field>
          <Field label="Subdomain (optional)"><input value={form.slug} onChange={set("slug")} placeholder="my-site" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.spaFallback} onChange={set("spaFallback")} /> Serve index.html for unknown routes (SPA)</label>
        </div>
      </details>
      {create.error && <p className="text-sm text-red-400">{errorText(create.error)}</p>}
      <button className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50" disabled={create.isPending}>Create & deploy</button>
    </form>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <label className="block text-sm"><span className="mb-1 block text-zinc-400">{label}</span><span className="[&>input]:w-full [&>input]:rounded [&>input]:border [&>input]:border-zinc-700 [&>input]:bg-zinc-900 [&>input]:px-3 [&>input]:py-2">{children}</span></label>;

export { NewProjectPage as Component };
```

- **The form is `useState`, not the store.** Only this page uses it, and it's thrown away when the page closes. All fields live in one `form` object, and `set("field")` returns the change handler for that field, which avoids nine `useState`s and nine near-identical handlers. It reads `checked` for checkboxes and `value` for everything else. The updater form `setForm(prev => ...)` is used so rapid changes never overwrite each other with a stale copy.
- **The detection result is read from the mutation (`detect.data`)**, not copied into a second `useState`. The mutation already holds its last result.
- **Detection runs on blur, not on every keystroke.** Each call clones a repo on the server; running it for `h`, `ht`, `htt`… would start dozens of clones. Leaving the URL field is a good signal the user has finished typing.
- **Callbacks are passed to `mutate`, not to the hook.** `useDetect()` and `useCreateProject()` are shared hooks without page-specific behaviour; what to do on success (fill the form, navigate) belongs to this page, so it's passed per call.
- **A successful detection overwrites the build fields.** That's what the user wants the first time. If they then edit a command and blur the URL field again, their edit is replaced; a polished version only fills fields the user hasn't touched.
- **Both errors are shown inline.** A failed detection (bad URL, unknown branch) appears under the URL field, a failed creation (slug taken) above the button. Both mutations are `silent`, so the global toast doesn't repeat them. A detection failure is amber, not red: the user can still fill the settings in by hand and deploy.
- **Warnings open the build settings.** The settings are collapsed by default, since detection is right most of the time. When there's a warning (e.g. a Next.js app without static export), the section opens so the user sees the fields they probably need to change.
- **Empty fields are sent as `undefined`, not `""`.** An omitted field means "decide for me": the API leaves it unset and the worker runs detection again at build time. An empty string would be saved as a real command and break the build.
- **After creating, go to the log.** If the API queued a first build, the user lands on its deployment page and watches it live; otherwise on the project page.
- **`Field`** wraps each input in a `<label>` (clicking the text focuses the input, and screen readers announce it), and styles the input through Tailwind's `[&>input]` child selector so each `<input>` doesn't repeat the same classes.

### `src/features/deployments/DeploymentPage.tsx`

One deployment: its commit, a step-by-step progress bar, the live log, and on completion either the error or the links to the site.

```tsx
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useDeployment } from "@/api/queries";
import { isTerminal, type DeploymentDetail } from "@/api/types";
import { LogTerminal } from "@/components/log/LogTerminal";
import { StatusBadge } from "@/components/StatusBadge";
import { useLogStream } from "@/hooks/useLogStream";
import { formatUserMessage } from "@/i18n/formatMessage";
import { useLogLines } from "@/stores/logStore";

const STEPS = ["queued", "cloning", "detecting", "building", "uploading", "ready"];
const BASE = import.meta.env.VITE_BASE_DOMAIN ?? "localhost";

export function DeploymentPage() {
  const { id = "" } = useParams();
  const { data: deployment } = useDeployment(id);
  useLogStream(id || null);
  if (!deployment) return null;

  const { status } = deployment;
  const stepIdx = STEPS.indexOf(status);
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <Link to={`/projects/${deployment.projectId}`} className="text-sm text-zinc-400">← {deployment.project.slug}</Link>
          <h1 className="font-mono text-lg">{deployment.commitSha?.slice(0, 7) ?? "…"} <span className="text-zinc-400">{deployment.commitMsg}</span></h1>
        </div>
        <StatusBadge status={status} />
      </div>

      <ol className="flex gap-2 text-xs">
        {STEPS.map((step, i) => <li key={step} className={`rounded px-2 py-1 ${i < stepIdx ? "bg-emerald-950 text-emerald-300" : i === stepIdx ? "bg-zinc-700" : "bg-zinc-900 text-zinc-500"}`}>{step}</li>)}
      </ol>

      {status === "failed" && <BuildFailedAlert deployment={deployment} />}
      {status === "ready" && (
        <p className="text-sm">Preview: <a className="underline" href={`https://${deployment.id}.${BASE}`} target="_blank">{deployment.id}.{BASE}</a> · Live: <a className="underline" href={`https://${deployment.project.slug}.${BASE}`} target="_blank">{deployment.project.slug}.{BASE}</a></p>
      )}
      <LogTerminal deploymentId={deployment.id} />
      {isTerminal(status) && <p className="text-xs text-zinc-500">Build finished.</p>}
    </div>
  );
}

function BuildFailedAlert({ deployment }: { deployment: DeploymentDetail }) {
  const { i18n } = useTranslation();
  const lines = useLogLines(deployment.id);
  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm">
      <p className="font-medium text-red-300">{formatUserMessage(i18n, { code: deployment.errorCode, params: deployment.errorParams }, deployment.error)}</p>
      <pre className="mt-2 max-h-40 overflow-auto text-xs text-red-200/80">{lines.slice(-20).join("\n")}</pre>
    </div>
  );
}

export { DeploymentPage as Component };
```

- **The page has one status: the query's.** `deployment.status` comes from the query cache, which the stream hook keeps current (`setQueryData` on each `status` event, a refetch on `done`). There's no separate "live status" to reconcile with the polled one.
- **The stream opens at once, in parallel with the query.** `useLogStream(id)` takes the id from the URL, so the log starts loading without waiting for the deployment row. Switching to another deployment changes `id`; the hook closes the old stream and clears its log, and `LogTerminal` reads the new deployment's lines from the store. No `key` remount is needed.
- **The page doesn't re-render per log line.** It never reads the lines itself; `LogTerminal` and `BuildFailedAlert` subscribe to the store on their own. During a build, only those two update as lines arrive; the header and step tracker update only when the status changes.
- **The failure box shows the reason and the last 20 lines.** The translated error code says *what* failed ("the build command exited with code 1"); the last lines of output almost always say *why*. Because `done` refetches the row before the page sees `failed`, the error code is already there when the box first appears. `lines.slice(-20)` is computed here, after the selector, per the stable-selector rule in `logStore.ts`.
- **Hooks come before the early `return`.** React requires hooks to run in the same order on every render, so `useDeployment` and `useLogStream` are called even while the deployment is loading, and `return null` comes after them.
- **The step indicator** finds the current status in `STEPS` and colours earlier steps as done, the current one as active, later ones as pending. For `failed`, `cancelled` and `archived` (not in the list) `indexOf` returns `-1`, so every step appears pending; the UI doc's `StepTracker` marks the stage that failed in red.
- **A ready build shows two links.** The preview URL (`<deploymentId>.<domain>`) always serves exactly this build. The live URL (`<slug>.<domain>`) serves whatever is currently promoted, which may be a different deployment.

### `src/features/projects/ProjectPage.tsx` (history + promote/rollback)

A project's deployment history, with "Deploy now", and a Promote or Rollback button on every `ready` deployment that isn't live.

```tsx
import { Link, useParams } from "react-router";
import { useTranslation } from "react-i18next";
import { useDeploy, useDeployments, useProject, usePromote } from "@/api/queries";
import { StatusBadge } from "@/components/StatusBadge";
import { formatRelative } from "@/lib/format";

export function ProjectPage() {
  const { i18n } = useTranslation();
  const { id = "" } = useParams();
  const { data: project } = useProject(id);
  const history = useDeployments(id);
  const deploy = useDeploy(id);
  const promote = usePromote(id);
  if (!project) return null;

  const live = project.activeDeployment;
  const rows = history.data?.pages.flatMap(page => page.items) ?? [];
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">{project.name}</h1><p className="text-sm text-zinc-400">{project.repoUrl} · {project.branch} · {project.deploymentCount} deployments</p></div>
        <button onClick={() => deploy.mutate()} disabled={deploy.isPending} className="rounded bg-white px-3 py-1.5 text-sm text-black disabled:opacity-50">Deploy now</button>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {rows.map(deployment => {
            const isLive = deployment.id === live?.id;
            const isOlder = !!live && new Date(deployment.createdAt) < new Date(live.createdAt);
            return (
              <tr key={deployment.id} className="border-t border-zinc-800">
                <td className="py-2"><Link to={`/deployments/${deployment.id}`} className="font-mono">{deployment.commitSha?.slice(0, 7) ?? deployment.id.slice(0, 7)}</Link><span className="ml-2 text-zinc-400">{deployment.commitMsg}</span></td>
                <td><StatusBadge status={deployment.status} /></td>
                <td className="text-zinc-400">{formatRelative(deployment.createdAt, i18n.language)}</td>
                <td className="text-right">
                  {isLive ? <span className="text-xs text-emerald-400">● live</span>
                    : deployment.status === "ready" && (
                      <button onClick={() => promote.mutate(deployment.id)} disabled={promote.isPending} className="text-xs underline disabled:opacity-50">
                        {isOlder ? "Rollback to this" : "Promote"}
                      </button>
                    )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {history.hasNextPage && (
        <button onClick={() => history.fetchNextPage()} disabled={history.isFetchingNextPage} className="text-sm underline disabled:opacity-50">Load more</button>
      )}
    </div>
  );
}

export { ProjectPage as Component };
```

- **Two queries with different lifetimes.** The project (name, repo, which deployment is live) rarely changes. The history changes whenever a build starts or progresses, so it polls (see `useDeployments`). Keeping them separate means the frequent refetch only re-downloads the list.
- **"Rollback to this" vs "Promote" compares creation times.** `GET /projects/:id` now returns `activeDeployment` with its `createdAt` (Step 3). A row created before the live deployment is older, so making it live is a rollback; anything newer is a promotion. Both call the same endpoint; only the label differs. Comparing creation with creation (not with the live build's `finishedAt`) orders builds by when they started, which is how the history is sorted.
- **Which button a row gets.** The live deployment shows "● live". Any other `ready` deployment can be made live. `failed`, `archived` and in-progress deployments get no button, matching the API's `409`.
- **Buttons are disabled while their request runs**, so a double click can't start two builds or send two promotions.
- **Failures appear as toasts** from the `MutationCache` in `provider.tsx`. If Promote fails (the deployment was deleted in another tab, say), the user sees why instead of a button that silently did nothing.
- **"Load more" fetches the next page of history.** `history.data.pages` holds every page fetched so far; `flatMap` joins them into one list. `hasNextPage` is false once the API returns `next: null`.
- **Each row links to its deployment page**, so any old build's log is one click away (served from `_logs.txt` once Redis has expired it). The SHA is the label; the deployment id stands in until the clone step has recorded the SHA.

### CORS

The dashboard runs on `app.localhost`, the API on `api.localhost`. Add to `apps/api/src/index.ts`:

```ts
import cors from "cors";
app.use(cors({ origin: [`https://app.${env.BASE_DOMAIN}`, "http://localhost:5173"], credentials: true }));
```

- **Why it's needed.** A browser treats different subdomains as different *origins*, and by default blocks a page on one origin from reading responses from another. CORS headers are the API telling the browser "responses may be read by these origins".
- **An explicit list, not `*`.** With `credentials: true` (cookies), the CORS spec forbids the wildcard; the server must name each allowed origin. It's also the safer choice: once Phase 3 adds login cookies, only the real dashboard can make requests that carry them and read the answers.
- **`http://localhost:5173`** is Vite's dev server, for running the dashboard outside Docker with hot reload.
- **Register it before the routers**, so `OPTIONS` preflight requests are answered before they reach a route. The dashboard sends `content-type: application/json` on every request, which makes each one "non-simple" and triggers a preflight; `cors` answers those automatically. Pass `maxAge: 600` to let the browser cache the preflight result instead of repeating it for every call.

---

## Step 5 — Router: direct preview by deployment id

Already handled in Phase 1's `resolveHost` (CUID label → deployment). Verify that a preview URL keeps working after a newer deployment is promoted — it must, since prefixes are immutable.

Why this holds: the router resolves `<deploymentId>.<domain>` by looking the deployment up directly (not through the project's pointer), and serves `deployments/<id>/` from storage. No later build ever writes into another deployment's prefix, and promotion only changes `activeDeploymentId`. So a preview link sent to a reviewer shows exactly that build for as long as the deployment exists, while the project's main URL moves forward. Previews aren't cached in Redis, so deleting a deployment takes its preview down on the next request.

---

## Checklist

Each item tests one of the guarantees above:

- [ ] Log lines appear live; step prefixes are colour-coded — *the replay + subscribe path and the `[step]` parsing work end to end.*
- [ ] Kill the API mid-stream (`docker compose restart api`) — the browser reconnects and no line is duplicated or lost — *`EventSource` sends `Last-Event-ID`, the server resumes from the list index, and the client drops repeats.*
- [ ] Open a finished deployment after `redis-cli DEL logs:<id>` — logs load from `_logs.txt` — *the worker archived the log, and the endpoint falls back to storage when Redis has nothing.*
- [ ] Detect endpoint pre-fills fields and shows the Next.js `output: 'export'` warning on a non-export Next repo — *detection runs from the shared package in the API and its warnings reach the form.*
- [ ] A failing build shows the translated error at the same moment the status turns `failed`, never a generic message first — *`done` refetches the row instead of setting the status locally.*
- [ ] Switching between two deployments' pages never shows the other's log lines — *the log store is keyed by deployment id and cleared when the stream closes.*
- [ ] Project list: search, sort and page are in the URL, survive a refresh, and "Showing x–y of z" matches the data — *`GET /projects` pagination and URL-driven state.*
- [ ] The history labels rows older than the live deployment "Rollback to this" and newer ones "Promote" — *`GET /projects/:id` returns `activeDeployment.createdAt`.*
- [ ] Promote an older deployment → live site changes on next request (cache invalidated), no rebuild — *promotion only moves the pointer and clears `route:v2:<slug>`.*
- [ ] Make a promote fail (delete the deployment from another tab first) → an error toast appears — *the `MutationCache` handler.*
- [ ] Deleting the active deployment returns 409 — *the API refuses to take a live site offline by accident.*
