# Implementation Plan — Index

Companion to [deploy-platform-work-plan.md](deploy-platform-work-plan.md). That document covers *what* and *why*; the per-phase guides below cover *how*, with the actual code, file layout, and a "done when" checklist for each phase. Work them in order — every phase assumes the previous one is complete.

| Phase | Guide | Outcome | Time |
|---|---|---|---|
| 0 | [Setup](docs/phases/phase-0-setup.md) | Monorepo, Docker Compose infra (Postgres, Redis, MinIO, Caddy), builder image, Prisma schema, app stubs | 1–2 days |
| 1 | [End-to-end pipeline](docs/phases/phase-1-pipeline.md) | Shared storage/queue modules, API routes, `detectFramework()`, Docker-sandboxed worker pipeline, router with SPA fallback, fixture repos, e2e tests, CI | 1–2 weeks |
| 2 | [Logs, dashboard, history](docs/phases/phase-2-logs-dashboard.md) | SSE log streaming with reconnect/resume, detect endpoint, React dashboard, promote/rollback, deployment history | ~1 week |
| 3 | [Auth & GitHub](docs/phases/phase-3-auth-github.md) | Encrypted secrets, GitHub OAuth + sessions, repo picker, private clones, push webhooks with HMAC verification, env vars, Node version, rate limits | ~1 week |
| 4 | [Hardening & throughput](docs/phases/phase-4-hardening.md) | Cancellation, orphan cleanup, superseded-build dedupe, per-project dependency cache, multi-host workers, extra sandbox limits | 3–5 days |
| 5 | [Production serving](docs/phases/phase-5-production.md) | Wildcard + on-demand TLS via Caddy, custom domains with DNS verification, CDN purge, brotli/gzip pre-compression, retention GC, CI/CD for the platform | ~1 week |
| 6 | [Operations & stretch](docs/phases/phase-6-operations.md) | Structured logs, Prometheus metrics + alerts, PR preview deployments, CLI upload path, teams/quotas/badges, runbook | ongoing |

The visual spec for every screen (landing, dashboard, auth, error pages, router 404) lives in [UI design](docs/phases/ui-design.md), and how to build it (app structure, component catalogue, implementation notes) in [UI implementation](docs/phases/ui-implementation.md). Phases 2 and 3 build their UI to them.

## Repository layout produced by the guides

```
shipyard/
├─ apps/
│  ├─ api/        Express control plane (auth, projects, deployments, logs, webhooks, domains)
│  ├─ worker/     BullMQ consumer: clone → detect → Docker build → upload → promote
│  ├─ router/     wildcard-subdomain static server backed by object storage
│  └─ web/        React + Vite dashboard
├─ packages/
│  ├─ shared/     env, storage, redis, queue, detect, crypto, errors, metrics
│  └─ db/         Prisma schema, client, migrations, seed
├─ docker/        compose(.prod).yaml, Caddyfile(.prod), builder/{Dockerfile,docker-bake.hcl}
├─ docker-bake.hcl  one build definition for every image (Phase 5)
├─ fixtures/      one minimal repo per framework, used by e2e tests
└─ docs/phases/   these guides
```

## Cross-cutting conventions

- **Errors:** typed classes in `packages/shared/src/errors.ts` carry a message `code` + `params` (from `packages/shared/src/messages.ts`) and an English `userMessage`. The worker stores them on `deployment.errorCode`/`errorParams`, with the English text in `deployment.error`; API errors use the same `{ code, params, message }` shape.
- **i18n:** the dashboard translates every message code and all UI text with react-i18next. English only for now; `EN_MESSAGES` is the English catalog, so adding a locale means adding JSON files in `apps/web/src/i18n/locales/`. Build logs stay English.
- **Status transitions:** one `setStatus()` helper validates allowed transitions and publishes `status:<id>` so the UI updates without polling.
- **Secrets:** AES-256-GCM at rest (`ENCRYPTION_KEY`), decrypted only at the moment of use, never placed in queue payloads or logs.
- **Immutable deployments:** every build writes to its own `deployments/<id>/` prefix; promotion is a pointer flip; GC deletes prefixes that are not active.
- **Testing:** unit tests for detection, slugs, path normalisation and signature verification; fixture-driven e2e over Compose in CI; a post-deploy smoke test in production.
- **Config:** every tunable comes from validated env (`loadEnv()`) with a documented default in `.env.example`.
