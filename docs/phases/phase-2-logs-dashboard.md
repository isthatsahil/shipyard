# Phase 2 — Live Logs, Dashboard, History

**Goal:** a browser UI where you paste a repo URL, watch the build stream live, and promote/rollback deployments.
**Time:** ~1 week.
**Done when:** log lines appear in the browser within ~200 ms of the container printing them; an SSE reconnect resumes without duplicates; rollback flips the live site in one click without a rebuild.

Prerequisite: [Phase 1](phase-1-pipeline.md).

---

## Step 1 — SSE log endpoint (API)

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

Mount it in `index.ts`: `app.use("/deployments", logs)` alongside the existing deployments router.

A small race exists between the `LRANGE` replay and `SUBSCRIBE`: a line published in that gap is missed. Close it by subscribing first, buffering messages, then replaying and discarding buffered lines whose index is below `index`. It's a few extra lines; do it once the basic flow works.

### Worker: archive the log on completion

In `apps/worker/src/pipeline/index.ts`, inside `finally` before the `rm`:

```ts
const all = await logger.all();
await storage.put(logsKey(deployment.storagePrefix), Buffer.from(all.join("\n")), { contentType: "text/plain" }).catch(() => {});
```

---

## Step 2 — Detect endpoint (API)

Pre-fills the "new project" form. Shallow-clones into a temp dir on the API host and runs `detectFramework` — it does **not** run any user code (detection is pure file reads).

Move `apps/worker/src/detect/` to `packages/shared/src/detect/` so both API and worker import it. Then:

- add `"./detect": "./src/detect/index.ts"` to the `exports` of `packages/shared/package.json` (one entry per module; see Phase 0);
- in the worker, change the `../detect/index.js` imports in `pipeline/detect.ts` and `pipeline/resolveOutput.ts` to `@shipyard/shared/detect`;
- move the detection unit tests along with it and fix their fixture path (one directory shallower).

### `apps/api/src/routes/detect.ts`

```ts
import { Router } from "express";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { detectFramework } from "@shipyard/shared/detect";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl } from "../services/projects.js";

export const detect = Router();

detect.post("/", validate(z.object({ repoUrl: z.string(), branch: z.string().default("main"), rootDir: z.string().default(".") })), async (req, res) => {
  const { url } = normaliseRepoUrl(req.body.repoUrl);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "detect-"));
  try {
    await Promise.race([
      simpleGit().clone(url, dir, ["--depth", "1", "--branch", req.body.branch, "--single-branch", "--filter=blob:limit=256k"]),
      new Promise((_, rej) => setTimeout(() => rej(new Error("clone timed out")), 20_000)),
    ]).catch(() => {
      // git's message can echo the URL; send only the code.
      throw new HttpError(400, "pipeline.clone_failed", { branch: req.body.branch });
    });
    const root = path.resolve(dir, req.body.rootDir);
    // `+ path.sep`: a bare prefix check lets "../detect-abcX" into a sibling temp dir.
    if (root !== dir && !root.startsWith(dir + path.sep)) throw new HttpError(400, "api.invalid_root_dir");
    res.json(detectFramework(root));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
```

`--filter=blob:limit=256k` keeps large-asset repos fast; detection only needs config files.

---

## Step 3 — History, promote, rollback, delete (API)

### Additions to `apps/api/src/routes/projects.ts`

```ts
projects.get("/", async (_req, res) => {
  const list = await prisma.project.findMany({
    orderBy: { updatedAt: "desc" },
    include: { activeDeployment: { select: { id: true, status: true, commitSha: true, finishedAt: true } },
               deployments: { orderBy: { createdAt: "desc" }, take: 1, select: { status: true, createdAt: true } } },
  });
  res.json(list);
});

const DeploymentsPage = z.object({ cursor: z.string().optional() });

projects.get("/:id/deployments", validate(DeploymentsPage, "query"), async (req, res) => {
  const take = 20;
  const { cursor } = req.query as z.infer<typeof DeploymentsPage>;
  const rows = await prisma.deployment.findMany({
    where: { projectId: req.params.id },
    orderBy: { createdAt: "desc" },
    take: take + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const next = rows.length > take ? rows.pop()!.id : null;
  res.json({ items: rows.map(row => ({ ...r, sizeBytes: row.sizeBytes?.toString() ?? null })), next });
});

projects.delete("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id }, include: { deployments: { select: { storagePrefix: true } } } });
  if (!project) throw new HttpError(404, "api.not_found");
  await prisma.project.delete({ where: { id: project.id } });           // cascades deployments + domains
  await redis.del(keys.route(project.slug));
  // Storage cleanup is best-effort and async; the retention job (Phase 5) catches stragglers.
  void Promise.all(project.deployments.map(deployment => storage.deletePrefix(deployment.storagePrefix)));
  res.status(204).end();
});
```

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
  if (!["ready", "failed", "cancelled"].includes(deployment.status)) throw new HttpError(409, "api.deployment_in_progress");
  await prisma.deployment.delete({ where: { id: deployment.id } });
  void storage.deletePrefix(deployment.storagePrefix);
  res.status(204).end();
});
```

Rollback is not a separate endpoint — the UI calls `promote` on an older row.

---

## Step 4 — Dashboard (`apps/web`)

Dependencies: `react-router-dom`, `@tanstack/react-query`, `clsx`, `date-fns`. Tailwind already set up in Phase 0.

**i18n.** All UI text goes through react-i18next (`src/i18n/`): `t("key")` for UI copy in `locales/<lng>/common.json`, and `formatUserMessage(i18n, { code, params }, fallback)` for anything the server sends (API errors and `deployment.errorCode`). Don't render `error.message` or `deployment.error` directly. Dates and sizes use `Intl.DateTimeFormat`/`Intl.NumberFormat` with `i18n.language`. The snippets below keep inline English for brevity; move each string into `common.json` when you build the page.

### `src/api.ts`

```ts
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
  code?: string;
  params?: Record<string, string | number>;
  constructor(public status: number, error?: { code: string; params?: Record<string, string | number>; message: string }) {
    super(error?.message ?? `HTTP ${status}`);
    this.code = error?.code;
    this.params = error?.params;
  }
}

export const api = {
  projects: () => req<Project[]>("/projects"),
  project: (id: string) => req<Project & { deployments: Deployment[] }>(`/projects/${id}`),
  createProject: (body: CreateProject) => req<{ project: Project; deployment: Deployment | null }>("/projects", { method: "POST", body: JSON.stringify(body) }),
  deleteProject: (id: string) => req<void>(`/projects/${id}`, { method: "DELETE" }),
  detect: (body: { repoUrl: string; branch?: string; rootDir?: string }) => req<DetectResult>("/detect", { method: "POST", body: JSON.stringify(body) }),
  deploy: (projectId: string) => req<Deployment>(`/projects/${projectId}/deployments`, { method: "POST" }),
  deployments: (projectId: string, cursor?: string) => req<{ items: Deployment[]; next: string | null }>(`/projects/${projectId}/deployments${cursor ? `?cursor=${cursor}` : ""}`),
  deployment: (id: string) => req<Deployment & { project: { slug: string } }>(`/deployments/${id}`),
  promote: (id: string) => req<void>(`/deployments/${id}/promote`, { method: "POST" }),
  logsUrl: (id: string) => `${BASE}/deployments/${id}/logs`,
};

export type DeploymentStatus = "queued" | "cloning" | "detecting" | "building" | "uploading" | "ready" | "failed" | "cancelled";
export interface Deployment { id: string; projectId: string; status: DeploymentStatus; commitSha: string | null; commitMsg: string | null; framework: string | null; error: string | null; errorCode: string | null; errorParams: Record<string, string | number> | null; createdAt: string; startedAt: string | null; finishedAt: string | null; fileCount: number | null; sizeBytes: string | null }
export interface Project { id: string; name: string; slug: string; repoUrl: string; branch: string; activeDeploymentId: string | null; activeDeployment?: Pick<Deployment, "id" | "status" | "commitSha" | "finishedAt"> | null; deployments?: Pick<Deployment, "status" | "createdAt">[] }
export interface DetectResult { framework: string; packageManager: string; installCmd: string | null; buildCmd: string | null; outputDir: string | null; nodeVersion: string; warnings: string[] }
export interface CreateProject { repoUrl: string; branch?: string; slug?: string; name?: string; rootDir?: string; installCmd?: string; buildCmd?: string; outputDir?: string; spaFallback?: boolean }
```

**If every request fails with "Failed to fetch":** the dashboard calls `https://api.localhost` in the background, and the browser rejects the certificate, because Caddy's local CA isn't trusted. Background requests (`fetch`, `EventSource`) never show the "proceed anyway" warning, so they just fail. Trust the CA once ([Phase 0 → Trusting the Caddy CA](phase-0-setup.md#trusting-the-caddy-ca)), or open `https://api.localhost` in a tab and accept the warning.

Keep `BASE` on Caddy's HTTPS URL rather than `http://localhost:4000`. Caddy serves HTTP/2, so every open log stream shares one connection. Over plain HTTP the browser allows about 6 connections per host, and a few open `EventSource`s leave no room for other requests, so the dashboard freezes.

### `src/hooks/useLogStream.ts`

```ts
import { useEffect, useRef, useState } from "react";

export function useLogStream(url: string | null, initialDone: boolean) {
  const [lines, setLines] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [done, setDone] = useState(initialDone);
  const seen = useRef(-1);

  useEffect(() => {
    if (!url || done) return;
    const events = new EventSource(url, { withCredentials: true });
    // EventSource sends Last-Event-ID automatically on reconnect; the id is the line index.
    events.onmessage = event => {
      const id = Number(event.lastEventId);
      if (!Number.isNaN(id) && id <= seen.current) return;   // de-dupe on reconnect
      seen.current = id;
      setLines(prev => [...prev, event.data]);
    };
    events.addEventListener("status", event => setStatus((event as MessageEvent).data));
    events.addEventListener("done", event => { setStatus((event as MessageEvent).data); setDone(true); events.close(); });
    events.onerror = () => { /* EventSource retries by itself */ };
    return () => events.close();
  }, [url, done]);

  return { lines, status, done };
}
```

### `src/components/LogTerminal.tsx`

```tsx
import { useEffect, useRef, useState } from "react";

const COLOR: Record<string, string> = { clone: "text-sky-400", detect: "text-violet-400", build: "text-zinc-200", warn: "text-amber-400", error: "text-red-400", upload: "text-emerald-400", promote: "text-emerald-400", done: "text-emerald-400", output: "text-zinc-400" };

export function LogTerminal({ lines }: { lines: string[] }) {
  const ref = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);

  useEffect(() => { if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight; }, [lines, follow]);

  const onScroll = () => {
    const terminal = ref.current!;
    setFollow(terminal.scrollHeight - terminal.scrollTop - terminal.clientHeight < 8);   // pause auto-scroll when the user scrolls up
  };

  return (
    <div className="relative">
      <pre ref={ref} onScroll={onScroll} className="h-[32rem] overflow-auto rounded-lg bg-zinc-950 p-4 font-mono text-xs leading-5">
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

### `src/components/StatusBadge.tsx`

```tsx
const STYLE: Record<string, string> = {
  queued: "bg-zinc-700 text-zinc-200", cloning: "bg-sky-900 text-sky-200", detecting: "bg-violet-900 text-violet-200",
  building: "bg-amber-900 text-amber-200 animate-pulse", uploading: "bg-amber-900 text-amber-200",
  ready: "bg-emerald-900 text-emerald-200", failed: "bg-red-900 text-red-200", cancelled: "bg-zinc-800 text-zinc-400",
};
export const StatusBadge = ({ status }: { status: string }) =>
  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[status] ?? ""}`}>{status}</span>;
```

### `src/pages/NewProject.tsx`

```tsx
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api, type ApiError, type DetectResult } from "../api";
import { formatUserMessage } from "../i18n/formatMessage";

export function NewProject() {
  const navigate = useNavigate();
  const { i18n } = useTranslation();
  const [form, setForm] = useState({ repoUrl: "", branch: "main", rootDir: ".", slug: "", installCmd: "", buildCmd: "", outputDir: "", spaFallback: true });
  const [detected, setDetected] = useState<DetectResult | null>(null);
  const set = (field: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...f, [field]: event.target.type === "checkbox" ? event.target.checked : event.target.value }));

  const detect = useMutation({
    mutationFn: () => api.detect({ repoUrl: form.repoUrl, branch: form.branch, rootDir: form.rootDir }),
    onSuccess: result => { setDetected(result); setForm(prev => ({ ...f, installCmd: result.installCmd ?? "", buildCmd: result.buildCmd ?? "", outputDir: result.outputDir ?? "" })); },
  });
  const create = useMutation({
    mutationFn: () => api.createProject({ ...form, slug: form.slug || undefined, installCmd: form.installCmd || undefined, buildCmd: form.buildCmd || undefined, outputDir: form.outputDir || undefined }),
    onSuccess: created => navigate(created.deployment ? `/deployments/${created.deployment.id}` : `/projects/${created.project.id}`),
  });

  return (
    <form className="mx-auto max-warning-xl space-y-4" onSubmit={event => { event.preventDefault(); create.mutate(); }}>
      <h1 className="text-xl font-semibold">New project</h1>
      <Field label="GitHub repository URL"><input value={form.repoUrl} onChange={set("repoUrl")} onBlur={() => form.repoUrl && detect.mutate()} placeholder="https://github.com/owner/repo" required /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Branch"><input value={form.branch} onChange={set("branch")} /></Field>
        <Field label="Root directory"><input value={form.rootDir} onChange={set("rootDir")} /></Field>
      </div>
      {detect.isPending && <p className="text-sm text-zinc-400">Detecting framework…</p>}
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
      {create.error && <p className="text-sm text-red-400">{formatUserMessage(i18n, create.error as ApiError, create.error.message)}</p>}
      <button className="rounded bg-white px-4 py-2 text-sm font-medium text-black disabled:opacity-50" disabled={create.isPending}>Create & deploy</button>
    </form>
  );
}

const Field = ({ label, children }: { label: string; children: React.ReactNode }) =>
  <label className="block text-sm"><span className="mb-1 block text-zinc-400">{label}</span><span className="[&>input]:w-full [&>input]:rounded [&>input]:border [&>input]:border-zinc-700 [&>input]:bg-zinc-900 [&>input]:px-3 [&>input]:py-2">{children}</span></label>;
```

### `src/pages/DeploymentPage.tsx`

```tsx
import { useParams, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../api";
import { formatUserMessage } from "../i18n/formatMessage";
import { useLogStream } from "../hooks/useLogStream";
import { LogTerminal } from "../components/LogTerminal";
import { StatusBadge } from "../components/StatusBadge";

const STEPS = ["queued", "cloning", "detecting", "building", "uploading", "ready"];
const BASE = import.meta.env.VITE_BASE_DOMAIN ?? "localhost";

export function DeploymentPage() {
  const { i18n } = useTranslation();
  const { id = "" } = useParams();
  const deploymentQuery = useQuery({ queryKey: ["deployment", id], queryFn: () => api.deployment(id), refetchInterval: query => (["ready", "failed", "cancelled"].includes(query.state.data?.status ?? "") ? false : 3000) });
  const deployment = deploymentQuery.data;
  const { lines, status: liveStatus, done } = useLogStream(deployment ? api.logsUrl(deployment.id) : null, !!deployment && ["ready", "failed", "cancelled"].includes(deployment.status));
  const status = liveStatus ?? deployment?.status ?? "queued";
  if (!deployment) return null;

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

      {status === "failed" && (
        <div className="rounded-lg border border-red-900 bg-red-950/40 p-3 text-sm">
          <p className="font-medium text-red-300">{formatUserMessage(i18n, { code: deployment.errorCode, params: deployment.errorParams }, deployment.error)}</p>
          <pre className="mt-2 max-h-40 overflow-auto text-xs text-red-200/80">{lines.slice(-20).join("\n")}</pre>
        </div>
      )}
      {status === "ready" && (
        <p className="text-sm">Preview: <a className="underline" href={`https://${deployment.id}.${BASE}`} target="_blank">{deployment.id}.{BASE}</a> · Live: <a className="underline" href={`https://${deployment.project.slug}.${BASE}`} target="_blank">{deployment.project.slug}.{BASE}</a></p>
      )}
      <LogTerminal lines={lines} />
      {done && <p className="text-xs text-zinc-500">Build finished.</p>}
    </div>
  );
}
```

### `src/pages/ProjectPage.tsx` (history + promote/rollback)

```tsx
import { useParams, Link } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { api } from "../api";
import { StatusBadge } from "../components/StatusBadge";

export function ProjectPage() {
  const { id = "" } = useParams();
  const queryClient = useQueryClient();
  const projectQuery = useQuery({ queryKey: ["project", id], queryFn: () => api.project(id) });
  const deployments = useQuery({ queryKey: ["deployments", id], queryFn: () => api.deployments(id), refetchInterval: 5000 });
  const deploy = useMutation({ mutationFn: () => api.deploy(id), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["deployments", id] }) });
  const promote = useMutation({ mutationFn: (deploymentId: string) => api.promote(deploymentId), onSuccess: () => queryClient.invalidateQueries({ queryKey: ["project", id] }) });
  const project = projectQuery.data;
  if (!project) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-xl font-semibold">{project.name}</h1><p className="text-sm text-zinc-400">{project.repoUrl} · {project.branch}</p></div>
        <button onClick={() => deploy.mutate()} className="rounded bg-white px-3 py-1.5 text-sm text-black">Deploy now</button>
      </div>
      <table className="w-full text-sm">
        <tbody>
          {deployments.data?.items.map(deployment => {
            const active = deployment.id === project.activeDeploymentId;
            return (
              <tr key={deployment.id} className="border-t border-zinc-800">
                <td className="py-2"><Link to={`/deployments/${deployment.id}`} className="font-mono">{deployment.commitSha?.slice(0, 7) ?? deployment.id.slice(0, 7)}</Link><span className="ml-2 text-zinc-400">{deployment.commitMsg}</span></td>
                <td><StatusBadge status={deployment.status} /></td>
                <td className="text-zinc-400">{formatDistanceToNow(new Date(deployment.createdAt))} ago</td>
                <td className="text-right">
                  {active ? <span className="text-xs text-emerald-400">● live</span>
                    : deployment.status === "ready" && <button onClick={() => promote.mutate(deployment.id)} className="text-xs underline">{new Date(deployment.createdAt) < new Date(project.activeDeployment?.finishedAt ?? 0) ? "Rollback to this" : "Promote"}</button>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
```

`src/pages/ProjectList.tsx` is a straightforward list of `api.projects()` rows with name, slug, last status and a "Visit" link; `src/main.tsx` wires `QueryClientProvider` and the four routes (`/`, `/new`, `/projects/:id`, `/deployments/:id`).

### CORS

The dashboard runs on `app.localhost`, the API on `api.localhost`. Add to `apps/api/src/index.ts`:

```ts
import cors from "cors";
app.use(cors({ origin: [`https://app.${env.BASE_DOMAIN}`, "http://localhost:5173"], credentials: true }));
```

---

## Step 5 — Router: direct preview by deployment id

Already handled in Phase 1's `resolveHost` (CUID label → deployment). Verify that a preview URL keeps working after a newer deployment is promoted — it must, since prefixes are immutable.

---

## Checklist

- [ ] Log lines appear live; step prefixes are colour-coded
- [ ] Kill the API mid-stream (`docker compose restart api`) — the browser reconnects and no line is duplicated or lost
- [ ] Open a finished deployment after `redis-cli DEL logs:<id>` — logs load from `_logs.txt`
- [ ] Detect endpoint pre-fills fields and shows the Next.js `output: 'export'` warning on a non-export Next repo
- [ ] Promote an older deployment → live site changes on next request (cache invalidated), no rebuild
- [ ] Deleting the active deployment returns 409
