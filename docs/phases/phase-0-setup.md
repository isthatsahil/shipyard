# Phase 0 — Setup

**Goal:** a monorepo with all four apps stubbed, local infrastructure running under Docker Compose, a builder image, and a migrated database.
**Time:** 1–2 days.
**Done when:** `docker compose up` is green, `pnpm db:migrate` runs, `https://api.localhost/health` returns `{ ok: true }`, and `https://anything.localhost` returns the router's placeholder 404.

---

## Step 1 — Monorepo skeleton

### Why

The platform is four separately deployed programs (API, worker, router, dashboard) that share types, the database client, and the storage/queue helpers. Keeping them in one repository with a workspace manager means:

- one `pnpm install`, one lockfile, one CI pipeline;
- `packages/shared` and `packages/db` are imported by path (`workspace:*`) so a change to a shared type is type-checked against every consumer immediately, without publishing anything;
- each app still builds into its own Docker image with only its own dependencies.

pnpm is used rather than npm because it installs strictly: an app can only import what its own `package.json` declares. With npm's hoisting, `apps/router` could accidentally import `dockerode` (declared only by `worker`), work locally, and then crash in the router's Docker image where that package is absent.

**Why not Turborepo?** It is worth knowing what it would and wouldn't do here, because the three tools are often confused. pnpm workspaces install and link packages. `tsdown` bundles one app into its `dist/`. Turborepo would do a third thing: run tasks (`build`, `typecheck`, `test`) across packages in dependency order and cache the results so unchanged packages are skipped. It replaces `pnpm -r build`, **not** `tsdown`, and it adds a `turbo.json` rather than removing any existing config. With six packages and no inter-package build step, the payoff today is small; it is worth adding once CI is slow enough to notice, and that can be done later with no code changes.

### Dependencies (root `devDependencies`)

| Package | Why |
|---|---|
| `typescript` | Type checking across every package; strict mode catches most bugs before runtime. **Pinned to 6.x** — see "TypeScript 6 vs 7" below |
| `tsx` | Runs `.ts` files directly during development (`tsx watch src/index.ts`) — no compile step in the dev loop |
| `tsdown` | Bundles each app into a single entry point for its Docker image (`dist/server.js` for `api`/`router`, `dist/index.js` for `worker`). Used rather than the more familiar `tsup`, whose README now reads *"This project is not actively maintained anymore"* — `tsdown` is its Rolldown-based successor from the same ecosystem. See "How the app images are built" in Step 4 |
| `vitest` | Test runner for unit tests (detection, slug rules, path safety) and the e2e suite; fast, ESM-native, same config style as Vite |
| `eslint` + `prettier` | Consistent style and a baseline of correctness rules. Note: the guard against undeclared imports is pnpm's strict install, not a lint rule — `import/no-extraneous-dependencies` is **not** configured in this repo |
| `jiti` | Lets ESLint load a TypeScript flat config (`eslint.config.ts`) |
| `@types/node` | Type definitions for Node built-ins (`fs`, `crypto`, `stream`) used throughout. Track the major you run locally |

Nothing here ships to production; app images install only their own `dependencies`.


```bash
mkdir shipyard && cd shipyard
git init
pnpm init
mkdir -p apps/{api,worker,router,web} packages/{shared,db} docker/builder fixtures
```

`pnpm-workspace.yaml`

```yaml
packages:
  - "apps/*"
  - "packages/*"
```

`package.json` (root)

```json
{
  "name": "shipyard",
  "version": "0.0.0",
  "description": "Framework-agnostic static deployment platform",
  "private": true,
  "type": "module",
  "license": "MIT",
  "author": "Sahil Verma",
  "packageManager": "pnpm@12.5.1",
  "devEngines": {
    "packageManager": {
      "name": "pnpm",
      "version": "12.5.1",
      "onFail": "download"
    }
  },
  "scripts": {
    "dev": "pnpm -r --parallel --filter './apps/*' dev",
    "build": "pnpm -r build",
    "test": "pnpm -r test",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit -p tsconfig.json && pnpm -r typecheck",
    "db:migrate": "pnpm --filter @shipyard/db migrate",
    "db:generate": "pnpm --filter @shipyard/db generate",
    "db:seed": "pnpm --filter @shipyard/db seed",
    "builder:build": "docker buildx bake -f docker/builder/docker-bake.hcl --load node22",
    "builder:build:all": "docker buildx bake -f docker/builder/docker-bake.hcl --load",
    "infra:up": "docker compose -f docker/compose.yaml up -d",
    "infra:down": "docker compose -f docker/compose.yaml down"
  },
  "devDependencies": {
    "@eslint/js": "^10.0.1",
    "@types/node": "^26.6.2",
    "eslint": "^10.11.0",
    "eslint-plugin-react-hooks": "^7.1.1",
    "eslint-plugin-react-refresh": "^0.5.7",
    "globals": "^17.12.0",
    "jiti": "^2.7.0",
    "prettier": "3.9.8",
    "tsdown": "^0.23.0",
    "tsx": "^4.23.15",
    "typescript": "^6.0.3",
    "typescript-eslint": "^8.70.0",
    "vitest": "^5.0.1"
  }
}
```

`pnpm init` generates a different starting file; reconcile it against the above:

| Field | `pnpm init` default | Use | Why |
|---|---|---|---|
| `private` | missing | **`true`** | The one field that changes behaviour: without it a stray `pnpm publish` at the root would try to push the whole platform to npm |
| `type` | `"module"` | keep | Makes root-level `.js` files (`eslint.config.js`, ad-hoc scripts) ESM, matching every workspace package |
| `packageManager` | your installed pnpm | keep yours | Corepack provisions exactly this version; pin whatever you actually installed |
| `devEngines.packageManager` | present (npm 11+/Node 24+) | keep | `onFail: "download"` makes a contributor's package manager self-correct. Complements `packageManager`; Corepack reads the older field, so keep both |
| `main: "index.js"` | present | **delete** | A workspace root is not an importable package and there is no `index.js` |
| `license` | `"ISC"` | match your `LICENSE` file | The default contradicts an MIT `LICENSE` sitting next to it |
| `description`, `keywords`, `author` | empty | fill or delete | Registry metadata only; the root is private |
| `version` | `"1.0.0"` | `"0.0.0"` | Meaningless for a private root; `0.0.0` avoids reading like a release |

Note `"lint": "eslint ."` with no `--ext` flag: ESLint 9's flat config selects files in `eslint.config.js`, and passing `--ext` there is an error.

### Installing: where each dependency goes

In a workspace, pnpm refuses a bare `pnpm add` at the root (`ERR_PNPM_ADDING_TO_ROOT`) because a root dependency is invisible to the app images — each Dockerfile installs only its own package's `package.json`. Be explicit:

```bash
# repo-wide dev tooling → workspace root
pnpm add -Dw typescript@^6 tsx tsdown vitest eslint prettier @types/node

# anything a service imports at runtime → that app
pnpm --filter @shipyard/api add express pino pino-http zod
pnpm --filter @shipyard/api add -D @types/express pino-pretty
```

Putting `express` at the root would work in development (pnpm links the root `node_modules`) and then fail inside `apps/api`'s image. That is the mistake the warning exists to catch, so leave the check on rather than setting `ignore-workspace-root-check`.

### Approving build scripts

pnpm 10+ blocks package `postinstall` scripts by default and stops with `ERR_PNPM_IGNORED_BUILDS` — the same principle this platform applies to user builds: installing a package should not silently execute arbitrary code. Some packages genuinely need theirs:

```bash
pnpm approve-builds     # interactive: select esbuild (vitest needs its native binary)
```

It records the decision in `pnpm-workspace.yaml` so it stops asking. You can also write the entry by hand and re-run `pnpm install` — useful in CI or a non-interactive shell:

```yaml
# pnpm-workspace.yaml
packages:
  - "apps/*"
  - "packages/*"

# Packages allowed to run install scripts (pnpm blocks them by default).
allowBuilds:
  esbuild: true      # places its native binary; needed by vitest
  prisma: true       # fetches the schema engine used by migrations (added in Step 3)
  "@prisma/client": true   # generates the typed client
```

Prisma 7 note: only the *schema* engine is a downloaded binary now. The query path is WebAssembly shipped inside `@prisma/client`, so there is no query-engine download to approve.

Note the shape: pnpm 12 uses an `allowBuilds` **map** of `name: true | false`. Older guides show an `onlyBuiltDependencies` list, which is the pnpm 10 spelling and is ignored here. Setting a package to `false` records an explicit refusal, so `approve-builds` won't prompt for it again either.

`tsdown` needs no entry here: Rolldown ships its native binary as a prebuilt optional dependency rather than compiling one in a `postinstall` script, so pnpm never blocks it. Only `vitest` still pulls in esbuild.

Verify the native binary landed — it isn't linked into the root `node_modules/.bin` because it is a transitive dependency:

```bash
node_modules/.pnpm/node_modules/.bin/esbuild --version
```

### ESLint flat config

Scaffold it with `pnpm create @eslint/config@latest`, then install what it asks for yourself — the generator shells out to a bare `pnpm add` and hits `ERR_PNPM_ADDING_TO_ROOT`:

```bash
pnpm add -Dw eslint @eslint/js globals typescript-eslint eslint-plugin-react-hooks eslint-plugin-react-refresh jiti
```

The generated config is single-app shaped: it applies browser globals and the React plugin to *every* file, including the three Node services. It also reaches for `eslint-plugin-react`, which does not run under ESLint 10 — see the comment in the config below. Replace the whole thing with one that matches the workspace layout:

```ts
// eslint.config.ts
import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/.prisma/**",
    "packages/db/generated/**",
    // Sample projects used as build fixtures: third-party code, not ours to lint.
    "fixtures/**",
    // Tooling directories, not project source.
    ".claude/**",
    ".agents/**",
    ".impeccable/**",
  ]),

  // Baseline for every file we own.
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended", tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Pinned rather than inferred. typescript-eslint guesses this from the
        // directories holding an ESLint config, and refuses to choose when a
        // workspace package has one too — which fails EVERY file in the repo
        // with "multiple candidate TSConfigRootDirs", not just that package's.
        // Naming it here also makes the editor's ESLint server agree with the
        // CLI no matter which directory it decides to run from.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },

  // Node services, shared packages, and the dashboard's own build config.
  {
    files: [
      "apps/{api,worker,router}/**/*.ts",
      "packages/**/*.ts",
      "apps/web/vite.config.ts",
      "*.{js,ts}",
    ],
    languageOptions: { globals: globals.node },
  },

  // Dashboard source: browser globals + the React rules that still matter.
  //
  // Deliberately NOT eslint-plugin-react: its latest release (7.37.5) declares
  // `eslint: "^3 || ... || ^9.7"` and crashes under the ESLint 10 this repo
  // runs. It contributed little here anyway — the two rules it is known for,
  // react-in-jsx-scope and prop-types, are both off under the automatic JSX
  // runtime and TypeScript. react-hooks and react-refresh support ESLint 10 and
  // catch the bugs that actually bite: bad hook deps and HMR-breaking exports.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      // shadcn/ui components export their cva variants next to the component
      // (e.g. `buttonVariants`) so other components can reuse the styles.
      // Name each one here rather than turning the rule off.
      "react-refresh/only-export-components": ["error", { allowExportNames: ["buttonVariants"] }],
    },
  },
]);
```

`fixtures/` is ignored deliberately: those are third-party sample projects the platform *builds*, not code you maintain. Ignoring your agent/tooling directories matters too — a single vendored minified script there produces hundreds of meaningless errors.

Consider upgrading to `tseslint.configs.recommendedTypeChecked` once the services have real code. It requires a `projectService` entry in `languageOptions.parserOptions` and is slower, but it adds `no-floating-promises` and `no-misused-promises`, which catch unawaited Redis, S3 and Docker calls — the most likely bug class in this codebase.

### TypeScript 6 vs 7

`pnpm add -D typescript` now installs **7.x**, the native (Go) compiler. It is much faster, but `typescript-eslint` does not support it yet — linting fails outright with:

```
typescript-eslint does not support TS 7.0.
```

So the root pins `typescript@^6.0.3`, the last release on the JavaScript-based line. This costs nothing at build time: `tsdown`, `tsx` and `vitest` compile through Rolldown/esbuild and never invoke `tsc`. Only `pnpm typecheck` uses the compiler.

Revisit with `pnpm add -Dw typescript@latest` once typescript-eslint ships TS 7 support. If you would rather have the native compiler now, the alternative is to drop `typescript-eslint` from the flat config and rely on `pnpm typecheck` alone for type errors — you keep type safety but lose the lint rules above.

Pin whatever the registry gives you at the time — the versions above were current when this was written, and the toolchain moves fast. TypeScript 7 is the native Go compiler; `tsup` went unmaintained and handed off to `tsdown`; both of those landed while this project was being built.

`tsconfig.base.json`

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "lib": ["ES2023"],
    "module": "ESNext",
    "moduleResolution": "bundler",

    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,

    // tsdown/rolldown transpile file-by-file and cannot see across modules, so
    // constructs that need whole-program knowledge must be rejected here.
    "isolatedModules": true,
    "verbatimModuleSyntax": true,

    "esModuleInterop": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,

    // tsc is only ever used for type checking here; tsdown does the emitting.
    "noEmit": true
  }
}
```

Note there is **no `baseUrl`/`paths` block**. `@shipyard/shared` and `@shipyard/db` resolve through the pnpm workspace symlink plus each package's `exports` field, so the mapping is written down in exactly one place instead of three. `noEmit` is set because `tsc` is only ever a type checker here — `tsdown` does all the emitting.

Every app and package gets a `tsconfig.json` that extends it:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src"] }
```

`.gitignore`

```
node_modules
dist
.env
docker/data
/builds
```

---

## Step 2 — Shared package

### Why

Every service talks to the same three external systems — Postgres, Redis, object storage — and needs the same validated configuration. Putting these clients in `packages/shared` means one implementation, one set of tests, and a guarantee that the router reads objects exactly the way the worker wrote them (same key layout, same metadata).

`env.ts` is the first thing every service runs. Validating `process.env` with a schema at boot turns "the router silently used `undefined` as the bucket name and returned 404 for everything" into an immediate, readable startup error listing the missing variable.

### Dependencies

| Package | Why |
|---|---|
| `zod` | Schema validation for env vars now, and for API request bodies later. One library for both means the dashboard can share the same schemas |
| `@aws-sdk/client-s3` | Official S3 client. Works unchanged against MinIO (dev), Cloudflare R2 and AWS S3 (prod) because all three speak the S3 API |
| `@aws-sdk/lib-storage` | Multipart upload helper for large files; used in Phase 1's upload step so a 200 MB asset doesn't have to be buffered in memory |
| `ioredis` | Redis client with pub/sub, pipelining and reconnect handling. Used for the log stream, route cache and sessions |
| `bullmq` | Job queue built on Redis. Gives retries, concurrency limits, job locking (so two workers never build the same deployment) and delayed/repeatable jobs without hand-rolling Redis lists. **Ships no Redis driver of its own** — see below |
| `ioredis` | Also the driver BullMQ talks through. From bullmq 6 it is an *optional peer dependency*, so every package that constructs a `Queue` or `Worker` must declare it |
| `mime-types` | Maps file extensions to `Content-Type` so the router serves `.css`, `.wasm`, `.webmanifest` etc. with the right header |
| `@types/mime-types` (dev) | Types for the above |

The empty stub files (`storage.ts`, `redis.ts`, …) exist only so `index.ts` compiles now; they are filled in Phase 1.


`packages/shared/package.json`

```json
{
  "name": "@shipyard/shared",
  "version": "0.0.0",
  "description": "Shared env, storage, redis, queue and error helpers",
  "private": true,
  "type": "module",
  "exports": {
    "./env": "./src/env.ts",
    "./storage": "./src/storage.ts",
    "./redis": "./src/redis.ts",
    "./queue": "./src/queue.ts",
    "./slug": "./src/slug.ts",
    "./contentType": "./src/contentType.ts",
    "./errors": "./src/errors.ts"
  },
  "license": "MIT",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "@aws-sdk/client-s3": "^3.1136.0",
    "bullmq": "^6.3.8",
    "ioredis": "^6.0.0",
    "mime-types": "^3.0.2",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/mime-types": "^3.0.1"
  }
}
```

### One export per module, and no barrel

Note the `exports` map: one entry per file, and **no `"."` entry**. Consumers import
the exact module they need:

```ts
import { loadEnv } from "@shipyard/shared/env";
```

The tempting alternative is a single `src/index.ts` that re-exports everything
(`export * from "./redis.js"`, and so on) so consumers can write
`from "@shipyard/shared"`. Don't. Because each app is bundled (Step 4), whatever you
import gets pasted into that app's bundle — and with a barrel, importing `loadEnv`
pulls in the *whole package*. The router, which only ever wants `loadEnv`, would end
up with the AWS S3 client, ioredis and BullMQ inlined into its image. Those packages
have side effects and do not reliably tree-shake.

The worse version of the same problem is a connection opened by accident. If
`redis.ts` ever reads:

```ts
export const redis = new Redis(env.REDIS_URL);   // don't do this
```

then merely importing `loadEnv` through a barrel opens a Redis socket, in every
service, including the ones that never use Redis. So: **construct clients lazily**,
never at module scope.

```ts
let _redis: Redis | undefined;
export function getRedis() {
  return (_redis ??= new Redis(env.REDIS_URL));
}
```

Subpath exports make a wrong import cheap; lazy construction makes it harmless.

Then add the dependencies so the versions are whatever the registry currently has, rather than a pin copied from this page:

```bash
pnpm --filter @shipyard/shared add @aws-sdk/client-s3 @aws-sdk/lib-storage bullmq ioredis mime-types zod
pnpm --filter @shipyard/shared add -D @types/mime-types
```

`zod` resolves to **v4**; the `env.ts` below is written for it.

`packages/shared/src/env.ts` — every service validates its env at boot and fails fast.

```ts
import { z } from "zod";

const base = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  LOG_LEVEL: z.enum(["trace", "debug", "info", "warn", "error"]).default("info"),
  BASE_DOMAIN: z.string().default("localhost"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("deployments"),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  // NOT z.coerce.boolean(): that is Boolean(input), so the string "false" parses as true.
  S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("true").transform(value => value === "true"),
});

export type BaseEnv = z.infer<typeof base>;

/** Parse process.env against the base schema plus any service-specific extension. */
export function loadEnv<T extends z.ZodRawShape = Record<string, never>>(extra?: T) {
  // Always extend, even with an empty shape: a ternary here would make `schema`
  // a union type and z.infer would collapse back to the base, so `env.PORT`
  // would be a type error at every call site.
  const schema = base.extend(extra ?? ({} as T));
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error("Invalid environment:\n" + result.error.issues.map(issue => `  ${issue.path.join(".")}: ${issue.message}`).join("\n"));
    process.exit(1);
  }
  return result.data;
}
```

### Zod v4 notes

`pnpm add zod` installs v4, which changes a few things this codebase uses:

| v3 | v4 | Note |
|---|---|---|
| `z.string().url()` | `z.url()` | The chained form still works but is deprecated. Same for `z.email()`, `z.uuid()` |
| `import type { ZodSchema }` | `z.ZodType` | `ZodSchema` is a deprecated alias; the API's `validate()` middleware uses `z.ZodType` |
| `z.coerce.boolean()` | **avoid** | Unchanged behaviour, but it is `Boolean(input)`, so the string `"false"` parses as `true`. Verified against 4.6.5. Use the `z.enum([...]).transform()` form above for any boolean env var |

Still the same in v4: `.extend()`, `.default()`, `.safeParse()`, `error.issues`, `z.coerce.number()`, and `.toLowerCase()` / `.trim()` on strings. `z.ZodRawShape` is a type-only export, which is all `loadEnv` needs.

Verify the loader before moving on:

```bash
pnpm --filter @shipyard/shared exec tsc --noEmit
```

### BullMQ 6 needs an explicit Redis driver

BullMQ 5 listed `ioredis` as a direct dependency, so installing `bullmq` gave you a client for free. **BullMQ 6 moved it to an optional peer dependency**:

```jsonc
// bullmq@6.3.8
"peerDependencies":     { "ioredis": ">=5.0.0", "redis": ">=5.0.0", "pg": ">=8.0.0", "bullmq-otel": ">=2.0.0" },
"peerDependenciesMeta": { "ioredis": { "optional": true }, "redis": { "optional": true }, … }
```

`pnpm add bullmq` now installs only `tslib`, `semver`, `msgpackr`, `cron-parser` and `node-abort-controller`. Under pnpm's strict resolution an unmet *optional* peer is simply absent, so the queue fails at connect time rather than at install time — a confusing failure if you are not expecting it.

Every package that constructs a `Queue`, `Worker` or `QueueEvents` must therefore declare the driver itself: `packages/shared` and `apps/worker` both do. BullMQ 6 also accepts `node-redis` v5+ via `createNodeRedisClient` if you prefer it; this project uses `ioredis` because the same client also serves the log pub/sub and the route cache.

There is no `src/index.ts` — the `exports` map above is the package's entire public
surface, and each file in it stands alone.

The remaining shared modules (`storage.ts`, `redis.ts`, `queue.ts`, …) are written in Phase 1; create empty files exporting nothing for now so each `exports` entry resolves:

```bash
for f in storage redis queue slug contentType errors; do echo "export {};" > packages/shared/src/$f.ts; done
```

---

## Step 3 — Database package

### Why

Projects and deployments are relational data with real constraints: a project has many deployments, exactly one of which is "active"; slugs and hostnames must be unique; deleting a project must delete its deployments but deleting a deployment must never delete a project. Postgres enforces these; Redis (which the reference implementation uses for everything) cannot.

Prisma is used for the schema, migrations and a typed client. The schema file is the single source of truth: run `prisma migrate dev` and you get both a SQL migration committed to git and a regenerated TypeScript client, so a renamed column fails compilation everywhere it's used.

The schema is written in full now — including columns that Phase 3 (auth, env vars, webhooks) and Phase 5 (domains) will use — so later phases don't need a migration just to add a column, and the data model in the work plan is realised once.

Notable design choices in the schema:

- `Project.activeDeploymentId` is a nullable FK with `onDelete: SetNull`. Promoting a deployment is a pointer flip; rollback is the same flip to an older row. Deleting the active deployment is refused by the API, but if it ever happens the project survives with no live site rather than being cascaded away.
- `Deployment.storagePrefix` is stored explicitly rather than derived, so the storage layout can change later without breaking old rows.
- `@@index([projectId, createdAt(sort: Desc)])` backs the deployment-history list and the "is there a newer ready deployment?" check in promotion.
- `sizeBytes` is `BigInt` because `Int` tops out at 2 GB.
- `Deployment.updatedAt` exists for debugging. A deployment moves through eight statuses, and `createdAt`/`startedAt`/`finishedAt` only mark the ends — when a build wedges in `building`, "when did this row last change?" is the first question you ask, and without it there is no answer. Note that Prisma maintains `@updatedAt` in the **client**, not via a database trigger: rows touched by `$executeRaw` or by hand in `psql` will not have it bumped.

### Dependencies

| Package | Why |
|---|---|
| `prisma` (dev) | The CLI: `migrate`, `generate`, `studio`. Only needed at build/dev time |
| `@prisma/client` | The runtime client the apps import |
| `@prisma/adapter-pg` | **Prisma 7 removed the built-in connection pool.** `new PrismaClient()` now throws unless it is handed a driver adapter; this is the Postgres one. It bundles `pg` as a direct dependency, so `pg` is not installed separately |
| `dotenv` (dev) | Prisma 7 never loads `.env` itself; `prisma7.config.ts` does it. Listed for completeness — `prisma init` installs this and writes the import for you (see below) |

Generated client code is written into the **source tree** at `packages/db/generated/prisma`, not into `node_modules/.prisma` as in Prisma ≤ 6. It is gitignored, which is why every app Dockerfile runs `prisma generate` before building: the directory does not exist in a fresh clone.

The client is exported as a singleton (`globalThis.prisma`) so `tsx watch` restarts in development don't open a new connection pool each time. Under Prisma 7 this matters *more* than it used to: the pool belongs to the adapter you construct, so a leaked client is a leaked `pg` pool.


`packages/db/package.json`

```json
{
  "name": "@shipyard/db",
  "version": "0.0.0",
  "description": "Prisma schema, migrations and typed client",
  "private": true,
  "type": "module",
  "main": "src/index.ts",
  "exports": {
    ".": "./src/index.ts"
  },
  "license": "MIT",
  "scripts": {
    "generate": "prisma generate",
    "migrate": "prisma migrate dev",
    "migrate:deploy": "prisma migrate deploy",
    "seed": "tsx --env-file=../../.env prisma/seed.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@prisma/adapter-pg": "^7.10.0",
    "@prisma/client": "^7.10.0"
  },
  "devDependencies": {
    "dotenv": "^18.0.3",
    "prisma": "^7.10.0"
  }
}
```

```bash
pnpm --filter @shipyard/db add @prisma/client @prisma/adapter-pg
pnpm --filter @shipyard/db add -D prisma dotenv
```

`seed` passes `--env-file=../../.env` explicitly. `prisma7.config.ts` loads the root
`.env` for the Prisma CLI, but `pnpm db:seed` runs `prisma/seed.ts` directly through
`tsx`, which never reads that config — so without the flag the seed script would see
an undefined `DATABASE_URL`.

### Prisma 7 notes

Prisma 7 is a larger break than the version number suggests. Four changes affect this step; all four are load-bearing, and skipping any one produces a confusing failure rather than a clear error.

| Prisma ≤ 6 | Prisma 7 | Consequence |
|---|---|---|
| generator provider `prisma-client-js` | `prisma-client`, with a required `output` | `prisma-client-js` still runs but the CLI labels it *legacy*; the new generator writes TypeScript into your repo instead of `node_modules` |
| `url = env("DATABASE_URL")` in `datasource db` | no `url` in the schema | The datasource URL is read from `prisma7.config.ts`. `prisma init` no longer emits a `url` line at all |
| `.env` auto-loaded by the CLI | **Prisma never loads it** | The loading has to happen in `prisma7.config.ts`. `prisma init` scaffolds `import "dotenv/config"` there and adds `dotenv` for you, so it works out of the box — but nothing is automatic on Prisma's side, and a config file written by hand that omits it sees an undefined `DATABASE_URL` |
| `new PrismaClient()` opens its own pool | requires a driver adapter | `new PrismaClient()` with no arguments throws `PrismaClientInitializationError`. Pass `{ adapter }` |

The underlying reason for the last one: Prisma 7 replaced the Rust query engine with a WebAssembly query compiler (`@prisma/client/runtime/query_compiler_*_bg.wasm`). The compiler turns your query into SQL, but something still has to hold TCP connections — that is now an explicit adapter you own, rather than a binary Prisma shipped.

`prisma migrate`, `prisma generate`, `prisma studio` and the `migrate dev` / `migrate deploy` split are all unchanged.

### `packages/db/prisma7.config.ts`

Prisma 7 looks for `prisma7.config.ts` next to where the CLI is run. It replaces the schema's `url` and the implicit `.env` loading.

`prisma init` writes it for you. Its Node.js template is:

```ts
// generated by `prisma init`
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: process.env["DATABASE_URL"] },
});
```

That already works. This project changes two things and deliberately keeps a third, each for a reason worth knowing:

```ts
import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma does not load .env itself. `prisma init` scaffolds a bare
// `import "dotenv/config"`, which resolves against the cwd (packages/db when
// run via `pnpm --filter @shipyard/db`); anchor on this file instead so the one
// repo-root .env is found no matter where the command is invoked from.
dotenv.config({ path: path.join(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Deliberately optional: `prisma generate` builds the client from the schema
    // alone and must run without a database (e.g. inside a Docker build). The
    // CLI itself rejects a missing url for commands that connect (migrate, db,
    // studio). env() would throw at config load, failing every command instead.
    url: process.env.DATABASE_URL,
  },
});
```

1. **The `.env` path is anchored to this file**, not the cwd. `prisma init` also creates a `packages/db/.env`, which a bare `import "dotenv/config"` picks up — but three services (`api`, `worker`, `router`) read the same `DATABASE_URL` through `loadEnv()` in `packages/shared`, so a package-local file would leave a second copy to drift out of sync. One repo-root `.env` is the single source of truth, which is what `.env.example` already promises.
2. **`process.env.DATABASE_URL` stays, not `env("DATABASE_URL")`.** `prisma/config` also exports `env()`, which throws `PrismaConfigEnvError` when the variable is missing. That looks like the fail-fast contract `loadEnv()` gives the services, but the config file is loaded by *every* Prisma command, including `prisma generate`, which never connects. The service Dockerfiles run `generate` during the image build, where there is no `.env` and no reachable database, so `env()` would fail the build over a value that command never uses. Leaving `url` optional costs nothing: the CLI already fails `migrate`, `db` and `studio` with "The datasource.url property is required in your Prisma config file", and at runtime `createPrismaClient()` and `loadEnv()` reject a missing URL.
3. **`migrations.seed` is set**, so `prisma db seed` works alongside `pnpm db:seed`.

`defineConfig` comes from `prisma/config`, an export of the `prisma` CLI package — not from `@prisma/client`.

One naming note: the upstream Prisma docs call this file `prisma.config.ts`, but prisma 7.10 resolves **`prisma7.config.ts`** as its default config path, and that is what `prisma init` produces. Don't be thrown by the discrepancy when reading the official docs.

Under Bun the scaffold differs again: no dotenv import at all, because Bun loads `.env` itself.

**Add the file to `packages/db/tsconfig.json`'s `include`**, because it sits at the package root rather than under `src`:

```json
{ "extends": "../../tsconfig.base.json", "compilerOptions": { "types": ["node"] }, "include": ["src", "prisma", "prisma7.config.ts"] }
```

Left out, the config file belongs to no TypeScript project, so the editor falls back to a default inferred config with no `types: ["node"]` and reports `Cannot find name 'process'` on the `datasource.url` line. The package installs nothing new — `@types/node` is a root devDependency and TypeScript finds it by walking up to the workspace root `node_modules/@types`.

The `dotenv.config()` call sits below the imports because ES modules hoist every `import` before any statement runs; there is no way to load `.env` "before" an import, and no need to — `defineConfig` reads `process.env` when it is called, not when the module is imported.

`migrations.seed` is what `prisma db seed` invokes. The `pnpm db:seed` script runs the same file directly with `tsx`, so either entry point works; having both means a teammate reaching for the Prisma-native command gets the right thing.

`packages/db/prisma/schema.prisma`

```prisma
generator client {
  provider = "prisma-client"
  output   = "../generated/prisma"
}

datasource db {
  provider = "postgresql"
}

enum DeploymentStatus {
  queued
  cloning
  detecting
  building
  uploading
  ready
  failed
  cancelled
  archived
}

enum DeploymentKind {
  production
  preview
}

model User {
  id          String    @id @default(cuid())
  githubId    Int       @unique
  login       String
  avatarUrl   String?
  accessToken String?   // AES-256-GCM encrypted, base64
  createdAt   DateTime  @default(now())
  projects    Project[]
}

model Project {
  id                 String       @id @default(cuid())
  userId             String
  user               User         @relation(fields: [userId], references: [id], onDelete: Cascade)
  name               String
  slug               String       @unique
  repoUrl            String
  branch             String       @default("main")
  rootDir            String       @default(".")
  installCmd         String?
  buildCmd           String?
  outputDir          String?
  nodeVersion        String       @default("22")
  spaFallback        Boolean      @default(true)
  envVars            String?      // encrypted JSON [{key,value}]
  webhookId          Int?
  webhookSecret      String?      // encrypted
  activeDeploymentId String?      @unique
  activeDeployment   Deployment?  @relation("ActiveDeployment", fields: [activeDeploymentId], references: [id], onDelete: SetNull)
  deployments        Deployment[] @relation("ProjectDeployments")
  domains            Domain[]
  createdAt          DateTime     @default(now())
  updatedAt          DateTime     @updatedAt
}

model Deployment {
  id                String           @id @default(cuid())
  projectId         String
  project           Project          @relation("ProjectDeployments", fields: [projectId], references: [id], onDelete: Cascade)
  activeFor         Project?         @relation("ActiveDeployment")
  kind              DeploymentKind   @default(production)
  prNumber          Int?
  status            DeploymentStatus @default(queued)
  commitSha         String?
  commitMsg         String?
  framework         String?
  resolvedBuildCmd  String?
  resolvedOutputDir String?
  storagePrefix     String
  fileCount         Int?
  sizeBytes         BigInt?
  error             String?
  startedAt         DateTime?
  finishedAt        DateTime?
  createdAt         DateTime         @default(now())
  updatedAt         DateTime         @updatedAt

  @@index([projectId, createdAt(sort: Desc)])
  @@index([status])
}

model Domain {
  id                String   @id @default(cuid())
  projectId         String
  project           Project  @relation(fields: [projectId], references: [id], onDelete: Cascade)
  hostname          String   @unique
  verificationToken String
  verified          Boolean  @default(false)
  failedChecks      Int      @default(0)
  createdAt         DateTime @default(now())
}
```

`output` is resolved relative to the schema file, so `../generated/prisma` lands at `packages/db/generated/prisma` — the path already covered by `.gitignore` and by the `packages/db/generated/**` entry in `eslint.config.ts`. There is deliberately no `url` here; it comes from `prisma7.config.ts`.

The `prisma-client` generator emits `.ts` files rather than `.d.ts` + `.js`, but they carry `// @ts-nocheck` and `/* eslint-disable */` preambles, so they neither slow down `pnpm typecheck` nor need an ESLint exception beyond the ignore entry already present.

It also reads your `tsconfig.json` and adapts the import style of the code it writes: with this repo's `moduleResolution: "bundler"` it emits extensionless relative imports (`from "./enums"`). Generated without a tsconfig in scope it would emit `from "./enums.ts"` instead, which then requires `allowImportingTsExtensions`. If you ever see that, the cause is the generator running somewhere it cannot see `packages/db/tsconfig.json`, not a misconfiguration of the schema.

`packages/db/src/index.ts`

```ts
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Prisma 7 ships no connection pool of its own; the adapter owns the
    // pg connections, so this object is what must not be recreated per reload.
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "../generated/prisma/client";
```

Both the import and the re-export point at the generated directory, not at `@prisma/client` — under the `prisma-client` generator, `@prisma/client` is only the runtime the generated code depends on, never what you import models from. `generated/prisma/client.ts` is the intended entry point and re-exports every model, enum and input type.

These two are extensionless while the hand-written modules in `packages/shared` use `.js` — deliberate, and it matches the extensionless imports the generator writes for itself under this repo's `moduleResolution: "bundler"`.

`log` remains a valid constructor option alongside `adapter`; the full set in Prisma 7 is `adapter`, `accelerateUrl`, `log`, `errorFormat`, `transactionOptions`, `omit`, `comments` and `queryPlanCacheMaxSize`.

`packages/db/prisma/seed.ts`

```ts
import { prisma } from "../src/index.js";

await prisma.user.upsert({
  where: { githubId: 0 },
  update: {},
  create: { githubId: 0, login: "dev", avatarUrl: null },
});
console.log("seeded dev user");
await prisma.$disconnect();
```

---

## Step 4 — App stubs

### Why

Each app is stubbed with a working health endpoint (`/health`, or `/__health` on the router — see below) before any real logic so that the whole delivery path — workspace install, TypeScript build, Docker image, Compose networking, Caddy routing — is proven end-to-end on day one. Later phases add routes to a system that already builds and deploys, instead of debugging infrastructure and business logic at the same time.

The Dockerfile is multi-stage on purpose:

1. **`deps`** copies only the `package.json` files and the lockfile, then installs. Docker caches this layer; source changes don't re-run `pnpm install`.
2. **`build`** copies the source and compiles one app.
3. **`runtime`** starts from the slim base again so build tooling isn't in the final image.

The BuildKit cache mount on the install step keeps the pnpm store between builds on the same machine or CI runner, so even a lockfile change downloads only the packages that changed.

The dashboard is scaffolded with Vite because it's the fastest React dev loop available and its production output is plain static files — which, fittingly, is exactly what this platform deploys.

### Dependencies

**API / router / worker (shared)**

| Package | Why |
|---|---|
| `express` (v5) | HTTP framework. v5 propagates rejected promises from async handlers to the error middleware, removing the need for try/catch wrappers around every route |
| `pino` | Structured JSON logging; ~10× faster than `winston`, and JSON logs are what Loki/Datadog/CloudWatch ingest natively |
| `pino-http` | Express middleware that logs each request with method, path, status and duration, and attaches `req.log` |
| `zod` | Validates route bodies (`PORT` here; project/deployment payloads in Phase 1) |
| `@shipyard/shared`, `@shipyard/db` | Workspace links to the packages above |
| `@types/express` (dev) | Types for Express |
| `pino-pretty` (dev) | Human-readable log output during development only (`LOG_PRETTY=1`); production stays JSON |

**Worker only** (added in Phase 1, listed here for completeness): `dockerode` (Docker Engine API client — creates, attaches to and kills build containers over the Unix socket, no Docker CLI needed), `simple-git` (clone/checkout with a promise API), `fast-glob` (walk the output directory), `p-limit` (bound the number of concurrent uploads).

**Dashboard**

| Package | Why |
|---|---|
| `react`, `react-dom` | UI |
| `vite`, `@vitejs/plugin-react` | Dev server with HMR; production bundler |
| `tailwindcss`, `@tailwindcss/vite` | Utility CSS; the Vite plugin removes the need for a PostCSS config |
| `typescript` | Same strict settings as the backend |

The `allowedHosts: ["app.localhost"]` setting is required because Vite's dev server refuses requests from unknown `Host` headers (a DNS-rebinding protection) and Caddy forwards `app.localhost`.


Each app has the same shape; shown here for `api`, repeat for `worker` and `router` with the port changed.

`apps/api/package.json`

```json
{
  "name": "@shipyard/api",
  "version": "0.0.0",
  "description": "Control plane: auth, projects, deployments, log streaming, webhooks",
  "private": true,
  "type": "module",
  "license": "MIT",
  "files": [
    "dist"
  ],
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsdown",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run --passWithNoTests"
  },
  "dependencies": {
    "express": "^5.2.1",
    "pino": "^10.3.1",
    "pino-http": "^11.0.0",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@shipyard/db": "workspace:*",
    "@shipyard/shared": "workspace:*",
    "@types/express": "^5.0.6",
    "pino-pretty": "^13.1.3"
  }
}
```

Dependencies go in with `pnpm add` rather than hand-written pins:

```bash
pnpm --filter @shipyard/api add express pino pino-http zod
pnpm --filter @shipyard/api add -D @types/express pino-pretty
pnpm --filter @shipyard/api add -D @shipyard/shared @shipyard/db --workspace
```

The `--workspace` flag is what records `"@shipyard/shared": "workspace:*"` — pnpm symlinks your source directory instead of fetching from npm, so edits are picked up with no build or publish step.

**Note the `-D` on the third line.** The workspace packages go in `devDependencies`, which looks wrong the first time you see it — they are plainly used at runtime. It is deliberate, and "How the app images are built" below explains exactly what it buys. In short: it is what makes `tsdown` paste their code into the bundle, so the running container needs no `@shipyard/*` directory at all.

Repeat all three lines for `@shipyard/router`; the worker takes a different set:

```bash
pnpm --filter @shipyard/worker add bullmq ioredis dockerode simple-git fast-glob p-limit pino
pnpm --filter @shipyard/worker add -D @types/dockerode
pnpm --filter @shipyard/worker add -D @shipyard/shared @shipyard/db --workspace
```

Each service splits its entry point in two: `index.ts` builds and exports the app, `server.ts` starts listening. That keeps the app importable from tests (and, later, from an e2e suite) without a process binding a port as a side effect of the import. `lib/clients.ts` holds the parsed env and, from Phase 1, the shared clients — so nothing in the entry point has to move when they arrive.

`apps/api/src/lib/clients.ts`

```ts
import { loadEnv } from "@shipyard/shared/env";
import { z } from "zod";

export const env = loadEnv({ PORT: z.coerce.number().default(4000) });
```

`apps/api/src/index.ts` (stub; routes arrive in Phase 1)

```ts
import express from "express";
import pinoHttp from "pino-http";

import { prisma } from "@shipyard/db";
import { env } from "./lib/clients.js";

const app = express();
app.use(pinoHttp({ level: env.LOG_LEVEL }));
app.use(express.json({ limit: "1mb" }));

// Routes mount flat, as every phase doc writes them — no /v1 prefix. There is
// no compatibility boundary to version across: the dashboard ships in this
// repo and deploys in the same stack. If the Phase 6 CLI ever lands, add the
// prefix then and change the one BASE constant on the dashboard side.
app.get("/health", async (_req, res) => {
  const checks = { db: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {
    /* an unreachable DB is the signal, not an error to surface */
  }
  const ok = checks.db;
  res.status(ok ? 200 : 503).json({ ok, ...checks });
});

export default app;
```

`apps/api/src/server.ts`

```ts
import app from "./index.js";
import { env } from "./lib/clients.js";

app.listen(env.PORT, () => console.log(`api listening on ${env.PORT}`));
```

`apps/router/src/index.ts` (stub) — note the health path is `/__health`, not `/health`

```ts
import express from "express";
import pinoHttp from "pino-http";

import { env } from "./lib/clients.js";

const app = express();

// Caddy terminates TLS in front of this process, so req.protocol and req.ip
// have to come from the forwarded headers rather than the socket.
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(pinoHttp({ level: env.LOG_LEVEL }));

// Double-underscored because this process serves arbitrary user sites on
// wildcard subdomains: a bare /health would shadow that path in every deployed
// site. Compose's healthcheck for `router` must target this exact path.
app.get("/__health", (_req, res) => res.json({ ok: true }));

// Placeholder until Phase 1 adds host resolution and object-storage serving.
app.use((req, res) =>
  res.status(404).type("text").send(`No deployment for ${req.hostname}`),
);

export default app;
```

The router is the one service that serves arbitrary user sites on wildcard subdomains, so a bare `/health` would shadow that path in every deployed site. Compose's healthcheck for `router` in Step 6 must target `/__health` to match. The API keeps the ordinary `/health`, because nothing else is ever served from that origin.

`apps/worker/src/index.ts` (stub)

```ts
import { log } from "./lib/clients.js";

// No BullMQ consumer and no HTTP server yet — both arrive in Phase 1, and the
// worker's /health lands on a separate metrics port in Phase 6. This stub
// exists so the image, Compose wiring and env validation are proven now.
log.info("worker up (no consumer yet)");

// Keep the event loop alive; without a queue subscription there is nothing
// else holding the process open.
setInterval(() => {}, 1 << 30);
```

`apps/web` — scaffold with Vite:

```bash
pnpm create vite apps/web --template react-ts
cd apps/web && pnpm add -D tailwindcss @tailwindcss/vite && cd ../..
```

Add `server: { host: true, port: 5173, allowedHosts: ["app.localhost"] }` to `apps/web/vite.config.ts`.

Each app also has a `tsdown.config.ts`. The three are identical apart from the entry point:

```ts
import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/server.ts"],
  target: "node22",
  // Emit .js, not tsdown's default .mjs. This package is `"type": "module"`, so
  // .js is already ESM, and the Dockerfile's CMD and `pnpm start` both name it.
  outExtensions: () => ({ js: ".js" }),
  deps: {
    // Inline the workspace packages so the production tree needs no @shipyard/*.
    // This app's own `dependencies` stay external and are installed by `pnpm deploy`.
    alwaysBundle: [/^@shipyard\//],
    // Bundling the workspace packages' own dependencies is the intent here, not an
    // accident, so silence the hint that offers to guard against it.
    onlyBundle: false,
  },
});
```

Three of tsdown's defaults are why this file is so short: it emits ESM (tsup defaulted
to CJS), it cleans `dist/` before each build, and its `platform` is `node`. That last
one earns its keep. Prisma's runtime and `pg` are CommonJS and call `require()` for
Node built-ins; ESM output has no `require`, so bundling them normally means
hand-writing a shim:

```ts
// not needed under tsdown — it injects this itself on platform: "node"
banner: { js: "import { createRequire } from 'node:module';\nconst require = createRequire(import.meta.url);" }
```

Without that shim the build still succeeds and the container dies on its first query,
so it is worth confirming the injection actually happened rather than assuming:
`grep -c createRequire apps/api/dist/server.js`.

The two options that *are* set:

- `outExtensions` — tsdown emits `.mjs` by default, which suits a library shipping
  both module formats. These packages are already `"type": "module"`, so `.js` is
  unambiguously ESM, and it is the name the Dockerfile's `CMD` and `pnpm start` both
  use. Left at the default, `node dist/server.js` fails with "Cannot find module".
- `deps.onlyBundle: false` — tsdown otherwise prints a hint listing every dependency
  that got bundled (here: `@prisma/client`, `pg` and its ~15 transitive packages) and
  offers to let you restrict it. For a library that hint catches a real mistake. Here
  the bundling is the entire point, so it is noise on every build.

Shared `Dockerfile` pattern for the three Node apps (`apps/api/Dockerfile`; worker and router identical except the `--filter` and the `CMD`):

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
COPY packages/db/package.json packages/db/
# Cache mount: the pnpm store persists across image builds on the same host / CI runner,
# so a lockfile change re-downloads only the packages that changed.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
# `prisma generate` first: the client is written into the source tree at
# packages/db/generated/prisma, which is gitignored and so absent from the context.
RUN pnpm --filter @shipyard/db generate && pnpm --filter @shipyard/api build
# Prune to a self-contained production tree: only @shipyard/api's `files`
# (dist/) plus its `dependencies`, with workspace links resolved to real
# directories. Dev tooling (tsup, tsx, vitest, typescript, prisma) is excluded.
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm deploy --filter @shipyard/api --prod /out

FROM base AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
# Documents the port for `docker run -P`, Compose and image inspectors.
# Must match the PORT this service is given; it publishes nothing by itself.
EXPOSE 4000
CMD ["node", "dist/server.js"]
```

### How the app images are built

This is the most subtle part of the setup, and it is worth understanding before Phase 1 — it decides what ends up inside each container.

When `tsdown` builds an app, then for every `import` it has to make one of two choices:

1. **paste** that library's code straight into `dist/server.js`, or
2. **leave the import alone**, and expect `node_modules` to supply it at runtime.

The rule it uses is a single line: *look at that app's own `package.json`. Is the package listed in `dependencies`? Then leave it alone. Otherwise, paste it in.*

Follow that through for `apps/api`:

| Package | Where it's declared | What happens |
|---|---|---|
| `express`, `pino`, `pino-http`, `zod` | `apps/api` → `dependencies` | left alone; must exist in the image |
| `@shipyard/shared`, `@shipyard/db` | `apps/api` → **`devDependencies`** | pasted in |
| `ioredis`, `bullmq`, `@aws-sdk/client-s3` | `packages/shared` → its own `dependencies` | pasted in — they are not in *`apps/api`'s* `dependencies` |
| `@prisma/client`, `@prisma/adapter-pg` | `packages/db` → its own `dependencies` | pasted in |

So **that `-D` on the workspace packages is doing real work.** It is what makes `tsdown` inline them, which in turn means the running container never needs a `@shipyard/*` folder, never needs the generated Prisma client on disk, and never needs a `pnpm install` that understands workspaces. Move those two lines into `dependencies` and the image would instead need the whole workspace shipped alongside it.

That is also why the build stage ends with:

```
pnpm deploy --filter @shipyard/api --prod /out
```

`pnpm deploy` writes a self-contained tree containing the package's `files` (just `dist/`) plus its `dependencies`, with workspace links resolved to real directories. Since almost everything was pasted into the bundle, the only things it actually installs are the four packages in the first row above. Dev tooling — `tsdown`, `tsx`, `vitest`, `typescript`, `prisma` — is excluded by `--prod`, so the runtime stage copies `/out` and nothing else.

Two consequences worth carrying forward:

- **Import only the subpath you need** (`@shipyard/shared/env`, not a barrel), because whatever you import gets pasted in. This is what Step 2's `exports` map is for.
- **A large bundle is normal here.** `apps/api/dist/` is around 5 MB, of which 4.4 MB is Prisma's WebAssembly query compiler. That is the engine that turns your queries into SQL, and it is inlined rather than installed. Nothing is wrong.

You can always check what a bundle expects to find at runtime:

```bash
grep -oE '^import[^;]*from *"[^"]+"' apps/api/dist/server.js | grep -v '\./' | sort -u
# express, pino-http, zod, plus node: built-ins — every one of them in apps/api's dependencies
```

If a package ever shows up in that list that is *not* in the app's `dependencies`, the image will build green and then crash on startup. The command above is the cheap way to catch it.

> **Modern vs legacy Docker conventions used in this guide**
>
> | Legacy | Used here | Why |
> |---|---|---|
> | `docker-compose.yml` + `docker-compose` (v1, Python) | `compose.yaml` + `docker compose` (v2, Go plugin) | v1 is EOL; v2 treats `compose.yaml` as the canonical filename (`docker-compose.yml` still works but is the fallback) |
> | `version: "3.8"` at the top of the compose file | omitted | The `version` key is ignored by Compose v2 and prints a warning |
> | `RUN npm install` re-downloading everything on each build | `# syntax=docker/dockerfile:1` + `RUN --mount=type=cache` | BuildKit cache mounts keep the package store between builds; requires BuildKit, which is the default in Docker ≥ 23 and in `docker/build-push-action` |
> | One `docker build` per image in CI | Docker Bake (`docker-bake.hcl`) — see Phase 5 | Builds all images in parallel from one definition; optional |
>
> `Dockerfile` and `compose.yaml` are not alternatives: a Dockerfile builds **one image**, a compose file runs **several containers together**. This project has one Dockerfile per app plus the builder image, and one compose file per environment.

The worker image additionally needs `git` and the Docker CLI is *not* needed (dockerode talks to the socket directly):

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
```

---

## Step 5 — Builder image

### Why

User builds run inside a container created from this image, not on the worker host. That is the single most important security decision in the project: a repository's `postinstall` script is arbitrary code chosen by a stranger. The container gives it a throwaway filesystem, no access to the worker's credentials or the Docker socket, and CPU/memory/time limits (set at run time in Phase 1).

A **pre-built** image is used rather than installing tools at build time because:

- installing git, pnpm and yarn on every build would add 20–30 s and a network dependency to each deployment;
- pinning the image gives reproducible builds — the same repo built next month uses the same toolchain;
- one image per supported Node major (`node20`, `node22`, `node24`) lets projects choose a runtime without the platform maintaining a version manager. `node22` is the default: Node 20 left its maintenance window in April 2026, so it is offered only for projects that still pin it.

Running as a non-root user (`builder`, uid 10001) means that even if a build escapes into the container's filesystem it can't modify system paths, and files it writes to the mounted workspace are owned by a predictable uid the worker can clean up.

### What's installed and why

| Component | Why |
|---|---|
| `node:${NODE_MAJOR}-bookworm-slim` | Official Node image on Debian slim — small (~75 MB), glibc-based so native modules' prebuilt binaries work (Alpine/musl often forces a from-source compile) |
| `git` | Some `npm install`s fetch dependencies from git URLs; also needed if a build script calls `git rev-parse` for a version string |
| `ca-certificates` | TLS roots for `npm`/`pnpm` to reach registries over HTTPS |
| `python3`, `make`, `g++` | Toolchain for `node-gyp`. Packages such as `sharp`, `better-sqlite3`, `node-sass` and `canvas` compile native code when no prebuilt binary matches. Without these, a meaningful fraction of real projects fail to install |
| `corepack` + pinned `pnpm` / `yarn` | Corepack ships with Node and provisions the exact package-manager version; pinning avoids a surprise major upgrade breaking installs |
| `COREPACK_HOME=/opt/corepack` | `corepack prepare` runs as root, and by default caches into `/root/.cache`, which the `builder` user cannot read — so every build would re-download pnpm. A shared, world-readable location keeps the pre-download useful |
| `CI=true` | Makes most tools non-interactive and disables progress bars; CRA, for example, treats warnings as errors under `CI=true`, which matches what users see in GitHub Actions |
| `NPM_CONFIG_FUND`, `NPM_CONFIG_AUDIT`, `NPM_CONFIG_UPDATE_NOTIFIER=false` | Skip the funding banner, the audit network call and the "new version available" check — pure noise in build logs and each costs time |
| `NEXT_TELEMETRY_DISABLED`, `ASTRO_TELEMETRY_DISABLED` | Stop frameworks phoning home from inside the sandbox |


One Dockerfile serves every Node major: `ARG` before `FROM` makes the base image a build argument, so the three images cannot drift apart.

`docker/builder/Dockerfile`

```dockerfile
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
 # A dedicated uid, not the image's `node` (1000): on a Linux host 1000 is usually a
 # real login account. Must match SANDBOX_UID in apps/worker/src/lib/constants.ts.
 && groupadd -g 10001 builder \
 && useradd -u 10001 -g builder -d /home/builder -m -s /bin/sh builder \
 && mkdir -p /app /cache && chown builder:builder /app /cache

USER builder
WORKDIR /app
ENV CI=true \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NEXT_TELEMETRY_DISABLED=1 \
    ASTRO_TELEMETRY_DISABLED=1
```

`python3 make g++` are included because a handful of popular packages (`sharp`, `node-sass`, `esbuild` fallbacks) need to compile native modules.

The tags are declared once in a bake file, whose `matrix` expands one target into `node20`, `node22` and `node24`:

`docker/builder/docker-bake.hcl`

```hcl
# Builds shipyard/builder:node20, :node22 and :node24 from the one Dockerfile.
#   docker buildx bake -f docker/builder/docker-bake.hcl --load           # all
#   docker buildx bake -f docker/builder/docker-bake.hcl --load node22    # one
group "default" { targets = ["builder"] }

target "builder" {
  name       = "node${v}"
  matrix     = { v = ["20", "22", "24"] }
  context    = "docker/builder"
  dockerfile = "Dockerfile"
  args       = { NODE_MAJOR = v }
  tags       = ["shipyard/builder:node${v}"]
}
```

`context` is resolved relative to where `bake` is run — the repo root, via the pnpm scripts. `--load` puts the result in the local image store (bake's default is to leave it in the build cache). Build the default image:

```bash
pnpm builder:build       # node22 only
pnpm builder:build:all   # node20, node22, node24 in parallel — needed from Phase 3
```

A one-off build without bake is `docker build --build-arg NODE_MAJOR=20 -t shipyard/builder:node20 docker/builder`.

---

## Step 6 — Docker Compose

### Why

Compose describes the whole local environment as one file so a new contributor runs `docker compose up` and gets Postgres, Redis, MinIO, Caddy and the four apps wired together identically to production. Each piece is there for a specific reason:

| Service | Why it exists |
|---|---|
| `postgres` | Relational store for users, projects, deployments, domains (see Step 3) |
| `redis` | Three jobs: BullMQ's queue storage, pub/sub for live log streaming, and short-TTL caches (subdomain → deployment lookups, sessions). `--appendonly yes` so queued jobs survive a Redis restart |
| `minio` | S3-compatible object store. In production this is Cloudflare R2 or AWS S3; using MinIO locally means the exact same `@aws-sdk/client-s3` code path runs in dev, including content-type metadata, cache headers and `NoSuchKey` handling. The console on `:9001` lets you browse what a build uploaded |
| `minio-init` | One-shot container that creates the `deployments` bucket. S3 buckets don't auto-create, and the worker's first upload would fail without it; `depends_on: service_completed_successfully` sequences it |
| `caddy` | Reverse proxy and TLS. Locally it terminates HTTPS with an internal CA and routes `api.localhost`, `app.localhost` and `*.localhost` to the right container — the same wildcard-subdomain behaviour production needs, so routing bugs show up early |
| `api`, `worker`, `router`, `web` | The four apps, built from their Dockerfiles |
| `build_egress` network | A second Docker network that only the worker (and the build containers it spawns) join. Build containers are attached to *this* network only, so they can reach npm registries on the internet but cannot open a socket to `postgres`, `redis` or `minio`, which live on `default`. This is what stops a malicious build script from reading the platform database |

Two settings on the worker deserve explanation:

- **`/var/run/docker.sock` mount** — the worker creates build containers by talking to the host's Docker daemon. This is powerful (root-equivalent on the host), which is why the *worker* is trusted code and *builds* run in separate containers that do **not** get the socket.
- **`BUILDS_HOST_PATH` + `./data/builds:/builds`** — the worker clones repos into `/builds/<id>`, then asks the Docker daemon to bind-mount that directory into a build container. The daemon resolves bind paths on the *host*, not inside the worker container, so the worker must know the host-side path of the same directory. That's the only reason this env var exists.

Healthchecks on Postgres, Redis and MinIO plus `depends_on: condition: service_healthy` mean the apps start only once their dependencies accept connections, avoiding a crash-loop on first boot.

### Caddyfile

`tls internal` makes Caddy act as its own certificate authority for `*.localhost`, so the dashboard, API and deployed sites are all served over HTTPS locally. `local_certs` in the global block tells Caddy not to attempt Let's Encrypt for these names.

### Why HTTPS locally

Plain HTTP would work for Phase 0 and Phase 1. HTTPS is kept so that local dev runs the same code path as production. Serving HTTP locally costs three things, and each one only shows up later:

- **Cookies.** Phase 3 sets the session cookie with `secure: true`, so the browser only sends it over HTTPS. On local HTTP that needs an "if local" switch (`secure: isProduction`). That switch is production code, and a wrong value there quietly weakens production cookies without breaking anything. With local HTTPS the switch never exists.
- **Mixed content.** A hardcoded `http://` fetch or asset works on a local HTTP page, but production (HTTPS) blocks it. With local HTTPS you hit the same block on your own machine first.
- **Connection limit.** Over HTTP/1.1, browsers open at most about 6 connections per host. Every open log stream (Phase 2 uses Server-Sent Events) holds one, so a few dashboard tabs freeze all other requests. Caddy speaks HTTP/2 over HTTPS, which runs everything over one connection. Production never hits this, so on local HTTP it is a fake bug you would waste time on.

The cost is certificate trust. Caddy signs with its own CA, which your machine doesn't trust yet, so browsers show a warning and tools like HTTPie report "Unable to get local issuer certificate". See [Trusting the Caddy CA](#trusting-the-caddy-ca) below, or use the plain-HTTP ports in [Which URL to use](#which-url-to-use).

Production doesn't have this problem: Phase 5 issues real Let's Encrypt certificates, which every client already trusts.

### Dependencies (images)

| Image | Why this one |
|---|---|
| `postgres:16` | Current major; pinned so a future `17` doesn't change behaviour under you |
| `redis:7` | Required by BullMQ (needs ≥ 6.2; 7 for the latest stream commands) |
| `minio/minio`, `minio/mc` | Server and its CLI (`mc`) for bucket bootstrap |
| `caddy:2` | Automatic TLS, simple config; Phase 5 swaps in a custom build with the Cloudflare DNS plugin |


`docker/compose.yaml` (Compose v2 canonical name; no `version:` key)

```yaml
name: shipyard

x-app-env: &app-env
  NODE_ENV: development
  BASE_DOMAIN: localhost
  DATABASE_URL: postgres://shipyard:shipyard@postgres:5432/shipyard
  REDIS_URL: redis://redis:6379
  S3_ENDPOINT: http://minio:9000
  S3_BUCKET: deployments
  S3_ACCESS_KEY: minio
  S3_SECRET_KEY: minio12345
  S3_FORCE_PATH_STYLE: "true"

services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: shipyard
      POSTGRES_PASSWORD: shipyard
      POSTGRES_DB: shipyard
    volumes: [pgdata:/var/lib/postgresql/data]
    ports: ["5432:5432"]
    healthcheck: { test: ["CMD-SHELL", "pg_isready -U shipyard"], interval: 5s, retries: 10 }

  redis:
    image: redis:7
    command: ["redis-server", "--appendonly", "yes"]
    volumes: [redisdata:/data]
    ports: ["6379:6379"]
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 5s, retries: 10 }

  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment: { MINIO_ROOT_USER: minio, MINIO_ROOT_PASSWORD: minio12345 }
    volumes: [miniodata:/data]
    ports: ["9000:9000", "9001:9001"]
    healthcheck: { test: ["CMD", "mc", "ready", "local"], interval: 5s, retries: 10 }

  minio-init:
    image: minio/mc
    depends_on: { minio: { condition: service_healthy } }
    entrypoint: >
      /bin/sh -c "
      mc alias set local http://minio:9000 minio minio12345 &&
      mc mb --ignore-existing local/deployments &&
      echo bucket ready"

  api:
    build: { context: .., dockerfile: apps/api/Dockerfile }
    environment: { <<: *app-env, PORT: 4000 }
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ["4000:4000"]

  worker:
    build: { context: .., dockerfile: apps/worker/Dockerfile }
    environment:
      <<: *app-env
      BUILD_CONCURRENCY: 2
      BUILD_TIMEOUT_MS: 900000
      BUILDS_HOST_PATH: ${PWD}/data/builds   # host path of the shared volume (see Phase 1)
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ./data/builds:/builds
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
      minio-init: { condition: service_completed_successfully }
    networks: [default, build_egress]

  router:
    build: { context: .., dockerfile: apps/router/Dockerfile }
    environment: { <<: *app-env, PORT: 4001 }
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }
    ports: ["4001:4001"]
    # /__health, not /health — the router serves user sites on wildcard
    # subdomains, so a bare /health would collide with a deployed site's own.
    healthcheck:
      test: ["CMD-SHELL", "node -e \"fetch('http://localhost:4001/__health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
      interval: 5s
      retries: 10

  web:
    build: { context: ../apps/web }
    command: ["pnpm", "dev"]
    ports: ["5173:5173"]

  caddy:
    image: caddy:2
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddydata:/data
    depends_on: [api, router, web]

networks:
  default: {}
  build_egress:
    # Builder containers join only this network: they can reach the internet
    # but not postgres/redis/minio, which live on `default`.
    name: shipyard_build_egress
    driver: bridge

volumes:
  pgdata: {}
  redisdata: {}
  miniodata: {}
  caddydata: {}
```

`docker/Caddyfile` (development)

```caddyfile
{
	local_certs
}

# One certificate per hostname, issued on first request. A `*.localhost`
# wildcard is what plain `tls internal` would produce here, and clients reject
# wildcards directly under a top-level name, even with Caddy's CA trusted.
# No `ask` guard: only this machine can reach it, and every certificate is
# signed by the local CA. Production (Caddyfile.prod) guards on_demand with `ask`.
(dev_tls) {
	tls internal {
		on_demand
	}
}

api.localhost {
	import dev_tls
	reverse_proxy api:4000
}

app.localhost {
	import dev_tls
	reverse_proxy web:5173
}

*.localhost, localhost {
	import dev_tls
	reverse_proxy router:4001
}
```

`tls internal` on its own would give every subdomain one `*.localhost` wildcard certificate, and clients reject wildcards directly under a top-level name, even with Caddy's CA trusted (Caddy logs "most clients do not trust second-level wildcard certificates"). `on_demand` makes Caddy issue a certificate for each hostname on its first request instead, so `api.localhost`, `app.localhost` and every deployed site's subdomain get a certificate for their exact name.

If you ran an older version of this file, Caddy still has the wildcard certificate saved. Delete it once so the per-host certificates are used: `docker compose exec caddy rm -rf /data/caddy/certificates/local/wildcard_.localhost && docker compose restart caddy`. The CA itself (`/data/caddy/pki`) is untouched, so a CA you already trusted stays trusted.

Editing `docker/Caddyfile` while Caddy runs: the file is bind-mounted on its own, and editors that save by replacing the file leave the container reading the old one. Use `docker compose up -d --force-recreate caddy` rather than `caddy reload`.

### Trusting the Caddy CA

Caddy creates its CA on first start and keeps it in the `caddydata` volume. Until your machine trusts that CA, browsers show a warning (click through it) and `curl` needs `-k`. `docker compose exec caddy caddy trust` does **not** help: it trusts the CA inside the Caddy container, not on your machine.

This is optional and done once per machine. To remove the warnings, copy the root certificate out and trust it on the host:

```bash
docker compose -f docker/compose.yaml cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

| OS | Command |
|---|---|
| macOS | `sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain caddy-root.crt` |
| Debian / Ubuntu | `sudo cp caddy-root.crt /usr/local/share/ca-certificates/ && sudo update-ca-certificates` |
| Windows (admin shell) | `certutil -addstore -f ROOT caddy-root.crt` |

Some clients keep their own CA list and ignore the OS store: Firefox, HTTPie, Node, and curl on some systems. For those, either use the plain-HTTP ports ([Which URL to use](#which-url-to-use)), or point them at the file: `curl --cacert caddy-root.crt`, `http --verify=caddy-root.crt`, `NODE_EXTRA_CA_CERTS=caddy-root.crt`. Firefox has its own certificate settings page.

The CA is valid for ten years and survives restarts and rebuilds. Redo this only after `docker compose down -v`, which deletes the volume, so Caddy creates a new CA.

**Never commit the CA.** The volume also holds `root.key`, and anyone who has it can create certificates your machine would accept for *any* domain. `caddy-root.crt` is gitignored.

`docker/.env.example`

```
# copied into docker/.env — never commit .env
BASE_DOMAIN=localhost
BUILD_CONCURRENCY=2
BUILD_TIMEOUT_MS=900000
```

---

## Step 7 — Bring it up

### Why

This step proves every layer in order: dependencies resolve, the Prisma client generates, containers start and pass healthchecks, migrations apply, and Caddy routes traffic to the right process. If anything in later phases misbehaves, you can come back to these four `curl`s to bisect infrastructure from application logic.

Running only the infrastructure in Compose and the apps on the host with `pnpm dev` is the normal day-to-day workflow: hot reload via `tsx watch`/Vite is faster than rebuilding images, and you can attach a debugger. The full Compose stack is what CI and production use.


```bash
pnpm install
cp .env.example .env     # the one .env for host-run apps and the Prisma CLI
pnpm db:generate
pnpm infra:up
pnpm db:migrate          # reads DATABASE_URL from the root .env via prisma7.config.ts
pnpm db:seed
curl -k https://api.localhost/health      # {"ok":true,"db":true}
curl -k https://foo.localhost/__health    # {"ok":true}
curl -k https://foo.localhost/            # No deployment for foo.localhost
```

`-k` skips certificate checks because Caddy's CA isn't trusted yet. Once you have trusted it ([Trusting the Caddy CA](#trusting-the-caddy-ca)), drop the `-k`.

### Which URL to use

Every service is reachable two ways: through Caddy over HTTPS, or directly on its published port over plain HTTP.

| Who | URL | Notes |
|---|---|---|
| HTTPie, curl, tests, scripts | `http://localhost:4000/health` (api), `http://localhost:4001/__health` (router), `curl -H 'Host: foo.localhost' http://localhost:4001/` (router, one site) | No TLS, so nothing to trust. Works on every OS and in every tool |
| Browser | `https://api.localhost`, `https://app.localhost`, `https://<anything>.localhost` | Through Caddy, the same way production routes traffic. Needs the CA trusted, or a click-through per hostname |
| Worker | none | No HTTP server until Phase 1. Check `docker compose logs worker` for `worker up (no consumer yet)` |

When the apps run on the host with `pnpm dev` (see below), only the direct ports work. Caddy forwards to container names (`api:4000`), which don't exist in that mode.

If a Prisma command fails with `PrismaConfigEnvError: Cannot resolve environment variable: DATABASE_URL`, the root `.env` is missing or unreadable — run `cp .env.example .env`. Prisma does not read `.env` by itself, and the CLI runs with `cwd=packages/db`, so the `dotenv.config({ path: … })` line in `prisma7.config.ts` is what makes the repo-root file visible. Don't suspect Postgres: a genuinely unreachable database fails differently — it hangs on connect, then times out.

For day-to-day development you will usually run only the infrastructure in Compose (`docker compose up postgres redis minio minio-init caddy`) and the four apps with `pnpm dev` on the host, pointing `DATABASE_URL` etc. at `localhost`. The worker still needs `/var/run/docker.sock` access and a `BUILDS_HOST_PATH` it can bind-mount — on macOS with Docker Desktop that just means a directory under your home.

---

## Checklist

- [ ] Workspace installs with `pnpm install --frozen-lockfile`
- [ ] `pnpm typecheck` and `pnpm lint` both pass with no output
- [ ] `packages/db/prisma7.config.ts` exists and `pnpm db:generate` writes `packages/db/generated/prisma` (gitignored)
- [ ] Prisma migration `init` committed under `packages/db/prisma/migrations`
- [ ] `shipyard/builder:node22` image builds and `docker run --rm shipyard/builder:node22 node -v` prints `v22.x`
- [ ] Compose healthchecks all green; MinIO bucket `deployments` exists
- [ ] `https://api.localhost/health`, `https://app.localhost`, `https://x.localhost` all route correctly
- [ ] Each app bundle's external imports are all declared in that app's own `dependencies` (see "How the app images are built"):
      `grep -oE '^import[^;]*from *"[^"]+"' apps/api/dist/server.js | grep -v '\./' | sort -u`
