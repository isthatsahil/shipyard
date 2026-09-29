# Phase 1 — End-to-End Pipeline

**Goal:** `curl -X POST /projects` with a repo URL → a working site at `https://<slug>.localhost`. No auth, no UI.
**Time:** 1–2 weeks.
**Done when:** all fixture repos deploy green in CI; a build with an infinite `postinstall` loop is killed at the timeout and marked `failed`.

Prerequisite: [Phase 0](phase-0-setup.md).

---

## Step 1 — Shared modules

The pipeline spans three processes: the **API** creates deployments, the **worker** builds and uploads them, and the **router** serves them. All three talk to the same S3 bucket, the same Redis, and the same queue, and they have to agree on key names, storage paths, slug rules and error codes. This step puts each of those in `packages/shared`, so there is one implementation of each. If the worker writes `deployments/<id>/index.html`, the router reads that exact key because both call the same helper, not because two copies of a string happen to match.

Each module is a separate export (`@shipyard/shared/storage`, `@shipyard/shared/redis`, …), not a barrel. Phase 0 explains why: a service that only needs `slug.ts` doesn't pull in the AWS SDK.

### `packages/shared/src/storage.ts`

The object store holds every deployed file. Locally this is MinIO; in production it is any S3-compatible service. The file defines what the rest of the code may do with storage (`ObjectStore`) and one implementation of it on the AWS SDK (`S3Storage`).

```ts
import {
  S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command,
  DeleteObjectsCommand, HeadObjectCommand, NoSuchKey,
} from "@aws-sdk/client-s3";
import type { Readable } from "node:stream";
import type { BaseEnv } from "./env.js";

export interface StoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
  contentEncoding?: string;
  etag?: string;
}

export interface PutOptions {
  contentType: string;
  cacheControl?: string;
  contentEncoding?: string;
  contentLength?: number;
}

/** What the rest of the app depends on. S3Storage is the real one; MemoryStorage (shared/testing) is the test fake. */
export interface ObjectStore {
  put(key: string, body: Buffer | Readable, opts: PutOptions): Promise<void>;
  /** Returns null when the key does not exist. */
  get(key: string): Promise<StoredObject | null>;
  exists(key: string): Promise<boolean>;
  list(prefix: string): AsyncIterable<{ key: string; size: number }>;
  deletePrefix(prefix: string): Promise<void>;
}

/** Narrow views: the router only reads, the worker's upload step only writes. */
export type ObjectReader = Pick<ObjectStore, "get">;
export type ObjectWriter = Pick<ObjectStore, "put">;

export class S3Storage implements ObjectStore {
  private s3: S3Client;
  constructor(env: BaseEnv, private bucket = env.S3_BUCKET) {
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY },
    });
  }

  async put(key: string, body: Buffer | Readable, opts: PutOptions) {
    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucket, Key: key, Body: body,
      ContentType: opts.contentType, CacheControl: opts.cacheControl,
      ContentEncoding: opts.contentEncoding, ContentLength: opts.contentLength,
    }));
  }

  /** Returns null when the key does not exist. */
  async get(key: string): Promise<StoredObject | null> {
    try {
      const response = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      return {
        body: response.Body as Readable,
        contentType: response.ContentType, contentLength: response.ContentLength,
        cacheControl: response.CacheControl, contentEncoding: response.ContentEncoding, etag: response.ETag,
      };
    } catch (e) {
      if (e instanceof NoSuchKey || (e as any)?.$metadata?.httpStatusCode === 404) return null;
      throw e;
    }
  }

  async exists(key: string) {
    try { await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key })); return true; }
    catch (e) { if ((e as any)?.$metadata?.httpStatusCode === 404) return false; throw e; }
  }

  async *list(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const object of page.Contents ?? []) if (object.Key) yield { key: object.Key, size: object.Size ?? 0 };
      token = page.NextContinuationToken;
    } while (token);
  }

  async deletePrefix(prefix: string) {
    let batch: { Key: string }[] = [];
    const flush = async () => {
      if (!batch.length) return;
      await this.s3.send(new DeleteObjectsCommand({ Bucket: this.bucket, Delete: { Objects: batch } }));
      batch = [];
    };
    for await (const object of this.list(prefix)) { batch.push({ Key: object.key }); if (batch.length === 1000) await flush(); }
    await flush();
  }
}
```

How it works:

- **`StoredObject` / `PutOptions`** carry the HTTP metadata S3 stores with each object (`Content-Type`, `Cache-Control`, `Content-Encoding`, ETag). The worker sets them once at upload time, and the router copies them onto the response. Headers are decided at build time, so the router doesn't compute anything per request.
- **`forcePathStyle`** is needed for MinIO, which serves buckets at `http://host/bucket/key`. AWS uses virtual-host style (`http://bucket.host/key`), which only works with real DNS for each bucket.
- **`get` returns `null` for a missing key** instead of throwing. A missing file is normal for the router (it tries `/docs`, then `/docs/index.html`, then `/docs.html`), so it shouldn't need try/catch. The check looks at both `NoSuchKey` and a raw 404 status, because some S3-compatible backends return a 404 without the typed error. Anything else (bad credentials, network) is still thrown.
- **`exists` uses `HEAD`**, which returns only metadata, so checking a large file doesn't download it.
- **`list` is an async generator.** `ListObjectsV2` returns at most 1,000 keys per call plus a continuation token, and the loop follows the token until the listing ends. Callers write `for await (const object of store.list(prefix))` and never see the paging. Keys are yielded as they arrive, so a large deployment is never held in memory all at once.
- **`deletePrefix` deletes in batches of 1,000**, because that is the most `DeleteObjects` accepts in one request. S3 has no "delete folder" call, so this is how a whole deployment is removed (Phase 5 retention).

**Why an interface.** Services depend on `ObjectStore` (or the narrower `ObjectReader` / `ObjectWriter`), never on S3 directly, and they *receive* the store instead of importing a singleton. Three things follow:

- The router's serving logic can be unit-tested with an in-memory store, no Docker (Step 5).
- Swapping or wrapping the backend (a local-disk store, a `CachedStorage` in front of S3) only changes the service's `clients.ts`.
- The router can't write or delete, and the worker's upload step can't read — the types say so.

TypeScript checks shapes, not names, so the interface is mostly a clean contract: fakes implement it without casting away the class's private fields, and the compiler flags a fake that's missing a method.

Never pass a method loose (`paths.map(store.get)`): `S3Storage` methods use `this`. Write `paths.map(key => store.get(key))`.

### `packages/shared/src/storageKeys.ts`

Every storage path the platform uses, in one place. It's exported as `@shipyard/shared/storageKeys`. Per-deployment helpers take the deployment's saved `storagePrefix`, not its id: the prefix is stored on each row so the layout can change later without breaking old deployments (Phase 0).

```ts
/** `deployments/<id>/`. Only called when a deployment is created; afterwards use the saved `storagePrefix`. */
export const deploymentPrefix = (deploymentId: string) => `deployments/${deploymentId}/`;

export const META_FILE = "_meta.json";   // build summary (worker, Phase 1)
export const LOGS_FILE = "_logs.txt";    // archived build log (worker, Phase 2)

/** Platform files inside a deployment prefix that are not part of the user's site. The router never serves them. */
export const INTERNAL_FILES: ReadonlySet<string> = new Set([META_FILE, LOGS_FILE]);

export const metaKey = (storagePrefix: string) => storagePrefix + META_FILE;
export const logsKey = (storagePrefix: string) => storagePrefix + LOGS_FILE;
```

The trailing `/` in `deploymentPrefix` matters: without it, listing or deleting `deployments/abc1` would also match `deployments/abc123/...`. Add new paths here rather than writing the string where it's used.

`_meta.json` and `_logs.txt` sit next to the user's files so that deleting one prefix removes everything for a deployment. The cost is that a user's site could, in principle, request them by URL. `INTERNAL_FILES` is the list the router refuses to serve (Step 5).

### `packages/shared/src/testing/memoryStorage.ts`

A test fake with the same behaviour as S3 for everything the app relies on: `null` for missing keys, metadata round-trips, an ETag that changes with content. Add `"./testing": "./src/testing/memoryStorage.ts"` to the `exports` of `packages/shared/package.json`. Only test files import it.

How it matches S3:

- **`put` accepts a stream or a buffer**, like `S3Storage`. `toBuffer` drains a stream into memory, so a test can pass `fs.createReadStream(...)` exactly as the worker does.
- **The ETag is the quoted MD5 of the content**, which is what S3 returns for a single-part upload. The router's `If-None-Match` / 304 logic then behaves the same against the fake as against MinIO, and a test that overwrites a file sees the ETag change.
- **`get` builds a new `Readable` on every call.** A stream can only be read once, so returning a stored stream would break the second request for the same file.
- **`objects` is public** so a test can check what was written (for example, that an upload skipped `.env`) without going through `list`.

```ts
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { ObjectStore, PutOptions, StoredObject } from "../storage.js";

interface Entry { buf: Buffer; opts: PutOptions; etag: string }

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export class MemoryStorage implements ObjectStore {
  readonly objects = new Map<string, Entry>();

  async put(key: string, body: Buffer | Readable, opts: PutOptions) {
    const buf = await toBuffer(body);
    this.objects.set(key, { buf, opts, etag: `"${createHash("md5").update(buf).digest("hex")}"` });
  }

  async get(key: string): Promise<StoredObject | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: Readable.from(entry.buf),
      contentType: entry.opts.contentType, contentLength: entry.buf.length,
      cacheControl: entry.opts.cacheControl, contentEncoding: entry.opts.contentEncoding, etag: entry.etag,
    };
  }

  async exists(key: string) { return this.objects.has(key); }

  async *list(prefix: string) {
    for (const [key, entry] of this.objects) if (key.startsWith(prefix)) yield { key, size: entry.buf.length };
  }

  async deletePrefix(prefix: string) {
    for (const key of [...this.objects.keys()]) if (key.startsWith(prefix)) this.objects.delete(key);
  }
}
```

### `packages/shared/src/redis.ts`

Redis does four jobs in this platform: it backs the build queue (through BullMQ, see `queue.ts`), buffers live build logs, carries status and cancel events over pub/sub, and caches hostname → deployment lookups for the router. This file makes the connections and names every key.

```ts
import { Redis } from "ioredis";
import type { ICreateRedisOptions } from "./types/ICreateRedisOptions";

export type { ICreateRedisOptions } from "./types/ICreateRedisOptions";

/** Subscribers get their own connection and never give up on a command; regular ones fail after 3 retries. */
export function createRedis(url: string, { subscriber = false }: ICreateRedisOptions = {}): Redis {
  return new Redis(url, { maxRetriesPerRequest: subscriber ? null : 3 });
}

export const keys = {
  logs: (deploymentId: string) => `logs:${deploymentId}`,          // list + pub/sub channel
  status: (deploymentId: string) => `status:${deploymentId}`,      // pub/sub channel
  cancel: (deploymentId: string) => `cancel:${deploymentId}`,      // pub/sub channel (Phase 4)
  route: (slug: string) => `route:${slug}`,                        // router cache
  routeHost: (hostname: string) => `route:host:${hostname}`,       // router cache, custom domains (Phase 5)
  session: (id: string) => `session:${id}`,                        // session id → user id (Phase 3)
} as const satisfies Record<string, (id: string) => string>;
```

`packages/shared/src/types/ICreateRedisOptions.ts`:

```ts
export interface ICreateRedisOptions {
  /** Connection for SUBSCRIBE; it can't run other commands once subscribed. */
  subscriber?: boolean;
}
```

Why two kinds of connection:

- **A subscribed connection can't do anything else.** After `SUBSCRIBE`, Redis rejects every command on that connection except the subscribe family. The log stream (Phase 2) therefore gets its own connection, and `subscriber: true` makes that explicit where it's created.
- **Retries differ by use.** `maxRetriesPerRequest: 3` means a normal command fails after three reconnect attempts, so an API request errors quickly when Redis is down instead of hanging. A subscriber has nothing to fail back to, so `null` keeps it retrying until Redis returns.

`keys` is the only place key names are spelled out. The worker publishes to `keys.logs(id)` and the API subscribes to `keys.logs(id)`, so the two can't drift apart. `as const satisfies Record<…>` checks that every entry is a `(id) => string` function while keeping the exact property names, so `keys.logz` is a compile error.

### `packages/shared/src/constants.ts`

Platform-wide constants, exported as `@shipyard/shared/constants`.

```ts
export const LOG_TTL_SECONDS = 24 * 60 * 60;   // then read the archived _logs.txt
export const ROUTE_TTL_SECONDS = 60;           // backstop; promote/delete invalidate directly
```

Both are expiry times for data Redis only holds temporarily:

- **`LOG_TTL_SECONDS`**: build logs are appended to a Redis list while the build runs. Without an expiry, every build ever run would stay in Redis memory. After 24 hours the list goes away, and the dashboard reads the copy archived to object storage (Phase 2).
- **`ROUTE_TTL_SECONDS`**: the router caches "slug → active deployment" so it doesn't query Postgres on every request. Promote and delete remove the cache entry directly, so the TTL only matters if one of those invalidations is missed. In that case a stale route fixes itself within a minute.

### `packages/shared/src/queue.ts`

The API and the worker never call each other. The API adds a job to a BullMQ queue stored in Redis, and any running worker picks it up. That keeps the API fast (a `POST` returns as soon as the job is queued, not after a 5-minute build), and lets you run more workers to build more sites in parallel.

```ts
import { Queue, type ConnectionOptions } from "bullmq";

export const BUILD_QUEUE = "builds";
export interface BuildJob { deploymentId: string }

export function connectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return { host: parsed.hostname, port: Number(parsed.port || 6379), password: parsed.password || undefined, maxRetriesPerRequest: null };
}

export function createBuildQueue(redisUrl: string) {
  return new Queue<BuildJob>(BUILD_QUEUE, {
    connection: connectionFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 1,                      // builds are never auto-retried; the user redeploys
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
```

How it works:

- **The job carries only `deploymentId`.** Everything else (repo URL, branch, build settings) is in Postgres, and the worker loads it when the job starts. The job payload can't go stale, and Postgres stays the single source of truth for what a deployment is.
- **`connectionFromUrl`** turns `REDIS_URL` into the options object BullMQ expects. `maxRetriesPerRequest: null` is required: a BullMQ worker waits for jobs with blocking Redis commands, and BullMQ refuses to start a worker on a connection that would give up on them.
- **`attempts: 1`**: a failed build is not retried automatically. Most build failures (a type error, a bad lockfile) fail the same way every time, so retrying wastes minutes and hides the real error. The user redeploys.
- **`removeOnComplete` / `removeOnFail`** cap how many finished jobs BullMQ keeps in Redis. The deployment row in Postgres is the permanent record; the queue only keeps recent jobs for debugging.

### `packages/shared/src/slug.ts`

A project's slug is its subdomain (`<slug>.<BASE_DOMAIN>`), so it has to be a valid DNS label and can't collide with names the platform uses itself.

```ts
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(["api", "app", "www", "admin", "mail", "ftp", "ns1", "ns2", "status", "docs", "cdn", "static", "assets"]);

/** Shape of a Prisma cuid (deployment ids). Such labels are preview URLs, never slugs. */
export const DEPLOYMENT_ID_RE = /^c[a-z0-9]{20,30}$/;

export function isValidSlug(s: string) { return SLUG_RE.test(s) && !RESERVED.has(s) && !DEPLOYMENT_ID_RE.test(s); }

export function slugify(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

export function randomSuffix(n = 4) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: n }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
```

- **`SLUG_RE`** allows 3–40 lowercase letters, digits and hyphens, starting and ending with a letter or digit. That is a DNS label (which may not start or end with `-`) with a length cap so URLs stay short.
- **`RESERVED`** blocks subdomains the platform uses (`api`, `app`) or may use later (`status`, `docs`, `cdn`). Without it, a user could take `api.<BASE_DOMAIN>` and serve a page there.
- **`DEPLOYMENT_ID_RE`** keeps slugs and deployment ids apart. Both appear as the first label of a hostname: `<slug>.<BASE_DOMAIN>` is a project's live site, and `<deploymentId>.<BASE_DOMAIN>` is a preview of one deployment. A deployment id (`c` followed by 24 lowercase letters and digits) would also pass `SLUG_RE`, so without this check the router couldn't tell the two apart. Rejecting id-shaped slugs means any label is either a possible slug or a possible id, never both. The only slugs this rules out are 21–31 characters long, start with `c` and have no hyphens, which no one is likely to pick. `slugify` output that happens to match gets a hyphenated suffix from `uniqueSlug`, which no longer matches.
- **`slugify`** turns a repo name like `My_Cool.Site` into `my-cool-site`. The API uses it to suggest a slug when the user doesn't provide one.
- **`randomSuffix`** uses `Math.random`, not a cryptographic generator. It only makes a suggested slug unique; slugs are public, so they don't need to be unguessable.

### `packages/shared/src/contentType.ts`

Decides the `Content-Type` and `Cache-Control` of each uploaded file. The worker calls these at upload time and the values are stored on the S3 object, so the router just copies them onto the response.

```ts
import mime from "mime-types";

export function contentTypeFor(path: string) {
  return mime.lookup(path) || "application/octet-stream";
}

/** e.g. index-3f2a9c1b.js, chunk.a1b2c3d4e5.css, _app-8f7e6d5c4b3a2.js */
const HASHED_RE = /[.-][a-f0-9]{8,}\.(?:js|mjs|css|woff2?|ttf|png|jpe?g|webp|avif|svg|gif|ico)$/i;

export function cacheControlFor(path: string) {
  if (/\.html?$/i.test(path)) return "public, max-age=0, must-revalidate";
  if (HASHED_RE.test(path) || path.startsWith("_next/static/") || path.startsWith("assets/")) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

export const COMPRESSIBLE = /\.(?:html?|css|js|mjs|json|svg|txt|xml|map|webmanifest|wasm)$/i;
```

- **`contentTypeFor`** looks the type up from the extension. Unknown extensions fall back to `application/octet-stream`, so the browser downloads the file instead of guessing its type. The router's `X-Content-Type-Options: nosniff` header then stops the browser from guessing anyway.
- **`cacheControlFor`** sorts files into three groups:
  - **HTML: `max-age=0, must-revalidate`.** HTML is the entry point that names every other asset. If browsers cached it, a new deploy wouldn't show up until the cache expired. With revalidation, the browser asks every time and gets a cheap 304 when nothing changed.
  - **Hashed assets: one year, `immutable`.** Bundlers put a content hash in the filename (`index-3f2a9c1b.js`), so a changed file always gets a new name. The old name never changes content, so browsers can keep it indefinitely. `assets/` (Vite) and `_next/static/` (Next.js) hold only hashed files, so the whole directory counts even when the regex misses a naming style.
  - **Everything else: one hour.** Unhashed files like `favicon.ico` or `robots.txt` may change between deploys; an hour limits how long a stale copy lives.
- **`COMPRESSIBLE`** lists text formats that shrink well with gzip/brotli. It isn't used in Phase 1; Phase 5 uses it to upload pre-compressed copies.

### `packages/shared/src/messages.ts`

User-facing text never crosses a service boundary as finished English. Servers send a **message code plus params**; the dashboard translates it (Phase 2, react-i18next). `EN_MESSAGES` is both the dashboard's English catalog and the fallback text for logs and curl. This file ships in the browser bundle, so no Node imports and no enums or parameter properties.

```ts
export type MessageParams = Record<string, string | number>;

export const EN_MESSAGES = {
  "pipeline.clone_failed": 'Could not clone branch "{{branch}}". Check the repository URL and branch name.',
  "pipeline.build_failed": "Build failed with exit code {{exitCode}}. Check the logs above.",
  "pipeline.build_timeout": "Build exceeded the {{minutes}} minute limit and was stopped.",
  "pipeline.cancelled": "Build was cancelled.",
  "pipeline.output_not_found": 'Could not find a build output directory (tried: {{tried}}). Set "Output directory" on the project.',
  "pipeline.root_dir_invalid": 'Root directory "{{rootDir}}" is outside the repository. Set "Root directory" on the project to a folder inside it.',
  "pipeline.internal": "Internal error during build.",
  "api.bad_request": "The request could not be processed.",
  "api.not_found": "Not found.",
  "api.internal": "Something went wrong on our side.",
  "api.validation_failed": "Invalid value for {{field}}.",
  "api.repo_unsupported": "Only GitHub repositories are supported.",
  "api.slug_invalid": "Use 3–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
  "api.slug_taken": "That subdomain is already taken.",
  // … the api.* codes used by later phases (promote, delete, cancel, auth, domains)
} as const satisfies Record<string, string>;

export type MessageCode = keyof typeof EN_MESSAGES;
export const MESSAGE_CODES = Object.keys(EN_MESSAGES) as MessageCode[];
export interface UserMessage { code: MessageCode; params?: MessageParams }

export function formatEnglish(code: MessageCode, params?: MessageParams) {
  return EN_MESSAGES[code].replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) => params && name in params ? String(params[name]) : m);
}
```

- **`as const satisfies Record<string, string>`** keeps each key as a literal type, so `MessageCode` is the union `"pipeline.clone_failed" | "pipeline.build_failed" | …`. A misspelled code anywhere in the API or worker is a compile error, not a blank message in the UI.
- **`{{name}}` placeholders** use react-i18next's default syntax, so the dashboard can load `EN_MESSAGES` as its English catalog with no conversion.
- **`formatEnglish` leaves unknown placeholders as they are.** A missing param shows as `{{branch}}` in the output, which is easy to spot, rather than the word `undefined`.
- **`MESSAGE_CODES`** lists every code at runtime. Phase 2 uses it to check that each translation catalog covers every code.

### `packages/shared/src/errors.ts`

Each error carries a `code` + `params` for the dashboard and a `userMessage` (the English rendering) for build logs.

Every pipeline step reports failure by throwing one of these classes. The single `catch` in `runPipeline` (Step 4) turns the error into the deployment's final status and error message. No step has to update the database itself when it fails.

```ts
import { formatEnglish, type MessageCode, type MessageParams, type UserMessage } from "./messages";

export class PipelineError extends Error {
  readonly code: MessageCode;
  readonly params?: MessageParams;
  readonly userMessage: string;
  constructor(message: string, code: MessageCode, params?: MessageParams) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.params = params;
    this.userMessage = formatEnglish(code, params);
  }
}
export class CloneError extends PipelineError {
  constructor(message: string, branch: string) { super(message, "pipeline.clone_failed", { branch }); }
}
export class BuildFailedError extends PipelineError {
  constructor(public exitCode: number) { super(`build exited with code ${exitCode}`, "pipeline.build_failed", { exitCode }); }
}
export class BuildTimeoutError extends PipelineError {
  constructor(ms: number) { super(`build timed out after ${ms}ms`, "pipeline.build_timeout", { minutes: Math.max(1, Math.round(ms / 60000)) }); }
}
export class BuildCancelledError extends PipelineError { constructor() { super("cancelled", "pipeline.cancelled"); } }
export class OutputNotFoundError extends PipelineError {
  constructor(tried: string[]) { super(`no output directory (tried ${tried.join(", ")})`, "pipeline.output_not_found", { tried: tried.join(", ") }); }
}
export class RootDirError extends PipelineError {
  constructor(rootDir: string) { super(`rootDir "${rootDir}" escapes the repository`, "pipeline.root_dir_invalid", { rootDir }); }
}

/** Any thrown value → translatable message. Unknown errors become `pipeline.internal`, so internals never reach the user. */
export function toUserMessage(e: unknown): UserMessage & { fallback: string } {
  if (e instanceof PipelineError) return { code: e.code, params: e.params, fallback: e.userMessage };
  return { code: "pipeline.internal", fallback: formatEnglish("pipeline.internal") };
}
```

- **Two messages per error.** `message` (the standard `Error` field) is for operators: it can include raw details like git's stderr and goes to the worker's own log. `userMessage` is the fixed, translatable text the user sees. Keeping them apart means internal details never reach a user by accident.
- **`this.name = new.target.name`** sets the name to the subclass actually constructed (`BuildTimeoutError`, not `PipelineError`), so worker logs show which error it was.
- **`BuildCancelledError` is its own class** because a cancel isn't a failure: `runPipeline` checks for it and sets the status to `cancelled` instead of `failed`.
- **`BuildTimeoutError` rounds to minutes**, with a minimum of 1, because users think of the limit as "15 minutes", not "900000ms".
- **`toUserMessage` is the safety net.** Anything that isn't a `PipelineError` (a Prisma error, an S3 timeout, a bug) becomes `pipeline.internal`. The user sees "Internal error during build" and the details stay in the worker log.

---

## Step 2 — API service

In Phase 1 the API does very little on purpose: it validates a request, writes a `Project` and a `Deployment` row, queues a build job, and reports status. It never clones or builds anything. Builds take minutes, run untrusted code, and need Docker, and all of that belongs to the worker. The API stays fast and never needs access to the Docker socket.

### `apps/api/src/lib/clients.ts`

Each long-lived connection the API holds (env, storage, Redis, queue) is created once, here, when the process starts. Routes and services import from this file instead of creating their own clients, so there is one Redis connection pool per process, and swapping a backend is a one-line change.

```ts
import { loadEnv } from "@shipyard/shared/env";
import { S3Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
import { createBuildQueue } from "@shipyard/shared/queue";
import { createLogger } from "@shipyard/shared/logger";
import { z } from "zod";

export const env = loadEnv({ PORT: z.coerce.number().default(4000) });
export const log = createLogger("api", env.LOG_LEVEL);
// Typed as the interface: this line is the only place that knows the backend is S3.
export const storage: ObjectStore = new S3Storage(env);
export const redis = createRedis(env.REDIS_URL);
redis.on("error", err => log.error({ err }, "redis error"));   // without a listener ioredis console.errors every reconnect
export const buildQueue = createBuildQueue(env.REDIS_URL);
buildQueue.on("error", err => log.error({ err }, "build queue error"));
```

`loadEnv` validates the shared variables (database, Redis, S3) and adds the ones passed in, here `PORT`. A missing or malformed variable stops the process at startup with a clear message, instead of failing on the first request that needs it.

### `apps/api/src/lib/httpError.ts`

Every error response is `{ error: { code, params?, message } }`: the dashboard translates `code`, and `message` is English for curl and logs. Never send raw text with `res.status(4xx).json({ error: "…" })`.

Routes and services report a client mistake with `throw new HttpError(status, code, params?)`; middleware passes it to `next(err)`. Only `errorHandler` writes error responses. Never throw a plain `Error` for a client mistake: `errorHandler` treats it as a bug and answers 500.

One catch: a `throw` reaches Express only from the handler itself or from code it awaits. Inside a callback that runs outside that promise (a `setTimeout`, a stream `on("error")`, an SSE interval) a throw crashes the process, so call `next(err)` there instead.

```ts
import { formatEnglish, type MessageCode, type MessageParams, type UserMessage } from "@shipyard/shared/messages";

export interface ApiErrorBody { error: UserMessage & { message: string } }

export class HttpError extends Error {
  readonly status: number;
  readonly code: MessageCode;
  readonly params?: MessageParams;
  constructor(status: number, code: MessageCode, params?: MessageParams) {
    super(formatEnglish(code, params));
    this.name = "HttpError";
    this.status = status; this.code = code; this.params = params;
  }
}
```

### `apps/api/src/middleware/validate.ts`

Checks one part of the request (`body` by default, or `query` / `params`) and replaces it with the parsed value, so defaults and coercion reach the route. Use one schema per part, so error field names stay unprefixed (`"cursor"`, not `"query.cursor"`). The write uses `defineProperty` because Express 5 makes `req.query` a getter, and plain assignment to it is silently ignored.

```ts
import type { RequestHandler } from "express";
import type { z } from "zod";

type Source = "body" | "query" | "params";

// A failure goes to errorHandler as the ZodError → 400 api.validation_failed.
export const validate = (schema: z.ZodType, source: Source = "body"): RequestHandler => (req, _res, next) => {
  const result = schema.safeParse(req[source]);
  if (!result.success) return next(result.error);
  Object.defineProperty(req, source, { value: result.data, writable: true, configurable: true, enumerable: true });
  next();
};
```

### `apps/api/src/middleware/errors.ts`

`notFound` gives unmatched routes the same JSON error shape instead of Express's HTML page. `errorHandler` turns everything that reaches it into an `HttpError`, then writes one response. Express 5 forwards thrown errors and rejected async handlers here, so routes need no try/catch. It is the one place that formats and logs errors.

| Error | Response |
|---|---|
| `HttpError` | its own status and code |
| `ZodError` (from `validate`, or a route that calls `.parse()` directly) | 400 `api.validation_failed` |
| body-parser `entity.parse.failed` (malformed JSON) | 400 `api.bad_request` |
| body-parser `entity.too.large` (over the 1 MB limit) | 413 `api.bad_request` |
| anything else | logged, then 500 `api.internal` |

```ts
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError, type ApiErrorBody } from "../lib/httpError.js";

export const notFound: RequestHandler = (_req, _res, next) => { next(new HttpError(404, "api.not_found")); };

function bodyParserType(err: unknown) {
  return typeof err === "object" && err !== null && "type" in err ? String(err.type) : undefined;
}

function toHttpError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) {
    const field = err.issues[0]?.path.join(".") || "request";
    return new HttpError(400, "api.validation_failed", { field });
  }
  const type = bodyParserType(err);
  if (type === "entity.parse.failed") return new HttpError(400, "api.bad_request");
  if (type === "entity.too.large") return new HttpError(413, "api.bad_request");
  return undefined;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);
  let httpError = toHttpError(err);
  if (!httpError) {
    // Unknown errors are internal detail: log them, send only a code.
    req.log.error({ err }, "unhandled error");
    httpError = new HttpError(500, "api.internal");
  }
  const body: ApiErrorBody = { error: { code: httpError.code, params: httpError.params, message: httpError.message } };
  res.status(httpError.status).json(body);
};
```

### `apps/api/src/services/projects.ts`

The two checks a new project needs before it's saved: is the repo something we can clone, and which subdomain does it get. They live in a service rather than in the route so Phase 3's GitHub import flow can reuse them.

```ts
import { prisma } from "@shipyard/db";
import { isValidSlug, slugify, randomSuffix } from "@shipyard/shared/slug";
import { HttpError } from "../lib/httpError.js";

const GITHUB_RE = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

export function normaliseRepoUrl(input: string) {
  const match = GITHUB_RE.exec(input.trim());
  if (!match) throw new HttpError(400, "api.repo_unsupported");
  return { owner: match[1], repo: match[2], url: `https://github.com/${match[1]}/${match[2]}.git` };
}

export async function uniqueSlug(preferred?: string, fallback?: string) {
  if (preferred) {
    if (!isValidSlug(preferred)) throw new HttpError(400, "api.slug_invalid");
    if (await prisma.project.findUnique({ where: { slug: preferred } })) throw new HttpError(409, "api.slug_taken");
    return preferred;
  }
  const base = slugify(fallback ?? "site") || "site";
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSuffix()}`;
    if (isValidSlug(candidate) && !(await prisma.project.findUnique({ where: { slug: candidate } }))) return candidate;
  }
  return `${base}-${randomSuffix(8)}`;
}
```

**`normaliseRepoUrl`** accepts the forms people paste (`github.com/a/b`, `https://www.github.com/a/b.git`, a trailing `/`) and returns one canonical `https://github.com/<owner>/<repo>.git`. That gives the worker:

- one URL shape to clone, and a known place to insert an access token in Phase 3 (`https://x-access-token:…@github.com/…`);
- no `git@github.com:` SSH URLs, which would need SSH keys on the worker;
- no URLs on arbitrary hosts. Only GitHub is supported because Phase 3's private-repo access goes through a GitHub App.

It also returns `repo`, which becomes the default project name and slug.

**`uniqueSlug`** handles two cases:

- **The user asked for a slug.** It must be valid and free. If it's taken the API answers 409 instead of changing it, because the user picked that name on purpose.
- **No slug given.** It starts from the repo name. If that's taken, it tries up to four `-xxxx` random suffixes, then gives up checking and uses an 8-character suffix: at 36⁸ ≈ 2.8 trillion combinations, a collision is not a practical concern.

The lookup and the later `project.create` are two separate queries, so two requests could in theory pick the same slug at the same moment. The `@unique` index on `Project.slug` is the real guard: the second insert fails with a Prisma unique-constraint error instead of creating a duplicate.

### `apps/api/src/services/deployments.ts`

This is the single entry point for creating builds; the webhook path (Phase 3) calls it too.

```ts
import { prisma, type Deployment } from "@shipyard/db";
import { deploymentPrefix } from "@shipyard/shared/storageKeys";
import { buildQueue } from "../lib/clients.js";

export async function createDeployment(projectId: string, meta: { commitSha?: string; commitMsg?: string } = {}): Promise<Deployment> {
  const deployment = await prisma.$transaction(async tx => {
    const created = await tx.deployment.create({ data: { projectId, storagePrefix: "", ...meta } });
    return tx.deployment.update({ where: { id: created.id }, data: { storagePrefix: deploymentPrefix(created.id) } });
  });
  // jobId = deploymentId → enqueueing the same deployment twice is a no-op
  await buildQueue.add("build", { deploymentId: deployment.id }, { jobId: deployment.id });
  return deployment;
}
```

- **Create, then set `storagePrefix`.** The prefix contains the deployment's id, and the id is only known once the row exists. The two writes run in one transaction, so no other reader ever sees a deployment with an empty prefix.
- **Enqueue after the transaction commits.** If the job were queued inside the transaction, a fast worker could pick it up and look for the row before it was committed, and find nothing.
- **`jobId: deployment.id`** makes BullMQ ignore a second `add` for the same deployment, so a retried request can't start two builds of one row.
- New rows start as `status: queued` (the schema default). The worker only starts from that state.

### `apps/api/src/routes/projects.ts`

The HTTP layer for projects. Routes only parse the request, call services, and shape the response; the rules live in the services above.

```ts
import { Router } from "express";
import { z } from "zod";
import { prisma } from "@shipyard/db";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl, uniqueSlug } from "../services/projects.js";
import { createDeployment } from "../services/deployments.js";

export const projects = Router();

const CreateProject = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().default("main"),
  slug: z.string().optional(),
  name: z.string().optional(),
  rootDir: z.string().default("."),
  installCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  outputDir: z.string().optional(),
  spaFallback: z.boolean().default(true),
  deploy: z.boolean().default(true),
});

projects.post("/", validate(CreateProject), async (req, res) => {
  const body = req.body as z.infer<typeof CreateProject>;
  const { repo, url } = normaliseRepoUrl(body.repoUrl);
  const slug = await uniqueSlug(body.slug, repo);
  // Phase 1: single seeded user. Replaced by req.user in Phase 3.
  const user = await prisma.user.findFirstOrThrow();
  const project = await prisma.project.create({
    data: { userId: user.id, name: body.name ?? repo, slug, repoUrl: url, branch: body.branch, rootDir: body.rootDir,
            installCmd: body.installCmd, buildCmd: body.buildCmd, outputDir: body.outputDir, spaFallback: body.spaFallback },
  });
  const deployment = body.deploy ? await createDeployment(project.id) : null;
  res.status(201).json({ project, deployment });
});

projects.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { deployments: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  res.json(project);
});

projects.post("/:id/deployments", async (req, res) => {
  const project = await prisma.project.findUnique({ where: { id: req.params.id } });
  if (!project) throw new HttpError(404, "api.not_found");
  res.status(201).json(await createDeployment(project.id));
});
```

- **`CreateProject`** is the whole request contract. Defaults (`branch: "main"`, `rootDir: "."`, `spaFallback: true`) are applied by `validate`, so the handler always sees complete values. The build settings (`installCmd`, `buildCmd`, `outputDir`) are optional overrides; left empty, the worker detects them (Step 3).
- **`rootDir`** supports monorepos where the site lives in a subfolder. The worker checks that it can't point outside the cloned repo.
- **`spaFallback`** defaults to on because most frontends built today are single-page apps whose client-side routes (`/settings`) have no file behind them.
- **`deploy: false`** creates the project without starting a build, for when the settings need adjusting first.
- **`findFirstOrThrow` on the user** is a Phase 1 stand-in. There's no login yet, so every project belongs to the one seeded user. Phase 3 replaces it with the signed-in user.
- **`POST /projects/:id/deployments`** is "redeploy": it builds the project's branch again with its current settings.
- **`GET /projects/:id`** returns the project with its 10 latest deployments, enough to see what's live and what happened recently.
- No try/catch anywhere: a thrown `HttpError` or a rejected promise goes to `errorHandler` (Express 5 forwards async errors).

### `apps/api/src/routes/deployments.ts`

The endpoint a client polls to follow a build; the e2e test (Step 7) uses it to wait for `ready` or `failed`.

```ts
import { Router } from "express";
import { prisma } from "@shipyard/db";
import { HttpError } from "../lib/httpError.js";

export const deployments = Router();

deployments.get("/:id", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({ where: { id: req.params.id }, include: { project: { select: { slug: true } } } });
  if (!deployment) throw new HttpError(404, "api.not_found");
  res.json({ ...d, sizeBytes: deployment.sizeBytes?.toString() ?? null });
});
```

`sizeBytes` is a `BigInt` column (a site can exceed 2 GB, the limit of a 32-bit integer). `JSON.stringify` throws on `BigInt` values, so it's sent as a string. The project's `slug` is included so the client can build the site URL without a second request.

### `apps/api/src/index.ts`

Builds the Express app: logging, JSON parsing, a health check, the two routers, and the error handlers.

```ts
import express from "express";
import pinoHttp from "pino-http";
import { prisma } from "@shipyard/db";
import { env, redis } from "./lib/clients.js";
import { notFound, errorHandler } from "./middleware/errors.js";
import { projects } from "./routes/projects.js";
import { deployments } from "./routes/deployments.js";

const app = express();
app.use(pinoHttp({ level: env.LOG_LEVEL }));
app.use(express.json({ limit: "1mb" }));

app.get("/health", async (_req, res) => {
  const checks = { db: false, redis: false };
  try { await prisma.$queryRaw`SELECT 1`; checks.db = true; } catch {}
  try { checks.redis = (await redis.ping()) === "PONG"; } catch {}
  const ok = checks.db && checks.redis;
  res.status(ok ? 200 : 503).json({ ok, ...checks });
});

app.use("/projects", projects);
app.use("/deployments", deployments);

// Order matters: notFound after every router, errorHandler last.
app.use(notFound);
app.use(errorHandler);

export default app;
```

- **`pinoHttp`** logs each request with its status and duration, and adds `req.log`, which `errorHandler` uses so an error is logged together with the request that caused it.
- **`express.json({ limit: "1mb" })`**: request bodies here are small JSON objects. The limit stops a client from sending a huge body; an oversized one gets 413 from `errorHandler`.
- **`/health`** checks the two dependencies the API can't work without. It answers 503 when either is down, so Compose's healthcheck (and later a load balancer) can tell "process running" apart from "process able to serve". Each check has its own `try`, so the response says which one failed.

`apps/api/src/server.ts` stays as Phase 0 wrote it: it imports this app and calls `listen`. Keeping `listen` out of `index.ts` lets tests import the app without binding a port.

---

## Step 3 — Framework detection (`apps/worker/src/detect/`)

The goal is that a user pastes a repo URL and nothing else. To build the site, the worker needs four answers: how to install dependencies, how to build, which Node version to use, and which folder holds the finished site. Detection works these out from the files in the cloned repo, and any value the user set on the project wins over the guess.

Detection only **reads files**. It never runs the repo's code (no `require("./vite.config.js")`), because it runs in the worker process on the host, not in the sandboxed build container. Anything it can't work out statically is left `null` and resolved after the build by looking at what the build produced (`postBuildScan`).

The module is pure (a directory in, a result out; no database, no Docker), so it's unit-tested directly against the fixture folders.

### `types.ts`

```ts
export type Framework = "next" | "vite" | "cra" | "vue-cli" | "sveltekit" | "astro" | "static" | "unknown";
export type PackageManager = "npm" | "pnpm" | "yarn";

export interface ProjectOverrides {
  installCmd?: string | null;
  buildCmd?: string | null;
  outputDir?: string | null;
  nodeVersion?: string | null;
}

export interface DetectResult {
  framework: Framework;
  packageManager: PackageManager;
  installCmd: string | null;   // null → skip install
  buildCmd: string | null;     // null → skip build
  outputDir: string | null;    // null → resolve after build via postBuildScan
  nodeVersion: "20" | "22" | "24";
  warnings: string[];
}
```

- **`null` has a meaning in each field.** A `null` install or build command means "skip this step", which is right for a plain HTML site. A `null` output directory means "not known yet, look after the build".
- **`nodeVersion` is limited to `"20" | "22" | "24"`** because those are the builder images Phase 0 builds (`shipyard/builder:node20`, …). Any other value would name an image that doesn't exist.
- **`warnings`** are written to the build log. When a build fails, the user can see what detection assumed (for example, that a Next.js project isn't set up for static export).
- **`ProjectOverrides`** fields accept `null` because that's how Prisma returns an empty optional column.

### `packageJson.ts`

Everything that can be learned from `package.json` and the lockfiles next to it.

```ts
import fs from "node:fs";
import path from "node:path";
import type { Framework, PackageManager } from "./types.js";

export interface PkgInfo {
  exists: boolean;
  deps: Record<string, string>;
  scripts: Record<string, string>;
  engines?: { node?: string };
}

export function readPackageJson(root: string): PkgInfo {
  const pkgPath = path.join(root, "package.json");
  if (!fs.existsSync(pkgPath)) return { exists: false, deps: {}, scripts: {} };
  const json = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  return {
    exists: true,
    deps: { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) },
    scripts: json.scripts ?? {},
    engines: json.engines,
  };
}

export function detectPackageManager(root: string): PackageManager {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

export function frameworkFromDeps(deps: Record<string, string>): Framework {
  if ("next" in deps) return "next";
  if ("@sveltejs/kit" in deps) return "sveltekit";
  if ("astro" in deps) return "astro";
  if ("react-scripts" in deps) return "cra";
  if ("@vue/cli-service" in deps) return "vue-cli";
  if ("vite" in deps) return "vite";
  return "unknown";
}

export const DEFAULT_OUTPUT: Record<Framework, string | null> = {
  next: "out", sveltekit: "build", astro: "dist", cra: "build", "vue-cli": "dist", vite: "dist", static: ".", unknown: null,
};

export function installCommandFor(packageManager: PackageManager, root: string) {
  switch (packageManager) {
    case "pnpm": return "pnpm install --frozen-lockfile";
    case "yarn": return "yarn install --immutable || yarn install --frozen-lockfile";
    default: return fs.existsSync(path.join(root, "package-lock.json")) ? "npm ci" : "npm install";
  }
}

export function buildCommandFor(packageManager: PackageManager) {
  return packageManager === "npm" ? "npm run build" : `${packageManager} run build`;
}

export function nodeVersionFromEngines(engines?: { node?: string }): "20" | "22" | "24" | null {
  const match = engines?.node?.match(/(20|22|24)/);
  return match ? (match[1] as "20" | "22" | "24") : null;
}
```

- **`deps` merges `dependencies` and `devDependencies`.** Build tools like `vite` are usually dev dependencies, but people put them in either.
- **The lockfile decides the package manager.** A `pnpm-lock.yaml` means the project is tested with pnpm; installing it with npm would ignore the lockfile and could resolve different versions. With no lockfile, npm is the default.
- **Order in `frameworkFromDeps` matters.** SvelteKit and Astro are built on Vite, and their projects often list `vite` as a dependency too. Checking `vite` first would label a SvelteKit app as plain Vite and look for its output in `dist/` instead of `build/`. Meta-frameworks are checked first; `vite` comes last.
- **`DEFAULT_OUTPUT`** is where each framework writes its build when not configured otherwise. `unknown` is `null`: there's no safe guess, so the post-build scan decides.
- **Install commands use the lockfile strictly** (`--frozen-lockfile`, `--immutable`, `npm ci`). The build installs exactly what the repo commits, and fails if the lockfile is out of date instead of quietly installing different versions. Yarn has two versions with different flags (`--immutable` in Yarn 2+, `--frozen-lockfile` in Yarn 1), so the command tries one, then the other. `npm ci` requires a `package-lock.json`; without one, `npm install` is the only option.
- **`nodeVersionFromEngines`** is deliberately simple: it takes the first supported major version mentioned in `engines.node`. A range like `">=18"` doesn't mention one, so it returns `null` and the default (22) applies.

### `configParsers.ts`

Config files are parsed with regexes on purpose: evaluating them would execute untrusted code on the worker host.

Each function looks for one setting that moves the output folder (Vite's `build.outDir`, Next's `output: 'export'`, SvelteKit's adapter `pages`, …). `stripComments` removes comments first, so a commented-out `// outDir: "old"` isn't picked up. The limit of regexes is that a computed value (`outDir: path.join(...)`) or one imported from another file won't match. In that case the function returns `null`, the framework default applies, and if that's wrong the post-build scan finds the real folder.

```ts
import fs from "node:fs";
import path from "node:path";

function readFirst(root: string, names: string[]) {
  for (const name of names) { const filePath = path.join(root, name); if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8"); }
  return null;
}

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

export function viteOutDir(root: string): string | null {
  const src = readFirst(root, ["vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts"]);
  if (!src) return null;
  const match = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src));
  return match?.[1] ?? null;
}

export function nextConfig(root: string): { distDir: string | null; isExport: boolean; found: boolean } {
  const src = readFirst(root, ["next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs"]);
  if (!src) return { distDir: null, isExport: false, found: false };
  const code = stripComments(src);
  const isExport = /output\s*:\s*['"`]export['"`]/.test(code);
  const distDir = /distDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(code)?.[1] ?? null;
  return { distDir, isExport, found: true };
}

export function vueCliOutputDir(root: string): string | null {
  const src = readFirst(root, ["vue.config.js", "vue.config.cjs"]);
  return src ? (/outputDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src))?.[1] ?? null) : null;
}

export function svelteKitConfig(root: string): { pages: string | null; usesStaticAdapter: boolean } {
  const src = readFirst(root, ["svelte.config.js", "svelte.config.mjs"]);
  if (!src) return { pages: null, usesStaticAdapter: false };
  const code = stripComments(src);
  return {
    usesStaticAdapter: /@sveltejs\/adapter-static/.test(code),
    pages: /pages\s*:\s*['"`]([^'"`]+)['"`]/.exec(code)?.[1] ?? null,
  };
}

export function astroOutDir(root: string): string | null {
  const src = readFirst(root, ["astro.config.mjs", "astro.config.ts", "astro.config.js"]);
  return src ? (/outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src))?.[1] ?? null) : null;
}
```

`nextConfig` returns more than a folder because Next.js only produces a static site with `output: 'export'`. Without it the build produces a Node server this platform can't run, so detection warns about it. `svelteKitConfig` checks for `adapter-static` for the same reason.

### `postBuildScan.ts`

The fallback when detection couldn't name the output folder, or named one that turned out not to exist. It runs after the build, when the answer is on disk.

```ts
import fs from "node:fs";
import path from "node:path";

const PREFERRED = ["dist", "build", "out", "public", "_site", ".output/public", "www"];
const IGNORE = new Set(["node_modules", ".git", ".next", ".svelte-kit", ".cache", "src", "test", "tests"]);

export function snapshotDirs(root: string): Set<string> {
  return new Set(fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name));
}

/**
 * Find the build output after the build has run.
 * 1. Preferred names that contain index.html.
 * 2. Any directory created during the build that contains index.html.
 */
export function postBuildScan(root: string, before: Set<string>): string | null {
  const hasIndex = (dir: string) => fs.existsSync(path.join(root, dir, "index.html"));
  for (const dir of PREFERRED) if (fs.existsSync(path.join(root, dir)) && hasIndex(dir)) return dir;
  const after = snapshotDirs(root);
  for (const dir of after) if (!before.has(dir) && !IGNORE.has(dir) && hasIndex(dir)) return dir;
  return null;
}
```

- **A candidate must contain `index.html`.** That's what makes a folder a website root; a `dist/` holding only a library bundle doesn't qualify.
- **Common names first.** `dist`, `build`, `out` and the rest cover almost every tool, and checking them in a fixed order gives the same answer on every run.
- **Then directories the build created.** `snapshotDirs` records the top-level folders before the build (the pipeline's detect step calls it), and anything new afterwards is output the build produced. `public/` usually exists before the build as a source folder, which is why "new since the snapshot" is a better signal than any name.
- **`IGNORE`** skips folders that are never the answer: dependencies, caches, and framework working folders like `.next/` and `.svelte-kit/`.

### `index.ts`

The entry point: combines the pieces above into one `DetectResult`, with the project's overrides applied last.

```ts
import fs from "node:fs";
import path from "node:path";
import type { DetectResult, ProjectOverrides } from "./types.js";
import { readPackageJson, detectPackageManager, frameworkFromDeps, DEFAULT_OUTPUT, installCommandFor, buildCommandFor, nodeVersionFromEngines } from "./packageJson.js";
import { viteOutDir, nextConfig, vueCliOutputDir, svelteKitConfig, astroOutDir } from "./configParsers.js";

export * from "./types.js";
export { postBuildScan, snapshotDirs } from "./postBuildScan.js";

export function detectFramework(root: string, overrides: ProjectOverrides = {}): DetectResult {
  const warnings: string[] = [];
  const pkg = readPackageJson(root);

  // Plain static site: no package.json, or no build script.
  if (!pkg.exists || !pkg.scripts.build) {
    if (pkg.exists) warnings.push('package.json has no "build" script — treating as a static site.');
    if (!fs.existsSync(path.join(root, overrides.outputDir ?? ".", "index.html"))) {
      warnings.push("No index.html found at the site root.");
    }
    return {
      framework: "static", packageManager: "npm",
      installCmd: overrides.installCmd ?? null,
      buildCmd: overrides.buildCmd ?? null,
      outputDir: overrides.outputDir ?? ".",
      nodeVersion: (overrides.nodeVersion as any) ?? "22",
      warnings,
    };
  }

  const packageManager = detectPackageManager(root);
  const framework = frameworkFromDeps(pkg.deps);
  let outputDir: string | null = DEFAULT_OUTPUT[framework];

  switch (framework) {
    case "vite": outputDir = viteOutDir(root) ?? outputDir; break;
    case "next": {
      const config = nextConfig(root);
      if (!config.isExport) warnings.push("Next.js: `output: 'export'` not found in next.config — only static export is supported. The build may succeed but produce no `out/` directory.");
      if (config.distDir) warnings.push(`Next.js: custom distDir "${config.distDir}" ignored; static export always writes to out/.`);
      break;
    }
    case "vue-cli": outputDir = vueCliOutputDir(root) ?? outputDir; break;
    case "sveltekit": {
      const config = svelteKitConfig(root);
      if (!config.usesStaticAdapter) warnings.push("SvelteKit: @sveltejs/adapter-static not detected — a static build requires it.");
      outputDir = config.pages ?? outputDir;
      break;
    }
    case "astro": outputDir = astroOutDir(root) ?? outputDir; break;
    case "unknown": warnings.push("Framework not recognised; will run `npm run build` and look for an output directory afterwards."); break;
  }

  return {
    framework, packageManager,
    installCmd: overrides.installCmd ?? installCommandFor(packageManager, root),
    buildCmd: overrides.buildCmd ?? buildCommandFor(packageManager),
    outputDir: overrides.outputDir ?? outputDir,
    nodeVersion: (overrides.nodeVersion as any) ?? nodeVersionFromEngines(pkg.engines) ?? "22",
    warnings,
  };
}
```

1. **Static sites first.** With no `package.json`, or one without a `build` script, there's nothing to build: the repo is uploaded as it is, from its root. `installCmd` and `buildCmd` are `null` so the build container is skipped entirely. A missing `index.html` is a warning, not an error, because the user's `outputDir` override may point somewhere else.
2. **Otherwise, framework defaults**, then the framework's config file if it moves the output folder.
3. **Overrides always win.** Each field is `override ?? detected`, so a user can fix a wrong guess one field at a time without having to specify everything.

It never throws for an unrecognised project. An `unknown` framework still gets `npm run build` and a post-build scan, which is enough for most custom setups.

### Unit tests — `apps/worker/src/detect/__tests__/detect.test.ts`

One test per fixture (Step 6), each covering one path through `detectFramework`: default output, a config-file override, a framework with its own rules (Next), the static path, and a project override winning. They read the fixture folders straight from disk, so they need no network, Docker or database.

```ts
import { describe, it, expect } from "vitest";
import path from "node:path";
import { detectFramework } from "../index.js";

const fixture = (name: string) => path.resolve(__dirname, "../../../../../fixtures", name);

describe("detectFramework", () => {
  it("vite react", () => {
    const result = detectFramework(fixture("vite-react"));
    expect(result).toMatchObject({ framework: "vite", outputDir: "dist", buildCmd: "npm run build" });
  });
  it("vite custom outDir", () => expect(detectFramework(fixture("vite-custom-outdir")).outputDir).toBe("public_html"));
  it("next export", () => {
    const result = detectFramework(fixture("next-export"));
    expect(result.framework).toBe("next"); expect(result.outputDir).toBe("out"); expect(result.warnings).toHaveLength(0);
  });
  it("cra", () => expect(detectFramework(fixture("cra")).outputDir).toBe("build"));
  it("sveltekit static", () => expect(detectFramework(fixture("sveltekit-static")).outputDir).toBe("build"));
  it("plain html", () => {
    const result = detectFramework(fixture("plain-html"));
    expect(result).toMatchObject({ framework: "static", installCmd: null, buildCmd: null, outputDir: "." });
  });
  it("overrides win", () => expect(detectFramework(fixture("vite-react"), { outputDir: "custom" }).outputDir).toBe("custom"));
});
```

---

## Step 4 — Worker

The worker takes build jobs off the queue and turns a repo URL into files in object storage. Each job goes through the same steps, each one a function in `pipeline/`:

```text
clone → detect → build (in a sandboxed container) → resolve output → upload → promote
```

The worker process itself never runs the user's code. `npm install` and `npm run build` run in a separate, locked-down container that the worker starts through the Docker socket and removes when it's done. The worker only reads the results from a shared directory.

Each step takes a shared `BuildContext`, reads what earlier steps left there and adds its own results. Each step reports failure by throwing a `PipelineError`, and `runPipeline` handles every failure in one place.

`apps/worker/package.json` dependencies: `bullmq`, `ioredis`, `dockerode`, `simple-git`, `fast-glob`, `p-limit`, `pino`, `zod`; dev: `@types/dockerode`, plus `@shipyard/db` and `@shipyard/shared` as `workspace:*` devDependencies (Phase 0 explains why they are dev: so tsdown inlines them).

`zod` is new: `clients.ts` below extends the env schema with it, and Phase 0's worker didn't need it. Add it with `pnpm --filter @shipyard/worker add zod`.

`ioredis` is listed explicitly because BullMQ 6 declares it as an *optional* peer dependency rather than bundling it (see Phase 0). Without it, `new Worker(...)` throws at connect time.

### `apps/worker/src/lib/clients.ts`

```ts
import Docker from "dockerode";
import pino from "pino";
import { loadEnv } from "@shipyard/shared/env";
import { S3Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
import { z } from "zod";

export const env = loadEnv({
  BUILD_CONCURRENCY: z.coerce.number().default(2),
  BUILD_TIMEOUT_MS: z.coerce.number().default(15 * 60_000),
  BUILD_MEMORY_BYTES: z.coerce.number().default(2 * 1024 ** 3),
  BUILD_CPUS: z.coerce.number().default(2),
  BUILD_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  BUILD_TMP_SIZE: z.string().regex(/^\d+[kmg]$/).default("1g"),   // Docker tmpfs size, e.g. "512m"
  BUILDS_DIR: z.string().default("/builds"),          // path inside the worker container
  BUILDS_HOST_PATH: z.string(),                        // same directory as seen by the Docker daemon
  BUILD_NETWORK: z.string().default("shipyard_build_egress"),
  BUILDER_IMAGE_PREFIX: z.string().default("shipyard/builder:node"),
});

export const log = pino({ level: env.LOG_LEVEL });
export const storage: ObjectStore = new S3Storage(env);
export const redis = createRedis(env.REDIS_URL);
redis.on("error", err => log.error({ err }, "redis error"));   // without a listener ioredis console.errors every reconnect
export const docker = new Docker({ socketPath: "/var/run/docker.sock" });
```

The build limits are environment variables so CI can shorten the timeout (Step 7) and a larger machine can raise concurrency without code changes:

| Variable | Why |
|---|---|
| `BUILD_CONCURRENCY` | Builds running at once per worker. Each can use `BUILD_CPUS` cores and `BUILD_MEMORY_BYTES`, so this bounds total load on the host. |
| `BUILD_TIMEOUT_MS` | Hard limit per build. Stops a hung or looping build (the `hang` fixture) from holding a slot forever. |
| `BUILD_MEMORY_BYTES`, `BUILD_CPUS` | Per-container limits, so one heavy build can't starve the others or the host. |
| `BUILD_PIDS_LIMIT`, `BUILD_TMP_SIZE` | Maximum processes (stops fork bombs) and the size of the in-memory `/tmp`. Raise the `/tmp` size for builds that unpack large toolchains there. |
| `BUILDS_DIR`, `BUILDS_HOST_PATH` | The shared folder where repos are cloned, as two paths (see below). |
| `BUILD_NETWORK` | The Docker network build containers join: internet access for `npm install`, no route to Postgres, Redis or MinIO (Phase 0). |
| `BUILDER_IMAGE_PREFIX` | Prefix of the builder image; the Node version is appended (`…node22`). |

`docker` talks to the host's Docker daemon through the mounted socket. Containers the worker creates are **siblings** of the worker container on the host, not children inside it ("Docker-out-of-Docker"). That's why paths need translating: when the worker asks Docker to mount a folder, Docker looks for that folder on the host, not inside the worker container.

**Fix `docker/compose.yaml` before this runs.** `BUILDS_DIR` and `BUILDS_HOST_PATH` must name the *same* directory, seen from inside the worker and from the Docker daemon respectively. Phase 0's compose file has them disagree: the volume `./data/builds:/builds` is resolved relative to the compose file (`docker/data/builds`), while `BUILDS_HOST_PATH: ${PWD}/data/builds` is resolved from the directory compose runs in (the repo root under `pnpm infra:up`, so `data/builds`). Build containers would bind-mount an empty directory and every build would fail with a missing `package.json`. Make both use `${PWD}`:

```yaml
    environment:
      BUILDS_HOST_PATH: ${PWD}/data/builds
    volumes:
      - ${PWD}/data/builds:/builds
```

and add `/data` to `.gitignore`. `${PWD}` is the repo root only when compose is started through the root `pnpm` scripts, so always use `pnpm infra:up` rather than running `docker compose` from another directory.

### `apps/worker/src/lib/logs.ts`

Build output has to be readable in two ways: **live**, while the build runs (Phase 2's dashboard streams it), and **from the start**, by someone who opens the page halfway through. Each line is therefore written twice: appended to a Redis list (history) and published on a pub/sub channel (live). Phase 2's log endpoint reads the list first, then follows the channel.

```ts
import { keys } from "@shipyard/shared/redis";
import { LOG_TTL_SECONDS } from "@shipyard/shared/constants";
import { redis } from "./clients.js";

export class BuildLogger {
  private buffer: string[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private deploymentId: string) {}

  line(step: string, text: string) {
    const entry = `[${step}] ${text}`;
    this.buffer.push(entry);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50);   // batch bursts of output
  }

  async flush() {
    this.timer = undefined;
    if (!this.buffer.length) return;
    const lines = this.buffer.splice(0);
    const key = keys.logs(this.deploymentId);
    const tx = redis.multi().rpush(key, ...lines).expire(key, LOG_TTL_SECONDS);
    for (const entry of lines) tx.publish(key, entry);
    await tx.exec();
  }

  /** Attach a container stream and split it into lines. */
  pipe(step: string, stream: NodeJS.ReadableStream) {
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const part of parts) if (part.length) this.line(step, part);
    });
    stream.on("end", () => { if (rest) this.line(step, rest); });
  }

  async all(): Promise<string[]> { await this.flush(); return redis.lrange(keys.logs(this.deploymentId), 0, -1); }
}
```

- **Lines are buffered for 50 ms.** An `npm install` can print hundreds of lines per second. Sending one Redis request per line would be slow and would flood subscribers, so lines are collected briefly and sent together. The first line starts the timer; lines arriving before it fires join that batch.
- **One `MULTI` per batch.** `RPUSH`, `EXPIRE` and the `PUBLISH`es go in one round trip and run together. The TTL is refreshed on each batch, so it counts from the last line, not the first.
- **Every line is prefixed with its step** (`[clone]`, `[build]`, `[error]`), so the user can see where a failure happened.
- **`pipe` splits a stream into lines.** Container output arrives in chunks that don't line up with newlines: one chunk can end mid-line. The unfinished tail is kept in `rest` and joined to the next chunk, and flushed when the stream ends. Empty lines are dropped.
- **`flush` is awaited before important moments** (end of the build, end of the pipeline), so the last lines are in Redis before the status changes.
- **`all`** returns the full log. Phase 2 uses it to archive the log to `_logs.txt`.

### `apps/worker/src/lib/status.ts`

The only way the worker changes a deployment's status. It enforces the allowed transitions and announces each change.

```ts
import { prisma, DeploymentStatus } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { redis } from "./clients.js";

const ALLOWED: Record<DeploymentStatus, DeploymentStatus[]> = {
  queued: ["cloning", "cancelled", "failed"],
  cloning: ["detecting", "failed", "cancelled"],
  detecting: ["building", "uploading", "failed", "cancelled"],
  building: ["uploading", "failed", "cancelled"],
  uploading: ["ready", "failed", "cancelled"],
  ready: ["archived"], failed: [], cancelled: [], archived: [],
};

export async function setStatus(id: string, status: DeploymentStatus, extra: Record<string, unknown> = {}) {
  const current = await prisma.deployment.findUniqueOrThrow({ where: { id }, select: { status: true } });
  if (!ALLOWED[current.status].includes(status)) throw new Error(`illegal transition ${current.status} → ${status}`);
  const updated = await prisma.deployment.update({ where: { id }, data: { status, ...extra } });
  await redis.publish(keys.status(id), status);
  return updated;
}
```

- **`ALLOWED` is a state machine.** Statuses only move forward, and `failed`, `cancelled` and `archived` are final. That blocks bugs like a build cancelled by the user (Phase 4) later being marked `ready` by a step that was still finishing, or a redelivered job restarting a finished deployment.
- **`detecting → uploading`** is allowed so a pipeline can skip `building` for sites with nothing to build. The Phase 1 pipeline always goes through `building` (where `build` returns immediately for a static site), so this path isn't used yet.
- **An illegal transition throws** instead of being ignored, so the bug shows up in the worker log.
- **`extra`** lets a status change and related fields (`startedAt`, `finishedAt`, `error`) be written in one update, so no reader sees `failed` without its error message.
- **`publish` after the update** tells listeners (Phase 2's live dashboard) to refresh. The message is only the new status; listeners read the row for anything else.

### `apps/worker/src/lib/paths.ts`

Two project settings are paths the user types: `rootDir` and `outputDir`. The pipeline resolves each one against a folder it controls and must refuse any result that lands outside that folder. This helper is the single check both places use.

```ts
import path from "node:path";

/** True when `child` is `parent` itself or somewhere below it. Both must be absolute. */
export function isInside(parent: string, child: string) {
  return child === parent || child.startsWith(parent + path.sep);
}
```

The `+ path.sep` is the important part. A plain `child.startsWith(parent)` accepts `/builds/abc123` as being inside `/builds/abc`, so `rootDir: "../abc123"` would reach another build's folder whenever one deployment's id is a prefix of another's. Requiring the separator means only real subfolders match. Both arguments come from `path.resolve`, which has already removed `..`, `.` and repeated or trailing separators, so plain string comparison is enough.

### `apps/worker/src/pipeline/context.ts`

The state one build carries from step to step. Passing one object keeps every step's signature the same (`(ctx) => Promise<void>`), so steps can be added or reordered easily.

```ts
import type { Deployment, Project } from "@shipyard/db";
import type { ObjectWriter } from "@shipyard/shared/storage";
import type { DetectResult } from "../detect/index.js";
import type { BuildLogger } from "../lib/logs.js";

export interface BuildContext {
  deployment: Deployment;
  project: Project;
  store: ObjectWriter;    // injected; upload only needs put()
  workDir: string;        // inside worker container: /builds/<id>
  hostWorkDir: string;    // same dir as the Docker daemon sees it
  repoRoot: string;       // workDir + project.rootDir
  gitToken?: string;      // Phase 3
  envVars: string[];      // Phase 3 ("KEY=value")
  detect?: DetectResult;
  dirsBefore?: Set<string>;
  outputPath?: string;
  logger: BuildLogger;
  signal: AbortSignal;    // Phase 4 cancellation
}
```

- **Fixed fields** are set by `runPipeline` before the first step: the rows, the store, the paths, the logger.
- **Optional fields** are filled in as the build progresses: `detect` and `dirsBefore` by the detect step, `outputPath` by `resolveOutput`. A step that reads one uses `!` (`ctx.detect!`) because the order of steps guarantees it was set.
- **`workDir` and `hostWorkDir` are the same folder** under two names: the path inside the worker container, used for reading and writing files, and the path on the host, used when telling Docker what to mount.
- **`store` is an `ObjectWriter`**, not the full store, because the pipeline only uploads.
- **`gitToken`, `envVars` and `signal`** are placeholders filled in by later phases (private repos, user environment variables, cancellation). They're in the type now so the steps don't change shape later.

### `apps/worker/src/pipeline/clone.ts`

Downloads the repo into a fresh folder and records which commit is being built.

```ts
import { simpleGit } from "simple-git";
import fs from "node:fs/promises";
import { CloneError } from "@shipyard/shared/errors";
import { prisma } from "@shipyard/db";
import type { BuildContext } from "./context.js";

export async function clone(ctx: BuildContext) {
  const { project, logger } = ctx;
  await fs.rm(ctx.workDir, { recursive: true, force: true });
  await fs.mkdir(ctx.workDir, { recursive: true });

  const url = ctx.gitToken
    ? project.repoUrl.replace("https://github.com/", `https://x-access-token:${ctx.gitToken}@github.com/`)
    : project.repoUrl;

  logger.line("clone", `Cloning ${project.repoUrl} (branch ${project.branch})`);
  try {
    await simpleGit().clone(url, ctx.workDir, ["--depth", "1", "--branch", project.branch, "--single-branch"]);
  } catch (e: any) {
    // Never echo the URL back: it may contain the token.
    throw new CloneError(String(e?.message ?? e).replace(/x-access-token:[^@]+@/g, ""), project.branch);
  }

  const git = simpleGit(ctx.workDir);
  const head = await git.log({ maxCount: 1 });
  const commit = head.latest;
  logger.line("clone", `Checked out ${commit?.hash.slice(0, 7)} — ${commit?.message}`);
  await prisma.deployment.update({ where: { id: ctx.deployment.id }, data: { commitSha: commit?.hash, commitMsg: commit?.message } });
  await fs.rm(`${ctx.workDir}/.git`, { recursive: true, force: true });   // not needed in the build; keeps the mount smaller
}
```

- **Start from an empty folder.** A leftover folder from a crashed earlier attempt would make `git clone` fail ("destination path already exists") or mix old files into the build.
- **`--depth 1 --single-branch`** downloads only the latest commit of one branch. A build doesn't need history, and for a large repo this is much faster.
- **The token goes in the URL** (Phase 3, private repos), which is how GitHub accepts an app token over HTTPS. Git error messages often repeat the URL, so the token is removed from the message before it's thrown and could reach a log.
- **The commit is read after cloning.** The API only knows the branch; the actual commit hash and message are only known now. They're saved on the deployment so its history shows exactly what was built.
- **`.git` is deleted after reading the commit.** The build doesn't need it, and deleting it means build scripts can't read repository metadata (including a Phase 3 token saved in `.git/config`).

### `apps/worker/src/pipeline/detect.ts`

Runs framework detection on the cloned repo, logs the result, and saves it on the deployment.

```ts
import { prisma } from "@shipyard/db";
import { detectFramework, snapshotDirs } from "../detect/index.js";
import type { BuildContext } from "./context.js";

export async function detect(ctx: BuildContext) {
  const { project, logger } = ctx;
  const detected = detectFramework(ctx.repoRoot, {
    installCmd: project.installCmd, buildCmd: project.buildCmd, outputDir: project.outputDir, nodeVersion: project.nodeVersion,
  });
  ctx.detect = detected;
  ctx.dirsBefore = snapshotDirs(ctx.repoRoot);
  logger.line("detect", `Framework: ${detected.framework} · package manager: ${detected.packageManager} · node ${detected.nodeVersion}`);
  logger.line("detect", `Install: ${detected.installCmd ?? "(skip)"} · Build: ${detected.buildCmd ?? "(skip)"} · Output: ${detected.outputDir ?? "(auto)"}`);
  for (const warning of detected.warnings) logger.line("warn", warning);
  await prisma.deployment.update({
    where: { id: ctx.deployment.id },
    data: { framework: detected.framework, resolvedBuildCmd: detected.buildCmd, resolvedOutputDir: detected.outputDir },
  });
}
```

- **Project settings go in as overrides**, so detection only fills in what the user left empty.
- **`snapshotDirs` runs here, before the build**, because `postBuildScan` needs to know which folders existed beforehand to spot the ones the build created.
- **The result is logged, including warnings.** When a build fails, the first thing to check is what the platform thought it was building; this puts it at the top of the log.
- **The result is saved on the deployment row.** Project settings can change later, but each deployment records what was actually used for it.

### `apps/worker/src/pipeline/containerSpec.ts`

Builds the options `build.ts` passes to `docker.createContainer`. It's a separate, pure function so the sandbox can be read in one place and unit-tested without Docker.

The options fall into three groups, and each is kept somewhere different on purpose:

| Group | Fields | Comes from |
|---|---|---|
| Sandbox | `User`, `ReadonlyRootfs`, `CapDrop`, `SecurityOpt`, `AutoRemove` | Constants in this file. Not configurable. |
| Limits | `Memory`/`MemorySwap`, `NanoCpus`, `PidsLimit`, `/tmp` size, `NetworkMode` | Env vars (`clients.ts`), so each host can be sized to its hardware. |
| Per build | `Image`, `Cmd`, `Binds`, `Env`, `Labels` | The build context. |

```ts
import type { ContainerCreateOptions, HostConfig } from "dockerode";

/** The only sandbox knobs an operator may tune; `build.ts` fills them from env. */
export interface BuildLimits {
  memoryBytes: number;   // hard cap: swap is disabled
  cpus: number;          // fractions allowed, e.g. 1.5
  pidsLimit: number;
  tmpSize: string;       // Docker format, e.g. "1g" or "512m"
  network: string;
}

export interface ContainerSpecInput {
  image: string;
  cmd: string;
  hostRepoRoot: string;  // repo root as the Docker daemon sees it; mounted at /app
  envVars: string[];     // "KEY=value"
  deploymentId: string;
  projectId: string;
  limits: BuildLimits;
}

const SANDBOX_USER = "1000:1000";

/** Isolation every build gets. Deliberately not configurable: change it only in code review. */
const SANDBOX_HOST_CONFIG = {
  ReadonlyRootfs: true,
  CapDrop: ["ALL"],
  SecurityOpt: ["no-new-privileges"],
  AutoRemove: true,
} satisfies HostConfig;

export function buildContainerSpec(input: ContainerSpecInput): ContainerCreateOptions {
  const { limits } = input;
  return {
    Image: input.image,
    Cmd: ["sh", "-c", input.cmd],
    WorkingDir: "/app",
    User: SANDBOX_USER,
    Env: [...input.envVars, "CI=true", "HOME=/tmp"],
    Labels: { "shipyard.deployment": input.deploymentId, "shipyard.project": input.projectId },
    AttachStdout: true, AttachStderr: true, Tty: false,
    HostConfig: {
      Binds: [`${input.hostRepoRoot}:/app`],
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes,             // equal to Memory: no swap
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.pidsLimit,
      Tmpfs: { "/tmp": `rw,exec,size=${limits.tmpSize}` },   // exec: some tools write binaries to $TMPDIR
      NetworkMode: limits.network,
      ...SANDBOX_HOST_CONFIG,                     // last, so nothing above can override the sandbox
    },
  };
}
```

**Why not a config file.** These containers run strangers' code. If `CapDrop` or `ReadonlyRootfs` lived in an editable file, one edit could switch isolation off without anyone reviewing it, and a separate file would lose the type checking dockerode's types give here. Limits that really do vary by host are env vars, validated by zod like every other setting. If limits ever need to vary per project (a paid plan with bigger builds), store them on the `Project` row and cap them at the env value.

**The limits are passed in** rather than read from `env`, because importing `clients.ts` opens Redis and Docker connections and exits on missing env vars, which a unit test shouldn't need. `NanoCpus` is rounded because Docker rejects a fractional value, which `BUILD_CPUS=1.3` would otherwise produce.

**Environment.** `CI=true` puts tools into non-interactive mode (no prompts, no progress spinners in the logs). Note that Create React App also treats lint warnings as errors when `CI=true`. `HOME=/tmp` gives npm, pnpm and yarn a writable place for their caches: the image's file system is read-only, and user 1000 has no home folder.

**Sandbox settings.** Each option closes off one way a hostile or broken build could affect the host or other builds:

| Setting | What it prevents |
|---|---|
| `User: "1000:1000"` | Running as root inside the container. |
| `Memory` = `MemorySwap` | Using more than the memory limit, including by swapping to disk. Over the limit, the kernel kills the build. |
| `NanoCpus` | Using more than `BUILD_CPUS` cores. |
| `PidsLimit` | A fork bomb exhausting the host's process table (`BUILD_PIDS_LIMIT`, default 512). |
| `ReadonlyRootfs` + `Tmpfs /tmp` | Changing the image. The only writable places are the mounted repo and an in-memory `/tmp` (`BUILD_TMP_SIZE`, default 1 GB). |
| `CapDrop: ["ALL"]`, `no-new-privileges` | Using Linux capabilities (raw sockets, mount, …) or gaining privileges through setuid binaries. |
| `NetworkMode: BUILD_NETWORK` | Reaching Postgres, Redis or MinIO. The build can reach the internet to download packages. |
| `AutoRemove` | Stopped containers piling up. Docker deletes the container when it exits. |
| `Labels` | Losing track of containers. Phase 4's cleanup job finds leftover build containers by label. |

The test pins these guarantees, so a change that weakens the sandbox fails CI instead of slipping through:

```ts
// apps/worker/src/pipeline/__tests__/containerSpec.test.ts
import { describe, it, expect } from "vitest";
import { buildContainerSpec, type ContainerSpecInput } from "../containerSpec";

const input: ContainerSpecInput = {
  image: "shipyard/builder:node22", cmd: "npm ci && npm run build", hostRepoRoot: "/host/builds/d1",
  envVars: ["API_URL=https://example.com"], deploymentId: "d1", projectId: "p1",
  limits: { memoryBytes: 2 * 1024 ** 3, cpus: 1.5, pidsLimit: 256, tmpSize: "512m", network: "shipyard_build_egress" },
};

describe("buildContainerSpec", () => {
  const spec = buildContainerSpec(input);

  // If one of these fails, a change has weakened build isolation: make sure that was intended.
  it("keeps the sandbox locked down", () => {
    expect(spec.User).toBe("1000:1000");
    expect(spec.HostConfig).toMatchObject({ ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges"], AutoRemove: true });
  });
  it("disables swap", () => expect(spec.HostConfig?.MemorySwap).toBe(spec.HostConfig?.Memory));
  it("applies the host's limits", () =>
    expect(spec.HostConfig).toMatchObject({ Memory: 2 * 1024 ** 3, NanoCpus: 1_500_000_000, PidsLimit: 256, Tmpfs: { "/tmp": "rw,exec,size=512m" }, NetworkMode: "shipyard_build_egress" }));
  it("mounts the repo and runs the command in it", () => {
    expect(spec.HostConfig?.Binds).toEqual(["/host/builds/d1:/app"]);
    expect(spec.WorkingDir).toBe("/app");
    expect(spec.Cmd).toEqual(["sh", "-c", "npm ci && npm run build"]);
  });
  it("passes user env vars through and labels the container", () => {
    expect(spec.Env).toEqual(["API_URL=https://example.com", "CI=true", "HOME=/tmp"]);
    expect(spec.Labels).toEqual({ "shipyard.deployment": "d1", "shipyard.project": "p1" });
  });
});
```

### `apps/worker/src/pipeline/build.ts`

Runs the install and build commands inside a new container. This is the only step that executes code from the repo; the container it creates is the sandbox defined in `containerSpec.ts`.

```ts
import { PassThrough } from "node:stream";
import { BuildFailedError, BuildTimeoutError, BuildCancelledError } from "@shipyard/shared/errors";
import { docker, env, log } from "../lib/clients.js";
import type { BuildContext } from "./context.js";
import { buildContainerSpec } from "./containerSpec.js";

export async function build(ctx: BuildContext) {
  const detected = ctx.detect!;
  if (!detected.installCmd && !detected.buildCmd) { ctx.logger.line("build", "Static site — nothing to build."); return; }

  const cmd = [detected.installCmd, detected.buildCmd].filter(Boolean).join(" && ");
  const image = `${env.BUILDER_IMAGE_PREFIX}${detected.nodeVersion}`;
  const hostRepoRoot = ctx.hostWorkDir + ctx.repoRoot.slice(ctx.workDir.length);
  ctx.logger.line("build", `$ ${cmd}`);

  const container = await docker.createContainer(buildContainerSpec({
    image, cmd, hostRepoRoot,
    envVars: ctx.envVars,
    deploymentId: ctx.deployment.id,
    projectId: ctx.project.id,
    limits: {
      memoryBytes: env.BUILD_MEMORY_BYTES,
      cpus: env.BUILD_CPUS,
      pidsLimit: env.BUILD_PIDS_LIMIT,
      tmpSize: env.BUILD_TMP_SIZE,
      network: env.BUILD_NETWORK,
    },
  }));

  const stream = await container.attach({ stream: true, stdout: true, stderr: true });
  const stdout = new PassThrough(), stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  ctx.logger.pipe("build", stdout);
  ctx.logger.pipe("build", stderr);

  await container.start();

  let timedOut = false, cancelled = false;
  const timer = setTimeout(() => { timedOut = true; container.kill().catch(() => {}); }, env.BUILD_TIMEOUT_MS);
  const onAbort = () => { cancelled = true; container.kill().catch(() => {}); };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const { StatusCode } = await container.wait();
    await ctx.logger.flush();
    if (cancelled) throw new BuildCancelledError();
    if (timedOut) throw new BuildTimeoutError(env.BUILD_TIMEOUT_MS);
    if (StatusCode !== 0) throw new BuildFailedError(StatusCode);
    ctx.logger.line("build", "Build finished successfully.");
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    log.debug({ deploymentId: ctx.deployment.id }, "container finished");
  }
}
```

**The command.** Install and build run as one `sh -c "install && build"` in a single container: `&&` stops at the first failure, and one container is faster than two. A static site with neither command skips the container entirely. `hostRepoRoot` translates the repo path into the host's view of the same folder (see `clients.ts`), and it's mounted at `/app`.

**Output.** The stream is attached *before* `start()`, so no output from the first moments is lost. Without a TTY, Docker sends stdout and stderr interleaved on one stream with small headers; `demuxStream` separates them. Both go to the build log.

**Ending.** `container.wait()` resolves when the process exits, with its exit code. Two things can make it exit early: the timeout and a cancel signal (Phase 4). Both kill the container and set a flag. After `wait` returns, the flags decide which error to throw: a killed container also has a non-zero exit code, and without the flags a timeout would be reported as "build failed with exit code 137". The `finally` block always clears the timer and removes the abort listener, so a finished build leaves no timer running.

### `apps/worker/src/pipeline/resolveOutput.ts`

Decides which folder of the built repo is the website, now that the build has run.

```ts
import fs from "node:fs";
import path from "node:path";
import { OutputNotFoundError } from "@shipyard/shared/errors";
import { prisma } from "@shipyard/db";
import { postBuildScan } from "../detect/index.js";
import { isInside } from "../lib/paths.js";
import type { BuildContext } from "./context.js";

export async function resolveOutput(ctx: BuildContext) {
  const detected = ctx.detect!;
  let out = detected.outputDir;
  const tried: string[] = [];

  // No escaping the repo: checked before anything outside it is even looked at.
  if (out && !isInside(ctx.repoRoot, path.resolve(ctx.repoRoot, out))) throw new OutputNotFoundError([out]);

  if (out && !fs.existsSync(path.join(ctx.repoRoot, out, "index.html"))) { tried.push(out); out = null; }
  if (!out) {
    out = postBuildScan(ctx.repoRoot, ctx.dirsBefore ?? new Set());
    if (out) ctx.logger.line("output", `Auto-detected output directory: ${out}/`);
  }
  if (!out) throw new OutputNotFoundError([...tried, "dist", "build", "out", "public"]);

  const abs = path.resolve(ctx.repoRoot, out);
  ctx.outputPath = abs;
  ctx.logger.line("output", `Using ${out}/`);
  await prisma.deployment.update({ where: { id: ctx.deployment.id }, data: { resolvedOutputDir: out } });
}
```

1. **Stay inside the repo.** `outputDir` is user input, and a value like `../../etc` would otherwise upload files from outside the repo. It's checked with `isInside` (see `lib/paths.ts`) before anything else, so nothing outside the repo is read, even to check whether a file exists. Folders found by `postBuildScan` are top-level names inside the repo, so they don't need the check.
2. **Check the expected folder.** The folder from detection (or the user's setting) is accepted only if it contains `index.html`. A folder that exists but has no `index.html` is noted in `tried`.
3. **Fall back to the scan.** If there was no expected folder, or it didn't qualify, `postBuildScan` looks at what the build produced.
4. **Fail with the list of what was tried**, so the error message tells the user exactly where the platform looked and that they can set "Output directory".

The final choice is saved again on the deployment, replacing the detection guess with what was actually used.

### `apps/worker/src/pipeline/upload.ts`

Copies every file in the output folder to object storage under the deployment's prefix. Once this finishes, the deployment is complete and can be served, though nothing points to it yet.

```ts
import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import pLimit from "p-limit";
import { prisma } from "@shipyard/db";
import { contentTypeFor, cacheControlFor } from "@shipyard/shared/contentType";
import { metaKey } from "@shipyard/shared/storageKeys";
import type { BuildContext } from "./context.js";

const EXCLUDE = ["**/node_modules/**", "**/.git/**", "**/.env", "**/.env.*", "**/*.map"];

export async function upload(ctx: BuildContext) {
  const root = ctx.outputPath!;
  const files = await fg("**/*", { cwd: root, onlyFiles: true, dot: true, ignore: EXCLUDE });
  if (!files.length) throw new Error("output directory is empty");

  const limit = pLimit(16);
  let bytes = 0;
  ctx.logger.line("upload", `Uploading ${files.length} files…`);

  await Promise.all(files.map(rel => limit(async () => {
    const abs = path.join(root, rel);
    const size = (await fs.promises.stat(abs)).size;
    bytes += size;
    await ctx.store.put(ctx.deployment.storagePrefix + rel, fs.createReadStream(abs), {
      contentType: contentTypeFor(rel), cacheControl: cacheControlFor(rel), contentLength: size,
    });
  })));

  const meta = { fileCount: files.length, sizeBytes: bytes, framework: ctx.detect?.framework, outputDir: ctx.detect?.outputDir };
  await ctx.store.put(metaKey(ctx.deployment.storagePrefix), Buffer.from(JSON.stringify(meta)), { contentType: "application/json" });
  await prisma.deployment.update({ where: { id: ctx.deployment.id }, data: { fileCount: files.length, sizeBytes: BigInt(bytes) } });
  ctx.logger.line("upload", `Uploaded ${files.length} files (${(bytes / 1024).toFixed(0)} KB).`);
}
```

- **`EXCLUDE`** keeps out files that shouldn't be public even if they end up in the output folder: `.env` files (often secrets), `node_modules`, `.git`, and source maps. Source maps would let anyone read the site's original source code.
- **`dot: true`** includes dotfiles, because sites need some of them (for example `.well-known/` for domain verification).
- **An empty folder is an error.** Publishing it would replace a working site with a blank one.
- **`pLimit(16)`** uploads 16 files at a time. One at a time is slow for sites with thousands of files; all at once would open thousands of connections and file handles.
- **Files are streamed**, not read into memory, so a large video or bundle doesn't use its full size in RAM. `contentLength` is set because S3 needs the size up front for a stream.
- **Keys use `ctx.deployment.storagePrefix`**, the value saved on the row, not one computed from the id (see `storageKeys.ts`).
- **Each deployment has its own prefix, and nothing is ever overwritten.** The live site keeps serving the previous deployment's files while this one uploads. That is what makes promote (next) an instant switch and a rollback a pointer change.
- **`_meta.json`** is a summary stored next to the files, so a deployment can be inspected from storage alone.

### `apps/worker/src/pipeline/promote.ts`

Marks the deployment `ready` and, if nothing newer is live or built, makes it the project's live site.

```ts
import { prisma, type Deployment } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { ROUTE_TTL_SECONDS } from "@shipyard/shared/constants";
import { env, log, redis } from "../lib/clients.js";
import { setStatus } from "../lib/status.js";
import type { BuildContext } from "./context.js";

/** Returns null if the deployment is now live, otherwise the id of the newer deployment that blocked it. */
async function makeLive(deployment: Deployment): Promise<string | null> {
  return prisma.$transaction(async tx => {
    // Concurrent promotions of this project wait here until this one commits.
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${deployment.projectId} FOR UPDATE`;

    const { activeDeployment } = await tx.project.findUniqueOrThrow({
      where: { id: deployment.projectId },
      select: { activeDeployment: { select: { id: true, createdAt: true } } },
    });
    if (activeDeployment && activeDeployment.createdAt > deployment.createdAt) return activeDeployment.id;

    const newer = await tx.deployment.findFirst({
      where: { projectId: deployment.projectId, kind: "production", status: "ready", createdAt: { gt: deployment.createdAt } },
      select: { id: true },
    });
    if (newer) return newer.id;

    await tx.project.update({ where: { id: deployment.projectId }, data: { activeDeploymentId: deployment.id } });
    return null;
  });
}

export async function promote(ctx: BuildContext) {
  const { deployment, project } = ctx;
  await setStatus(deployment.id, "ready", { finishedAt: new Date() });

  let blockedBy: string | null;
  try {
    blockedBy = await makeLive(deployment);
  } catch (err) {
    log.error({ err, deploymentId: deployment.id }, "promotion failed");
    ctx.logger.line("promote", "The build succeeded, but making it live failed. Promote it from the dashboard to try again.");
    return;
  }
  if (blockedBy) { ctx.logger.line("promote", `A newer deployment (${blockedBy}) is already built; not promoting.`); return; }

  try {
    await redis.del(keys.route(project.slug));
  } catch (err) {
    // The switch is already committed; the router picks it up when its cached route expires.
    log.warn({ err, deploymentId: deployment.id }, "route cache clear failed");
    ctx.logger.line("promote", `Live, but the previous version may be served for up to ${ROUTE_TTL_SECONDS}s.`);
  }
  ctx.logger.line("promote", `Live at https://${project.slug}.${env.BASE_DOMAIN}`);
}
```

- **Going live is one database write.** The router serves whatever `Project.activeDeploymentId` points to. Changing that id switches every request to the new files at once; no files are copied or moved, and there's no moment when the site is half old and half new.
- **`ready` is not the same as live.** `ready` means the build succeeded and its files are stored; `activeDeploymentId` says which deployment the site serves. That's why the status is set first: a build that doesn't go live still stays `ready`, so its preview URL works and it can be promoted or rolled back to by hand. Any other status would be wrong (`failed` would be false) or would block those.
- **An older build never replaces a newer one.** With two workers, deployment B (started second) may finish before A. When A finishes, it finds B is live or `ready`, and newer, so A stays `ready` but doesn't take over the site. The `ready` check also covers a newer build that was rolled back by hand: an older build finishing later shouldn't undo that rollback.
- **The check and the switch run under a lock.** Done as separate queries, two builds finishing together could interleave: A finds nothing newer, B goes live, then A overwrites B. `SELECT … FOR UPDATE` locks the project row for the rest of the transaction, so a second promotion of the same project waits until the first commits and then sees its result. Builds of different projects lock different rows and never wait for each other.
- **A failed switch is reported in the build log, not thrown.** By this point the deployment is `ready`. Throwing would send `runPipeline` into its error handler, which tries to set `failed`; `ready → failed` isn't an allowed transition, so that throws too, is swallowed, and the user would see a successful build that silently never went live. Instead the log says so and suggests promoting by hand.
- **The route cache is deleted**, not updated. The router's next request misses the cache, reads the new pointer from Postgres, and caches it again. If the delete fails, the switch still happened; the old route stays cached for at most `ROUTE_TTL_SECONDS`, and the log says so.
- **Auto-deploy overrides a manual rollback.** If you roll back to an older deployment, the next push to the branch builds a newer one, which goes live. Keeping a rollback pinned until the next manual promote would need a flag on the project; it's left out for now.

### `apps/worker/src/pipeline/index.ts`

Runs the steps in order, sets the status between them, and handles every failure in one `catch`.

```ts
import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@shipyard/db";
import { BuildCancelledError, RootDirError, toUserMessage } from "@shipyard/shared/errors";
import { env, log, storage } from "../lib/clients.js";
import { BuildLogger } from "../lib/logs.js";
import { isInside } from "../lib/paths.js";
import { setStatus } from "../lib/status.js";
import type { BuildContext } from "./context.js";
import { clone } from "./clone.js";
import { detect } from "./detect.js";
import { build } from "./build.js";
import { resolveOutput } from "./resolveOutput.js";
import { upload } from "./upload.js";
import { promote } from "./promote.js";

export async function runPipeline(deploymentId: string, signal: AbortSignal) {
  const deployment = await prisma.deployment.findUniqueOrThrow({ where: { id: deploymentId }, include: { project: true } });
  if (deployment.status !== "queued") { log.warn({ deploymentId, status: deployment.status }, "skipping non-queued job"); return; }

  const logger = new BuildLogger(deploymentId);
  const workDir = path.join(env.BUILDS_DIR, deploymentId);
  const ctx: BuildContext = {
    deployment, project: deployment.project, store: storage,
    workDir, hostWorkDir: path.join(env.BUILDS_HOST_PATH, deploymentId),
    repoRoot: path.resolve(workDir, deployment.project.rootDir),
    envVars: [], logger, signal,
  };

  const startedAt = Date.now();
  try {
    // Inside the try, so a bad rootDir marks the deployment failed like any other build error.
    if (!isInside(workDir, ctx.repoRoot)) throw new RootDirError(deployment.project.rootDir);
    await setStatus(deploymentId, "cloning", { startedAt: new Date() });
    await clone(ctx);
    await setStatus(deploymentId, "detecting");
    await detect(ctx);
    await setStatus(deploymentId, "building");
    await build(ctx);
    await resolveOutput(ctx);
    await setStatus(deploymentId, "uploading");
    await upload(ctx);
    await promote(ctx);
    logger.line("done", `Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  } catch (e) {
    const status = e instanceof BuildCancelledError ? "cancelled" : "failed";
    const { code, params, fallback } = toUserMessage(e);
    log.error({ err: e, deploymentId }, "pipeline failed");
    // Build logs stay English; the dashboard translates errorCode/errorParams.
    logger.line("error", fallback);
    await setStatus(deploymentId, status, { error: fallback, errorCode: code, errorParams: params, finishedAt: new Date() }).catch(() => {});
  } finally {
    await logger.flush();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
```

- **Only `queued` deployments run.** BullMQ can deliver the same job twice (for example, after a worker crash). If the deployment has already started or finished, the second delivery logs a warning and does nothing.
- **`rootDir` must stay inside the repo.** It's user input, and `path.resolve(workDir, "../..")` would otherwise point the build at another folder on the host, including another deployment's folder next to this one. The check uses `isInside` (see `lib/paths.ts`) and is the first thing in the `try`, before cloning, so a bad value costs no clone. It throws a `RootDirError`, so the shared `catch` handles it like any build failure: the deployment moves from `queued` to `failed` (an allowed transition) with the message `pipeline.root_dir_invalid`, and the user sees which setting to fix. Outside the `try`, the throw would skip the `catch`, and the deployment would stay `queued` forever with no error shown.
- **Status is set before each step**, so the dashboard shows what's happening now ("building"), not what just finished. `resolveOutput` runs under `building` because it's part of finishing the build.
- **One `catch` for every step.** It picks `cancelled` or `failed`, turns the error into a code, params and English text, writes that text as the last log line, and saves all of it on the deployment. The `.catch(() => {})` on `setStatus` covers the case where the status can't be set (for example, the deployment was already cancelled); the error is already logged, and throwing again would only hide it.
- **`finally` always runs:** the last log lines are flushed, and the cloned repo and its `node_modules` are deleted from disk. Without this, every build would leave hundreds of megabytes behind.

### `apps/worker/src/index.ts`

The process entry point: connects to the queue and runs `runPipeline` for each job.

```ts
import { Worker } from "bullmq";
import { BUILD_QUEUE, connectionFromUrl, type BuildJob } from "@shipyard/shared/queue";
import { env, log, docker } from "./lib/clients.js";
import { runPipeline } from "./pipeline/index.js";

await docker.ping();   // fail fast if the socket is not mounted

const worker = new Worker<BuildJob>(
  BUILD_QUEUE,
  async job => {
    const controller = new AbortController();
    log.info({ deploymentId: job.data.deploymentId }, "build started");
    await runPipeline(job.data.deploymentId, controller.signal);
  },
  { connection: connectionFromUrl(env.REDIS_URL), concurrency: env.BUILD_CONCURRENCY, lockDuration: env.BUILD_TIMEOUT_MS + 60_000 },
);

worker.on("failed", (job, err) => log.error({ jobId: job?.id, err }, "job failed"));
worker.on("error", err => log.error({ err }, "worker error"));

const shutdown = async () => { log.info("shutting down"); await worker.close(); process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
log.info({ concurrency: env.BUILD_CONCURRENCY }, "worker ready");
```

`lockDuration` must exceed the maximum build time, otherwise BullMQ assumes the job stalled and hands it to another worker mid-build.

- **`docker.ping()` at startup.** If the Docker socket isn't mounted, the worker exits immediately with a clear error, instead of taking jobs and failing every build.
- **`concurrency`** is how many jobs this process runs at the same time. To build more at once, add more worker containers; each one takes jobs from the same queue.
- **The `AbortController`** is created per job so `runPipeline` already accepts a signal. Nothing calls `abort()` yet; Phase 4 connects it to the cancel button.
- **`runPipeline` doesn't throw for a failed build**; it records the failure on the deployment. So BullMQ's `failed` event only fires for unexpected errors (for example, the deployment row is missing), and those are logged.
- **Graceful shutdown.** On `SIGTERM` (sent by `docker compose down` or a redeploy), `worker.close()` stops taking new jobs and waits for the running ones to finish before the process exits, so builds aren't cut off.

---

## Step 5 — Router

The router serves every deployed site. Caddy sends every `*.<BASE_DOMAIN>` request to it, and for each request it:

1. **resolves** the hostname to a deployment (`resolve.ts`), then
2. **serves** the matching file from that deployment's storage prefix (`serve.ts`).

It never builds or writes anything. It's split so that step 2, where the tricky URL-to-file rules live, can be tested without any running services.

### `apps/router/src/resolve.ts`

Turns a hostname into the deployment it should serve, or `null` for "no site here".

```ts
import { prisma } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { ROUTE_TTL_SECONDS } from "@shipyard/shared/constants";
import { isValidSlug, DEPLOYMENT_ID_RE } from "@shipyard/shared/slug";
import { redis, env, log } from "./lib/clients.js";

export interface Target { deploymentId: string; spaFallback: boolean }
export type Resolver = (hostname: string) => Promise<Target | null>;

/** Any failure (Redis down, a corrupted value) is logged and treated as a miss. */
async function readCachedRoute(slug: string): Promise<Target | null> {
  try {
    const cached = await redis.get(keys.route(slug));
    return cached ? (JSON.parse(cached) as Target) : null;   // trusted as-is: see below
  } catch (err) {
    log.warn({ err, slug }, "route cache read failed; using Postgres");
    return null;
  }
}

/** A failure is logged and ignored: the route was already found in Postgres. */
async function cacheRoute(slug: string, target: Target): Promise<void> {
  try {
    await redis.set(keys.route(slug), JSON.stringify(target), "EX", ROUTE_TTL_SECONDS);
  } catch (err) {
    log.warn({ err, slug }, "route cache write failed");
  }
}

export async function resolveHost(hostname: string): Promise<Target | null> {
  const suffix = "." + env.BASE_DOMAIN;
  if (!hostname.endsWith(suffix)) return null;                 // custom domains: Phase 5
  const label = hostname.slice(0, -suffix.length);
  if (label.includes(".")) return null;                          // no nested subdomains

  // Preview mode: <deploymentId>.<base>. isValidSlug rejects id-shaped labels, so this can't shadow a slug.
  if (DEPLOYMENT_ID_RE.test(label)) {
    const deployment = await prisma.deployment.findUnique({ where: { id: label }, select: { status: true, project: { select: { spaFallback: true } } } });
    return deployment?.status === "ready" ? { deploymentId: label, spaFallback: deployment.project.spaFallback } : null;
  }

  if (!isValidSlug(label)) return null;
  const cached = await readCachedRoute(label);
  if (cached) return cached;

  const project = await prisma.project.findUnique({ where: { slug: label }, select: { activeDeploymentId: true, spaFallback: true } });
  if (!project?.activeDeploymentId) return null;
  const target: Target = { deploymentId: project.activeDeploymentId, spaFallback: project.spaFallback };
  await cacheRoute(label, target);
  return target;
}
```

- **Only direct subdomains of `BASE_DOMAIN`.** `site.localhost` is looked up; `a.b.localhost` and other domains return `null`. Custom domains are added in Phase 5.
- **Preview URLs.** A label shaped like a deployment id (`DEPLOYMENT_ID_RE`) serves that exact deployment, so any `ready` build can be viewed at its own URL even when it isn't live. This runs before the slug lookup and never falls through to it: `isValidSlug` rejects every id-shaped label, so no project can have that slug (see `slug.ts`). Preview lookups aren't cached: they're rare, and caching them would need its own invalidation.
- **Production URLs** look up the project by slug and serve its `activeDeploymentId`. The label is checked with `isValidSlug` first, so random hostnames don't reach the database.
- **Cache-aside in Redis.** Every request needs this lookup, so the answer is cached for `ROUTE_TTL_SECONDS`. Promote deletes the entry, so a new deploy shows up on the next request, not after the TTL. Misses (`null`) aren't cached, so a site becomes reachable the moment its first deployment is promoted.
- **The cached value is the whole `Target`** (deployment id and SPA setting), so a cache hit needs no database query.
- **Redis failures never fail a request; Postgres failures do.** Redis is only a cache here, so `readCachedRoute` turns any read error into a miss and `cacheRoute` logs and ignores a failed write. If Redis goes down, every site stays up and each lookup goes to Postgres instead, slower and with more database load, and the `route cache … failed` warnings in the logs say why. A corrupted value under `route:<slug>` is handled the same way, so it can't break one site until it expires. Postgres errors propagate on purpose: without the database there's no way to know what to serve, so `createApp`'s `catch` passes them to Express and the request gets a 500.

Two trade-offs are deliberate, and worth knowing before you change this file:

- **Misses aren't cached, so unknown slugs always reach Postgres.** Caching `null` would make a brand-new site show "no deployment" until the cached miss expired, right when the user is checking whether it worked. The cost is that every request for a well-formed slug that doesn't exist (a bot scanning random subdomains, a typo) does a database query. It's a single lookup on the unique `slug` index, so it's cheap, and `isValidSlug` already stops malformed labels before this point. If that traffic ever shows up in the database load, cache misses for a few seconds (e.g. store `"null"` with `EX 5`): a new site would then take at most that long to appear.
- **Cached values aren't validated.** A cache hit is returned as parsed, on the assumption that it has the current `Target` shape. That holds as long as the shape doesn't change. If you add a field to `Target`, entries written by the old code lack it until they expire (at most `ROUTE_TTL_SECONDS`) or a promote deletes them, and during a rolling deploy old and new routers write both shapes. Either make new fields optional with a sensible default where they're read, or change the key in `keys.route` (e.g. `route:v2:<slug>`) so old entries are simply never read.

`resolve.ts` is the one router module that touches Prisma and Redis (through `./lib/clients.js`). Only `server.ts` imports it at runtime; `serve.ts` and `index.ts` use `import type`, which is erased at compile time, so tests can load them without a database.

### `apps/router/src/serve.ts`

Receives the store as an argument and never imports `./lib/clients.js`.

```ts
import type { Request, Response } from "express";
import posix from "node:path/posix";
import type { ObjectReader } from "@shipyard/shared/storage";
import { deploymentPrefix, INTERNAL_FILES } from "@shipyard/shared/storageKeys";
import type { Target } from "./resolve.js";

const NOT_FOUND = `<!doctype html><title>404</title><h1>404 — Not found</h1>`;

/** URL path → key relative to the deployment prefix, or null if the path is malformed or hostile. */
export function normalise(raw: string): string | null {
  const [pathPart = ""] = raw.split("?");   // the default only satisfies noUncheckedIndexedAccess
  let urlPath: string;
  try { urlPath = decodeURIComponent(pathPart); } catch { return null; }
  // Check before normalising: posix.normalize("/../../etc") quietly becomes "/etc".
  if (urlPath.includes("\0") || urlPath.split("/").includes("..")) return null;
  urlPath = posix.normalize("/" + urlPath);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  return urlPath.slice(1);
}

async function send(store: ObjectReader, res: Response, key: string, req: Request, status = 200) {
  const obj = await store.get(key);
  if (!obj) return false;
  // Revalidation only applies to a real hit: a 304 for 404.html would turn "not found" into "still cached".
  const etag = status === 200 ? obj.etag : undefined;
  if (etag && req.headers["if-none-match"] === etag) {
    obj.body.destroy();   // a live storage stream holding a pooled connection: release it unread
    res.status(304).end();
    return true;
  }
  res.status(status);
  if (obj.contentType) res.setHeader("Content-Type", obj.contentType);
  if (obj.contentLength != null) res.setHeader("Content-Length", obj.contentLength);
  if (obj.cacheControl) res.setHeader("Cache-Control", obj.cacheControl);
  if (obj.contentEncoding) res.setHeader("Content-Encoding", obj.contentEncoding);
  if (etag) res.setHeader("ETag", etag);
  obj.body.pipe(res);
  return true;
}

export async function serveDeployment(store: ObjectReader, target: Target, req: Request, res: Response) {
  const rel = normalise(req.path);
  if (rel === null) return res.status(400).type("text").send("Bad path");
  // Answered with 404, not 400, so their existence isn't revealed.
  if (INTERNAL_FILES.has(rel)) return res.status(404).type("html").send(NOT_FOUND);
  const prefix = deploymentPrefix(target.deploymentId);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (await send(store, res, prefix + rel, req)) return;

  // /docs → /docs/index.html (pretty URLs, e.g. Next/Astro output)
  if (!posix.extname(rel) && (await send(store, res, `${prefix}${rel}/index.html`, req))) return;
  if (!posix.extname(rel) && (await send(store, res, `${prefix}${rel}.html`, req))) return;

  // SPA fallback: client-side routes have no extension
  if (target.spaFallback && !posix.extname(rel) && (await send(store, res, prefix + "index.html", req))) return;

  if (await send(store, res, prefix + "404.html", req, 404)) return;
  res.status(404).type("html").send(NOT_FOUND);
}
```

**`normalise`** turns the URL path into a storage key and rejects anything that could reach outside the deployment's prefix:

- It decodes percent-encoding first, so `%2e%2e` is checked as `..`. Invalid encoding is rejected instead of guessed at.
- It rejects `..` segments and NUL bytes *before* normalising. After normalising, `/../../etc` would look like a harmless `/etc`, and the attempt would go unnoticed.
- It collapses `//` and `./`, and turns a path ending in `/` into `…/index.html`, the way static hosts usually do.

**`send`** fetches one key and writes it to the response. It returns `false` when the key doesn't exist, so the caller can try the next candidate. If the browser's `If-None-Match` equals the object's ETag, it answers 304 with no body (the browser already has the file). Otherwise it copies the headers stored at upload time and streams the body, so large files are never held in memory. Two details in the 304 path matter:

- **The unread body is destroyed.** `store.get` returns a live HTTP stream from S3, which holds one of the S3 client's pooled connections until it's read or closed. Browsers revalidate constantly, so leaving it open on every 304 would drain the pool, and then every request would hang waiting for a connection.
- **Only a normal 200 response is revalidated.** When `send` is serving `404.html` it skips the ETag entirely: no `ETag` header, no 304. Otherwise a browser that had cached the site's 404 page would be told a missing URL is "not modified", which reads as success.

**`serveDeployment`** tries candidates in order and stops at the first file that exists:

| Order | Key | Why |
|---|---|---|
| 1 | the exact path | Normal files: `/app.js`, `/about.html`, `/` → `index.html` |
| 2 | `path/index.html` | Pretty URLs: `/docs` for a site that has `docs/index.html` |
| 3 | `path.html` | Pretty URLs: `/about` for a site that has `about.html` (Next.js export) |
| 4 | `index.html` (if `spaFallback`) | Client-side routes in single-page apps: `/settings` has no file; the app's router handles it |
| 5 | `404.html` with status 404 | The site's own 404 page, if it has one |
| 6 | built-in 404 page | Nothing else matched |

Steps 2–4 only apply to paths **without an extension**. A missing `/logo.png` should be a 404, not `index.html` served as a PNG, which would break the page quietly and be hard to debug.

`X-Content-Type-Options: nosniff` stops browsers from guessing a file's type (a user-uploaded `.txt` must not run as a script). `Referrer-Policy` limits how much of a URL is sent to other sites when a visitor follows a link.

Only the internal files at the deployment root (`INTERNAL_FILES`) are hidden. An earlier draft blocked every path starting with `_`, which would have broken Next.js sites (all their assets live under `_next/`). The unit tests below cover both cases.

### `apps/router/src/index.ts`

The Phase 0 `export default app` becomes a factory. The app receives everything it talks to (the store and the host resolver) and imports nothing that connects to a service.

```ts
import express from "express";
import pinoHttp from "pino-http";
import type { ObjectReader } from "@shipyard/shared/storage";
import type { Resolver } from "./resolve.js";
import { serveDeployment } from "./serve.js";

export interface RouterDeps {
  store: ObjectReader;
  resolve: Resolver;
  logLevel?: string;
}

export function createApp({ store, resolve, logLevel = "info" }: RouterDeps) {
  const app = express();

  // Caddy terminates TLS in front of this process, so req.protocol and req.ip
  // have to come from the forwarded headers rather than the socket.
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(pinoHttp({ level: logLevel }));

  // Double-underscored because this process serves arbitrary user sites on
  // wildcard subdomains: a bare /health would shadow that path in every deployed
  // site. Compose's healthcheck for `router` must target this exact path.
  app.get("/__health", (_req, res) => res.json({ ok: true }));

  app.use(async (req, res, next) => {
    try {
      const target = await resolve(req.hostname.toLowerCase());
      if (!target) return res.status(404).type("html").send(`<!doctype html><h1>No site deployed at ${req.hostname}</h1>`);
      await serveDeployment(store, target, req, res);
    } catch (e) { next(e); }
  });

  return app;
}
```

- **Dependencies are passed in.** Tests pass a `MemoryStorage` and a fake `resolve`; production passes S3 and the Redis/Postgres resolver. The request handling is the same in both.
- **One catch-all handler** instead of routes, because the router has no routes of its own. Every path belongs to the user's site; only the hostname decides which site.
- **The hostname is lower-cased** because DNS names are case-insensitive, but slugs and cache keys are stored in lower case.
- **Errors go to `next(e)`**, which makes Express answer 500. That's for storage or database failures; a missing site or file is a normal 404 handled above.

### `apps/router/src/server.ts`

This is the one place that builds the real dependencies and wires them together:

```ts
import { createApp } from "./index.js";
import { env, storage } from "./lib/clients.js";
import { resolveHost } from "./resolve.js";

createApp({ store: storage, resolve: resolveHost, logLevel: env.LOG_LEVEL })
  .listen(env.PORT, () => console.log(`router listening on ${env.PORT}`));
```

### `apps/router/src/lib/clients.ts`

Same pattern as the API's `clients.ts`: the router's env, storage and Redis connection, created once. Only `resolve.ts` and `server.ts` import it.

```ts
import { loadEnv } from "@shipyard/shared/env";
import { S3Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
import { createLogger } from "@shipyard/shared/logger";
import { z } from "zod";

export const env = loadEnv({ PORT: z.coerce.number().default(4001) });
export const log = createLogger("router", env.LOG_LEVEL);
export const storage: ObjectStore = new S3Storage(env);
export const redis = createRedis(env.REDIS_URL);
redis.on("error", err => log.error({ err }, "redis error"));   // without a listener ioredis console.errors every reconnect
```

To put a cache in front of S3 later, change only the `storage` line (e.g. `new CachedStorage(new S3Storage(env))`, where `CachedStorage implements ObjectStore`). The router code stays the same.

### Unit tests — `apps/router/src/__tests__/serve.test.ts`

These run in milliseconds with no Docker, MinIO, Postgres or Redis. They use the in-memory store and a fake resolver.

Requests go through `node:http`, not `fetch`. The WHATWG URL parser behind `fetch` resolves `..` **and** `%2e%2e` on the client, so a traversal test written with `fetch` never sends the hostile path and passes for the wrong reason.

```ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { deploymentPrefix, metaKey } from "@shipyard/shared/storageKeys";
import { MemoryStorage } from "@shipyard/shared/testing";
import { createApp } from "../index.js";
import { normalise } from "../serve.js";
import type { Target } from "../resolve.js";

const store = new MemoryStorage();
const PREFIX = deploymentPrefix("d1");
let target: Target | null = { deploymentId: "d1", spaFallback: true };
let server: http.Server;
let port: number;

function get(path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }>((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path, headers }, res => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", chunk => (body += chunk));
      res.on("end", () => resolve({ status: res.statusCode!, body, headers: res.headers }));
    }).on("error", reject);
  });
}

beforeAll(async () => {
  const html = (text: string) => Buffer.from(text);
  await store.put(PREFIX + "index.html", html("home"), { contentType: "text/html" });
  await store.put(PREFIX + "docs/index.html", html("docs"), { contentType: "text/html" });
  await store.put(PREFIX + "about.html", html("about"), { contentType: "text/html" });
  await store.put(PREFIX + "404.html", html("custom 404"), { contentType: "text/html" });
  await store.put(PREFIX + "_next/static/app.js", html("js"), { contentType: "text/javascript" });
  await store.put(metaKey(PREFIX), html("{}"), { contentType: "application/json" });

  const app = createApp({ store, resolve: async () => target, logLevel: "silent" });
  server = app.listen(0);
  await new Promise(resolve => server.once("listening", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => server.close());

describe("serveDeployment", () => {
  it("serves index.html at /", async () => {
    const result = await get("/");
    expect(result.status).toBe(200); expect(result.body).toBe("home");
    expect(result.headers["content-type"]).toContain("text/html");
  });
  it("pretty URL → dir/index.html", async () => expect((await get("/docs")).body).toBe("docs"));
  it("pretty URL → name.html", async () => expect((await get("/about")).body).toBe("about"));
  it("serves assets under _next/", async () => expect((await get("/_next/static/app.js")).body).toBe("js"));

  it("SPA fallback for client routes", async () => {
    const result = await get("/some/client/route");
    expect(result.status).toBe(200); expect(result.body).toBe("home");
  });
  it("no SPA fallback for missing files with an extension", async () => {
    const result = await get("/missing.js");
    expect(result.status).toBe(404); expect(result.body).not.toBe("home");
  });
  it("SPA off → custom 404.html with status 404", async () => {
    target = { deploymentId: "d1", spaFallback: false };
    try {
      const result = await get("/some/client/route");
      expect(result.status).toBe(404); expect(result.body).toBe("custom 404");
    } finally { target = { deploymentId: "d1", spaFallback: true }; }
  });

  it("hides internal files", async () => expect((await get("/_meta.json")).status).toBe(404));
  it("rejects ..", async () => expect((await get("/../../etc/passwd")).status).toBe(400));
  it("rejects encoded ..", async () => expect((await get("/%2e%2e/%2e%2e/etc/passwd")).status).toBe(400));
  it("rejects NUL", async () => expect((await get("/a%00b")).status).toBe(400));

  it("304 when If-None-Match matches", async () => {
    const first = await get("/about.html");
    const result = await get("/about.html", { "if-none-match": first.headers.etag as string });
    expect(result.status).toBe(304);
  });
  it("custom 404.html is never a 304 and has no ETag", async () => {
    target = { deploymentId: "d1", spaFallback: false };
    try {
      // MemoryStorage's ETag is the quoted MD5 of the content: send the one a browser would have cached.
      const cachedEtag = `"${createHash("md5").update("custom 404").digest("hex")}"`;
      const result = await get("/some/client/route", { "if-none-match": cachedEtag });
      expect(result.status).toBe(404);
      expect(result.headers.etag).toBeUndefined();
    } finally { target = { deploymentId: "d1", spaFallback: true }; }
  });

  it("unknown host → 404", async () => {
    const saved = target; target = null;
    try {
      const result = await get("/");
      expect(result.status).toBe(404); expect(result.body).toContain("No site deployed");
    } finally { target = saved; }
  });
});

describe("normalise", () => {
  it.each([
    ["/", "index.html"],
    ["/a/b/", "a/b/index.html"],
    ["/a//b", "a/b"],
    ["/a/./b", "a/b"],
    ["/x?y=1", "x"],
    ["/%E0%A4%A", null],       // malformed percent-encoding
    ["/a/../b", null],
    ["/%2e%2e/x", null],
  ])("%s → %s", (input, expected) => expect(normalise(input)).toBe(expected));
});
```

How the tests are set up:

- **`beforeAll` fills the store** with one small deployment covering each lookup rule: a root `index.html`, `docs/index.html` (folder-style pretty URL), `about.html` (`.html`-style pretty URL), a custom `404.html`, a `_next/` asset, and `_meta.json` (which must stay hidden).
- **The resolver is a variable.** `target` is what the fake `resolve` returns, so a test can switch SPA fallback off, or simulate an unknown host (`null`), then restore it in `finally` so later tests aren't affected.
- **`listen(0)`** lets the OS pick a free port, so tests never collide with a running router or with each other.
- **The `describe("normalise")` table** tests the path function on its own, including malformed encoding, which is hard to send through a real HTTP client.

`@shipyard/shared` is already a devDependency of the router (Phase 0), so the `./testing` export resolves with no install step.

---

## Step 6 — Fixture repos

Each is a committed, minimal project. Keep dependencies pinned so builds are reproducible.

Each fixture covers one path through detection and build, so a regression in any of them shows up as one failing fixture: no build at all (`plain-html`), framework defaults (`vite-react`, `vue-vite`, `cra`), an output folder read from a config file (`vite-custom-outdir`), and frameworks with their own static-export rules (`sveltekit-static`, `next-export`). `hang` doesn't build a site; it checks that the timeout actually stops a build that never ends.

Every fixture sets its own `<title>` to its name. The e2e test checks for that title, which proves the right site was served, not just some page with status 200.

| Dir | Contents | Expected |
|---|---|---|
| `fixtures/plain-html` | `index.html` only | served from root, no build |
| `fixtures/vite-react` | `pnpm create vite --template react-ts` output, `<title>vite-react</title>` | `dist/` |
| `fixtures/vite-custom-outdir` | same + `build: { outDir: "public_html" }` | `public_html/` |
| `fixtures/vue-vite` | `create-vue` minimal | `dist/` |
| `fixtures/sveltekit-static` | `sv create` + `@sveltejs/adapter-static`, `export const prerender = true` in `+layout.ts` | `build/` |
| `fixtures/next-export` | `create-next-app` + `output: 'export'` in `next.config.mjs` | `out/` |
| `fixtures/cra` | `react-scripts` minimal (keep small; CRA installs are slow) | `build/` |
| `fixtures/hang` | `package.json` with `"postinstall": "while true; do sleep 1; done"` | timeout → `failed` |

### Where the fixtures are hosted

The detection unit tests (Step 3) read `fixtures/<name>` straight from disk. The e2e test (Step 7) can't: the worker only deploys from a git URL, and the API only accepts `github.com` URLs. So each fixture is **also pushed to its own public GitHub repo**, named `shipyard-fixture-<name>` under your account (e.g. `github.com/isthatsahil/shipyard-fixture-vite-react`).

This clones for real over the internet, exactly like a user's deploy, and needs no test-only code in the API. The cost is keeping the GitHub copies in sync with `fixtures/`, which stays the source of truth. Publish or update every fixture with:

```bash
# fixtures/publish.sh — needs `gh auth login` first
set -euo pipefail
OWNER="${FIXTURES_OWNER:-isthatsahil}"
for dir in fixtures/*/; do
  name=$(basename "$dir"); repo="$OWNER/shipyard-fixture-$name"
  gh repo view "$repo" >/dev/null 2>&1 || gh repo create "$repo" --public --description "Shipyard e2e fixture: $name"
  tmp=$(mktemp -d); cp -R "$dir". "$tmp"
  (cd "$tmp" && git init -q -b main && git add -A && git commit -qm "fixture: $name" && git push -qf "https://github.com/$repo.git" main)
  rm -rf "$tmp"
done
```

Each push replaces the repo's history with a single commit (`-f`), so the GitHub copy is always an exact snapshot of `fixtures/<name>` and never drifts. Re-run it whenever a fixture changes.

Considered and rejected: serving the fixtures locally with `git daemon`. It works offline, but the API's GitHub-only URL check would need a test-only exception.

---

## Step 7 — Integration test

`apps/worker/test/e2e.test.ts` (runs against the Compose stack; `pnpm test:e2e`)

The unit tests check each piece alone. This test checks the whole Phase 1 goal, the way a user would: a real `POST /projects`, a real clone from GitHub, a real build in Docker, a real upload to MinIO, and a real HTTPS request to `https://<slug>.localhost` through Caddy and the router. It only talks to the stack over HTTP, the way a user would, so it tests exactly what gets shipped.

```ts
import { describe, it, expect } from "vitest";

// Caddy's local CA must be trusted by Node through NODE_EXTRA_CA_CERTS (see
// Phase 0, "Trusting the Caddy CA"). Node reads it once at startup, so it can't
// be set from this file. Run `pnpm test:e2e` from the repo root: it points the
// variable at an absolute path to caddy-root.crt, since this suite runs from
// apps/worker, where a relative path wouldn't resolve.
const API = process.env.API_URL ?? "https://api.localhost";
const BASE = process.env.BASE_DOMAIN ?? "localhost";
const OWNER = process.env.FIXTURES_OWNER ?? "isthatsahil"; // see Step 6
const fixture = (name: string) =>
  `https://github.com/${OWNER}/shipyard-fixture-${name}`;

// Only the fields this test reads. It talks to the stack over HTTP like a user,
// so it describes the JSON it gets back rather than importing the API's types.
interface ProjectBody {
  slug: string;
}
interface DeploymentBody {
  id: string;
  status: string;
  error?: string | null;
  errorCode?: string | null;
}

// How long to poll for each kind of case. Each wait is one minute short of that
// test's vitest timeout, so running out of time fails with the deployment's own
// state rather than vitest's generic timeout. The hang wait must outlast the
// worker's BUILD_TIMEOUT_MS (15 min in docker/compose.yaml).
const BUILD_WAIT_MS = 11 * 60_000;
const HANG_WAIT_MS = 19 * 60_000;

async function deploy(
  repoUrl: string,
  waitMs: number,
  extra: Record<string, unknown> = {},
) {
  const response = await fetch(`${API}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl, ...extra }),
  });
  expect(response.status).toBe(201);
  const { project, deployment } = (await response.json()) as {
    project: ProjectBody;
    deployment: DeploymentBody;
  };
  const deadline = Date.now() + waitMs;
  let latest = deployment;
  while (Date.now() < deadline) {
    latest = (await (
      await fetch(`${API}/deployments/${deployment.id}`)
    ).json()) as DeploymentBody;
    if (["ready", "failed", "cancelled"].includes(latest.status))
      return { project, deployment: latest };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `timed out waiting for deployment ${deployment.id} (still ${latest.status})`,
  );
}

const cases: [string, string, string][] = [
  ["plain-html", fixture("plain-html"), "plain-html"],
  ["vite-react", fixture("vite-react"), "vite-react"],
  ["vite-custom-outdir", fixture("vite-custom-outdir"), "vite-custom-outdir"],
  ["vue-vite", fixture("vue-vite"), "vue-vite"],
  ["sveltekit-static", fixture("sveltekit-static"), "sveltekit-static"],
  ["next-export", fixture("next-export"), "next-export"],
  ["cra", fixture("cra"), "cra"],
];

describe("end-to-end", () => {
  for (const [name, url, title] of cases) {
    it(
      name,
      async () => {
        const { project, deployment } = await deploy(url, BUILD_WAIT_MS);
        expect(deployment.status, deployment.error ?? undefined).toBe("ready");
        const html = await (
          await fetch(`https://${project.slug}.${BASE}/`)
        ).text();
        expect(html).toContain(`<title>${title}</title>`);
      },
      BUILD_WAIT_MS + 60_000,
    );
  }

  it(
    "kills a hanging build",
    async () => {
      const { deployment } = await deploy(fixture("hang"), HANG_WAIT_MS);
      expect(deployment.status).toBe("failed");
      expect(deployment.error).toMatch(/exceeded/);
      // The code proves it was the timeout, not some other failure that happens to say "exceeded".
      expect(deployment.errorCode).toBe("pipeline.build_timeout");
    },
    HANG_WAIT_MS + 60_000,
  );
});
```

- **`deploy`** creates the project and then polls `GET /deployments/:id` every 2 seconds until the status is final. Builds take minutes, and polling is the simplest way to wait (Phase 2 adds live status).
- **The assertion includes `deployment.error`** as its message, so a failing case prints why the build failed, not just "expected failed to be ready".
- **Each project gets an auto-generated slug** from the repo name. On a second run against the same database, the slug is taken and gets a random suffix, so reruns don't collide.
- **Polling waits outlast the build limit.** `deploy` polls for `BUILD_WAIT_MS` (11 min), or `HANG_WAIT_MS` (19 min) for `hang`, which must be longer than the worker's 15-minute `BUILD_TIMEOUT_MS` or the test gives up before the worker kills the build. Each vitest timeout is one minute longer again, so running out of time fails with the deployment's id and last status rather than vitest's generic timeout.
- **Response bodies are typed locally** (`ProjectBody`, `DeploymentBody`) with only the fields the test reads. `response.json()` returns `unknown`, and the test deliberately doesn't import the API's types: it checks the wire format a user sees.
- **The hang test** passes only if the worker kills the build *and* reports it as a timeout, not as a generic failure: the message contains "exceeded" and `errorCode` is `pipeline.build_timeout`. The code is the real proof; the message check alone would pass for any error that happens to say "exceeded".

For the hang test in CI, set `BUILD_TIMEOUT_MS=60000` on the worker so the suite stays fast. `docker/compose.yaml` reads it as `${BUILD_TIMEOUT_MS:-900000}`, so it's set from the environment of `pnpm infra:up` (Step 8 does this). Locally, `BUILD_TIMEOUT_MS=60000 pnpm infra:up` does the same; without it, the hang case waits out the full 15 minutes.

---

## Step 8 — CI

`.github/workflows/ci.yml`

```yaml
name: ci
on: [push, pull_request]
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm db:generate && pnpm typecheck && pnpm lint && pnpm test
  e2e:
    runs-on: ubuntu-latest
    needs: unit
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm builder:build
      - run: cp .env.example .env && cp docker/.env.example docker/.env && pnpm infra:up --build --wait
        # Compose interpolates this into the worker's environment (see Step 7).
        env: { BUILD_TIMEOUT_MS: 60000 }
      # Migrate and seed from the runner, not inside the api container: the api
      # image holds only the pruned production tree, with no pnpm or prisma.
      - run: pnpm db:generate && pnpm --filter @shipyard/db migrate:deploy && pnpm db:seed
      - run: docker compose -f docker/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
      - run: pnpm test:e2e
        # Absolute: pnpm runs the suite from apps/worker, where a relative path wouldn't resolve.
        # Block style, not { ... }: inside a flow mapping, the ":" in "http://" is a YAML syntax error.
        env:
          API_URL: http://localhost:4000
          BASE_DOMAIN: localhost
          NODE_EXTRA_CA_CERTS: ${{ github.workspace }}/caddy-root.crt
      - if: failure()
        run: docker compose -f docker/compose.yaml logs
```

Two jobs, because they cost very different amounts:

- **`unit`** runs on every push: type-checking, lint and the unit tests. `db:generate` runs first because the Prisma client is generated code, and type-checking fails without it.
- **`e2e`** runs only after `unit` passes (`needs: unit`), so a type error doesn't spend minutes building Docker images. It then does what a developer does locally:
  1. build the builder image the worker uses for build containers (`builder:build`);
  2. start the whole stack from the example env files, waiting for every healthcheck (`--wait`), with the build timeout cut to 60 seconds so the hang case takes one minute instead of fifteen;
  3. apply migrations and seed the single Phase 1 user (the API needs one to own projects);
  4. copy Caddy's local root certificate out of the container and give it to Node through `NODE_EXTRA_CA_CERTS`, so HTTPS requests to `*.localhost` are trusted. The path must be absolute: Node resolves it against the test process's working directory, which is `apps/worker`, not the repo root;
  5. run the e2e suite.
- **On failure, dump every container's logs**, because the actual error is usually in the worker's or API's log, not in the test output.

---

## Checklist

- [ ] `detectFramework` unit tests pass for every fixture
- [ ] Router unit tests pass without Docker (`pnpm --filter @shipyard/router test`)
- [ ] `pnpm typecheck` passes (proves `S3Storage` and `MemoryStorage` both satisfy `ObjectStore`)
- [ ] Every fixture deploys and serves its `<title>`
- [ ] Hang fixture fails with the timeout message; no container left behind (`docker ps -a --filter label=shipyard.deployment`)
- [ ] `GET /nonexistent` on a SPA project returns `index.html`; on `plain-html` returns 404
- [ ] `GET /../../etc/passwd` returns 400
- [ ] `GET /_meta.json` returns 404
- [ ] `https://<deploymentId>.localhost/` serves a `ready` deployment that isn't the live one
- [ ] A project with `rootDir: "../x"` ends `failed` with `errorCode: "pipeline.root_dir_invalid"`, not stuck in `queued`
- [ ] Second `POST /projects/:id/deployments` while one is queued creates a second row (dedupe comes in Phase 4) and both finish; the newer one wins `activeDeploymentId`
