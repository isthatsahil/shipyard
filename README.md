# Shipyard

A Vercel-inspired deployment platform for static build output. Connect a GitHub repo;
Shipyard clones it, runs `npm run build` in an isolated container, detects the output
directory, and serves the result on a wildcard subdomain.

Framework-agnostic by design — anything whose `npm run build` emits a directory of static
files works: React, Vue, Svelte/SvelteKit (static adapter), Next.js (`output: 'export'`),
Astro, Nuxt, Vite, CRA, Angular, Gatsby, and plain HTML.

**Status:** planning. See [`docs/WORK_PLAN.md`](docs/WORK_PLAN.md) for the architecture,
data model, API surface, milestones, and risk register.
