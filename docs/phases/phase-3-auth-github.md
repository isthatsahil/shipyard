# Phase 3 — Auth, GitHub Integration, Env Vars

**Goal:** users log in with GitHub, pick repos (including private ones), and every push to the configured branch deploys automatically.
**Time:** ~1 week.
**Done when:** a push to a private repo produces a live deployment with no manual action; a forged webhook is rejected with 401; a project env var is visible inside the build.

Prerequisite: [Phase 2](phase-2-logs-dashboard.md).

---

## Step 1 — Secrets at rest

### `packages/shared/src/crypto.ts`

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";

function key(): Buffer {
  const encoded = process.env.ENCRYPTION_KEY;
  if (!encoded) throw new Error("ENCRYPTION_KEY missing");
  const buf = Buffer.from(encoded, "base64");
  if (buf.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes base64");
  return buf;
}

/** Returns base64(iv | tag | ciphertext). */
export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decrypt(blob: string): string {
  const packed = Buffer.from(blob, "base64");
  const iv = packed.subarray(0, 12), tag = packed.subarray(12, 28), ciphertext = packed.subarray(28);
  const decipher = createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
```

Add `"./crypto": "./src/crypto.ts"` to the `exports` of `packages/shared/package.json` (one entry per module; see Phase 0), then import it as `@shipyard/shared/crypto`.

Generate a key once: `openssl rand -base64 32` → `ENCRYPTION_KEY` in every service's env. Add `ENCRYPTION_KEY: z.string()` to the base env schema.

---

## Step 2 — GitHub OAuth

Create an OAuth App at github.com/settings/developers with callback `https://api.<domain>/auth/github/callback`. Env: `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `SESSION_COOKIE_DOMAIN` (`.localhost` in dev — note Chrome treats `localhost` specially; if cookies are dropped, use `lvh.me` for local dev instead), `WEB_URL`.

### `apps/api/src/lib/session.ts`

```ts
import { randomBytes } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { prisma, type User } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { redis, env } from "./clients.js";
import { HttpError } from "./httpError.js";

const TTL = 30 * 24 * 3600;
const COOKIE = "sid";

export async function createSession(res: Response, userId: string) {
  const sid = randomBytes(32).toString("base64url");
  await redis.set(keys.session(sid), userId, "EX", TTL);
  // secure: true everywhere, dev included: local dev is HTTPS through Caddy, so
  // there is no environment switch that could ship a weaker cookie to production.
  res.cookie(COOKIE, sid, { httpOnly: true, secure: true, sameSite: "lax", domain: env.SESSION_COOKIE_DOMAIN, maxAge: TTL * 1000, path: "/" });
}

export async function destroySession(req: Request, res: Response) {
  const sid = req.cookies?.[COOKIE];
  if (sid) await redis.del(keys.session(sid));
  res.clearCookie(COOKIE, { domain: env.SESSION_COOKIE_DOMAIN, path: "/" });
}

declare global { namespace Express { interface Request { user?: User } } }

export async function attachUser(req: Request, _res: Response, next: NextFunction) {
  const sid = req.cookies?.[COOKIE];
  if (sid) {
    const userId = await redis.get(keys.session(sid));
    if (userId) { req.user = (await prisma.user.findUnique({ where: { id: userId } })) ?? undefined; await redis.expire(keys.session(sid), TTL); }
  }
  next();
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  if (!req.user) return next(new HttpError(401, "api.unauthenticated"));
  next();
}

/** CSRF guard for cookie-authenticated mutating requests: Origin must match the dashboard. */
export function checkOrigin(req: Request, _res: Response, next: NextFunction) {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (origin && origin !== env.WEB_URL) return next(new HttpError(403, "api.bad_origin"));
  next();
}
```

### `apps/api/src/routes/auth.ts`

```ts
import { Router } from "express";
import { randomBytes } from "node:crypto";
import { prisma } from "@shipyard/db";
import { encrypt } from "@shipyard/shared/crypto";
import { env } from "../lib/clients.js";
import { createSession, destroySession } from "../lib/session.js";
import { HttpError } from "../lib/httpError.js";

export const auth = Router();
const SCOPES = "read:user repo";   // `repo` is required for private clones and webhook creation

auth.get("/github", (req, res) => {
  const state = randomBytes(16).toString("hex");
  res.cookie("oauth_state", state, { httpOnly: true, secure: true, sameSite: "lax", maxAge: 600_000 });
  const authorizeUrl = new URL("https://github.com/login/oauth/authorize");
  authorizeUrl.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", `${env.API_URL}/auth/github/callback`);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);
  res.redirect(authorizeUrl.toString());
});

auth.get("/github/callback", async (req, res) => {
  try {
    const { code, state } = req.query as Record<string, string>;
    if (!code || !state || state !== req.cookies?.oauth_state) throw new HttpError(400, "api.oauth_state_invalid");
    res.clearCookie("oauth_state");

    const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code }),
    });
    const { access_token } = await tokenRes.json() as { access_token?: string };
    if (!access_token) throw new HttpError(400, "api.oauth_token_failed");

    const githubUser = await (await fetch("https://api.github.com/user", { headers: { authorization: `Bearer ${access_token}` } })).json() as { id: number; login: string; avatar_url: string };
    const user = await prisma.user.upsert({
      where: { githubId: githubUser.id },
      update: { login: githubUser.login, avatarUrl: githubUser.avatar_url, accessToken: encrypt(access_token) },
      create: { githubId: githubUser.id, login: githubUser.login, avatarUrl: githubUser.avatar_url, accessToken: encrypt(access_token) },
    });
    await createSession(res, user.id);
    res.redirect(env.WEB_URL);
  } catch (err) {
    // The browser lands here from GitHub, so a failure redirects back to the
    // dashboard with a code instead of showing JSON. The one exception to
    // "only errorHandler writes error responses".
    if (!(err instanceof HttpError)) req.log.error({ err }, "github login failed");
    const code = err instanceof HttpError ? err.code : "api.oauth_token_failed";
    res.redirect(`${env.WEB_URL}/?error=${encodeURIComponent(code)}`);
  }
});

auth.get("/me", (req, res) => {
  if (!req.user) throw new HttpError(401, "api.unauthenticated");
  res.json({ id: req.user.id, login: req.user.login, avatarUrl: req.user.avatarUrl });
});
auth.post("/logout", async (req, res) => { await destroySession(req, res); res.status(204).end(); });
```

The dashboard reads `?error=` on load, shows it translated like any API error code (`t(code, { ns: "errors" })`), then removes it from the URL with `history.replaceState` so a refresh doesn't show it again. Ignore values that aren't in `MESSAGE_CODES`: anyone can craft the link.

Wire-up in `index.ts`: `cookie-parser`, then `attachUser`, `checkOrigin`, `app.use("/auth", auth)`, and `requireAuth` on `/projects`, `/deployments`, `/detect`, `/github`. Replace `prisma.user.findFirstOrThrow()` in the project create route with `req.user!.id`, and add `where: { userId: req.user!.id }` to every project/deployment query (a small `ownedProject(req, id)` helper that throws `new HttpError(404, "api.not_found")` keeps this consistent).

---

## Step 3 — GitHub API client & repo picker

### `apps/api/src/lib/github.ts`

```ts
import { decrypt } from "@shipyard/shared/crypto";
import type { User } from "@shipyard/db";

export function tokenFor(user: User) {
  if (!user.accessToken) throw new Error("no GitHub token");
  return decrypt(user.accessToken);
}

export async function githubFetch<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "content-type": "application/json", ...(init.headers ?? {}) },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new Error(`GitHub ${response.status}: ${body.message}`);
  return body as T;
}
```

### `apps/api/src/routes/github.ts`

```ts
import { Router } from "express";
import { githubFetch, tokenFor } from "../lib/github.js";
import { redis } from "../lib/clients.js";

export const github = Router();

github.get("/repos", async (req, res) => {
  const token = tokenFor(req.user!);
  const cacheKey = `ghrepos:${req.user!.id}`;
  let repos = JSON.parse((await redis.get(cacheKey)) ?? "null");
  if (!repos) {
    repos = (await githubFetch<any[]>(token, "/user/repos?sort=pushed&per_page=100&affiliation=owner,collaborator,organization_member"))
      .map(repo => ({ fullName: repo.full_name, url: repo.clone_url, private: repo.private, defaultBranch: repo.default_branch, pushedAt: repo.pushed_at }));
    await redis.set(cacheKey, JSON.stringify(repos), "EX", 60);
  }
  const search = String(req.query.q ?? "").toLowerCase();
  res.json(search ? repos.filter((repo: any) => repo.fullName.toLowerCase().includes(search)) : repos);
});

github.get("/repos/:owner/:repo/branches", async (req, res) => {
  const branches = await githubFetch<any[]>(tokenFor(req.user!), `/repos/${req.params.owner}/${req.params.repo}/branches?per_page=100`);
  res.json(branches.map(branch => branch.name));
});
```

The detect endpoint from Phase 2 also needs the token for private repos: inject it into the clone URL the same way `clone.ts` does.

### Worker: private clones

In `runPipeline`, after loading the deployment, include the user and decrypt at run time — the token never enters the queue payload or logs:

```ts
const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { project: { include: { user: true } } } });
ctx.gitToken = deployment.project.user.accessToken ? decrypt(deployment.project.user.accessToken) : undefined;
```

---

## Step 4 — Webhooks

### Register on project create — `apps/api/src/services/webhooks.ts`

```ts
import { randomBytes } from "node:crypto";
import { prisma, type Project, type User } from "@shipyard/db";
import { encrypt } from "@shipyard/shared/crypto";
import { githubFetch, tokenFor } from "../lib/github.js";
import { env } from "../lib/clients.js";

export async function registerWebhook(project: Project, user: User) {
  const secret = randomBytes(32).toString("hex");
  const { owner, repo } = parse(project.repoUrl);
  const hook = await githubFetch<{ id: number }>(tokenFor(user), `/repos/${owner}/${repo}/hooks`, {
    method: "POST",
    body: JSON.stringify({
      name: "web", active: true, events: ["push"],
      config: { url: `${env.API_URL}/webhooks/github`, content_type: "json", secret, insecure_ssl: "0" },
    }),
  });
  await prisma.project.update({ where: { id: project.id }, data: { webhookId: hook.id, webhookSecret: encrypt(secret) } });
}

export async function removeWebhook(project: Project, user: User) {
  if (!project.webhookId) return;
  const { owner, repo } = parse(project.repoUrl);
  await githubFetch(tokenFor(user), `/repos/${owner}/${repo}/hooks/${project.webhookId}`, { method: "DELETE" }).catch(() => {});
}

function parse(url: string) { const [, owner, repo] = /github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url)!; return { owner, repo }; }
```

Call `registerWebhook` from the project create route (wrapped in try/catch — a failure to register shouldn't fail project creation; store `webhookId = null` and show a "webhook not installed" notice with a manual URL + secret in the UI). Call `removeWebhook` on project delete.

### Receive — `apps/api/src/routes/webhooks.ts`

```ts
import { Router, raw } from "express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@shipyard/db";
import { decrypt } from "@shipyard/shared/crypto";
import { createDeployment } from "../services/deployments.js";
import { HttpError } from "../lib/httpError.js";

export const webhooks = Router();

// Raw body is required for signature verification — mount BEFORE express.json().
webhooks.post("/github", raw({ type: "application/json", limit: "2mb" }), async (req, res) => {
  const signature = req.headers["x-hub-signature-256"];
  const event = req.headers["x-github-event"];
  if (typeof signature !== "string" || event !== "push") return res.status(202).end();

  const payload = JSON.parse(req.body.toString("utf8"));
  const repoUrl = `${payload.repository?.html_url}.git`;
  const candidates = await prisma.project.findMany({ where: { repoUrl, webhookSecret: { not: null } } });

  const project = candidates.find(candidate => {
    const expected = "sha256=" + createHmac("sha256", decrypt(candidate.webhookSecret!)).update(req.body).digest("hex");
    return expected.length === signature.length && timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  });
  if (!project) throw new HttpError(401, "api.webhook_signature_invalid");

  if (payload.deleted || payload.ref !== `refs/heads/${project.branch}`) return res.status(202).json({ skipped: true });

  const deployment = await createDeployment(project.id, { commitSha: payload.after, commitMsg: payload.head_commit?.message?.split("\n")[0] });
  res.status(201).json({ deploymentId: deployment.id });
});
```

In `index.ts`, mount `app.use("/webhooks", webhooks)` **before** `express.json()` and without `requireAuth`/`checkOrigin`.

Testing locally: GitHub can't reach `api.localhost`. Use a tunnel (`cloudflared tunnel --url http://localhost:4000` or `ngrok`) and set `API_URL` to the tunnel URL while developing this step, or replay a saved payload with `curl` and a computed signature:

```bash
SECRET=...; BODY=$(cat payload.json)
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | cut -d' ' -f2)"
curl -X POST http://localhost:4000/webhooks/github -H "content-type: application/json" -H "x-github-event: push" -H "x-hub-signature-256: $SIG" -d "$BODY"
```

---

## Step 5 — Env vars and Node version

### API — `apps/api/src/routes/projects.ts` additions

```ts
const EnvVar = z.object({ key: z.string().regex(/^[A-Z_][A-Z0-9_]*$/), value: z.string().max(32_000) });

projects.put("/:id/env", validate(z.array(EnvVar).max(100)), async (req, res) => {
  const project = await ownedProject(req, req.params.id);
  await prisma.project.update({ where: { id: project.id }, data: { envVars: encrypt(JSON.stringify(req.body)) } });
  res.json({ ok: true, count: req.body.length });
});

projects.get("/:id/env", async (req, res) => {
  const project = await ownedProject(req, req.params.id);
  const vars: { key: string; value: string }[] = project.envVars ? JSON.parse(decrypt(project.envVars)) : [];
  res.json(vars);   // dashboard masks values client-side; reveal on click
});

projects.patch("/:id", validate(z.object({ branch: z.string().optional(), installCmd: z.string().nullable().optional(), buildCmd: z.string().nullable().optional(),
  outputDir: z.string().nullable().optional(), nodeVersion: z.enum(["20", "22", "24"]).optional(), spaFallback: z.boolean().optional(), rootDir: z.string().optional() })),
  async (req, res) => {
    const project = await ownedProject(req, req.params.id);
    res.json(await prisma.project.update({ where: { id: project.id }, data: req.body }));
  });
```

### Worker

In `runPipeline`:

```ts
ctx.envVars = deployment.project.envVars
  ? (JSON.parse(decrypt(deployment.project.envVars)) as { key: string; value: string }[]).map(envVar => `${envVar.key}=${envVar.value}`)
  : [];
```

`build.ts` already passes `ctx.envVars` into the container `Env`. Never log them — the `[build] $ cmd` line prints only the command.

Build the extra images: `pnpm builder:build:all` (node20 and node24; node22 is already built in Phase 0). `build.ts` picks the tag from `detect.nodeVersion`, which honours `project.nodeVersion` first.

### Dashboard

Login, signup, the sign-in error state and the account menu are specified in [UI design §5.6](ui-design.md#56-auth--login-signup-phase-3); components (`AuthLayout`, `GitHubButton`, `ScopeList`, `AccountMenu`) and the auth loader are in [UI implementation §4.3 and §6.8](ui-implementation.md#68-auth-phase-3).

Add a **Settings** tab on the project page: branch, root dir, install/build/output, Node version select, SPA toggle (`PATCH`), and an env-var editor (key/value rows, masked values, "Save" → `PUT`, with the note "Redeploy to apply"). Show the webhook status and, when `webhookId` is null, the manual instructions.

---

## Step 6 — Rate limiting

```ts
import rateLimit from "express-rate-limit";
import { RedisStore } from "rate-limit-redis";

const limiter = (windowMs: number, max: number, prefix: string) => rateLimit({
  windowMs, max, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => req.user?.id ?? req.ip!,
  store: new RedisStore({ sendCommand: (...args: string[]) => redis.call(...args) as any, prefix }),
});

app.use("/detect", limiter(60_000, 10, "rl:detect:"));
app.post("/projects/:id/deployments", limiter(3_600_000, 30, "rl:deploy:"));
app.post("/projects", limiter(3_600_000, 30, "rl:deploy:"));
```

Webhook-triggered deployments bypass the user limiter but share a per-project guard: in `createDeployment`, refuse (409) if more than 30 deployments were created for the project in the last hour.

---

## Step 7 — Fixture

`fixtures/env-echo` — a Vite project whose `vite.config.ts` reads `process.env.FOO` via `define`, and whose `index.html` renders it. The e2e test sets `FOO=hello-from-shipyard` via `PUT /projects/:id/env` and asserts the string appears in the served HTML.

---

## Checklist

- [ ] Login round-trip works; `GET /auth/me` returns the user; logout clears the session
- [ ] Opening `/auth/github/callback` without a valid `state` lands on the dashboard with a translated "sign-in expired" message, not JSON
- [ ] A user cannot read or deploy another user's project (404, not 403 — don't leak existence)
- [ ] Private repo appears in the picker and deploys
- [ ] Push to the configured branch → new deployment within seconds; push to another branch → `202 skipped`
- [ ] Tampered payload → 401
- [ ] Token never appears in logs (`grep -r x-access-token` on worker logs after a private-repo build)
- [ ] `env-echo` fixture shows the injected value
- [ ] 11th `/detect` call in a minute → 429
