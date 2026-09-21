# Shipyard

A deployment platform for static build output. Connect a GitHub repo; Shipyard builds it in
a disposable sandbox, works out what directory the build wrote, and serves it on a wildcard
subdomain.

Framework-agnostic by design — anything whose build emits a directory of static files works:
React, Vue, Svelte/SvelteKit (static adapter), Next.js (`output: 'export'`), Astro, Nuxt,
Vite, CRA, Angular, Gatsby, and plain HTML.

Three ideas carry the design:

- **Content-addressed storage.** Files are stored once by hash; a deployment is a manifest of
  path → hash. Rebuilds upload only what changed, rollback moves zero bytes, and the edge
  cache never needs invalidating.
- **Disposable sandboxes.** Every build runs in a microVM that is created for it and destroyed
  after. Untrusted code never touches a host that holds credentials.
- **Observe, don't predict.** The output directory is discovered by looking at what the build
  actually wrote, not by matching a framework against a table.

**Status:** planning. See [`docs/WORK_PLAN.md`](docs/WORK_PLAN.md) for the architecture, the
reasoning behind each of those choices, the data model, milestones, and risks.
