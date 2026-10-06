# UI Design — Dashboard, Landing, Auth, Errors

**What this is:** the visual and interaction spec for `apps/web` (and the router's 404 page). The phase guides say *what* each screen does; this file says *how it looks* and which shadcn pieces build it.
**Used by:** [Phase 2](phase-2-logs-dashboard.md) (landing, dashboard, errors), [Phase 3](phase-3-auth-github.md) (login, signup, account menu), [Phase 1](phase-1-pipeline.md) follow-up (router 404).
**How to build it:** [UI implementation](ui-implementation.md): app structure, every component's props and states, and notes on the tricky parts.
**Mockup:** [Shipyard Dashboard Mockup](https://claude.ai/artifact/VFZVJQM48XQ4mJUcx46xck) — every screen below is an artboard there, on a **Dark** and a **Light** canvas page. The link is private to the owner until shared.

---

## 1. Principles

- **One look, two surfaces.** The landing page and the app share tokens, type and card style. Landing is louder (glow, dot grid, serif accents); the app uses the same pieces at lower volume.
- **Stock shadcn, custom tokens.** Components use their stock variants (`default`, `outline`, `ghost`, `destructive`, `link`, `secondary`). Only the theme tokens (`:root` and `.dark`) change. If a screen needs a new look, add a token or a small wrapper component, not a one-off class soup.
- **Two themes, one set of classes.** Light and dark are both designed. Components only reference tokens (`bg-card`, `text-muted-foreground`, `border-foreground/6`), never `white/N`, `black/N` or a fixed palette colour, so the same markup works in both. See [§2.1](#21-switching-themes).
- **The terminal is always dark.** Log panes and code snippets keep a dark surface in both themes; their log colours are tuned for it.
- **Monospace means machine data.** Commit SHAs, URLs, hostnames, commands, error codes and log lines are always `font-mono`. Everything a person wrote (commit messages, project names) is `font-sans`.
- **Status is colour + text.** A status is never shown by colour alone: badges carry the word, the step tracker carries a label.

---

## 2. Theme tokens

### Fonts

```bash
pnpm --filter @shipyard/web remove @fontsource-variable/inter
pnpm --filter @shipyard/web add @fontsource-variable/sora @fontsource-variable/jetbrains-mono @fontsource/instrument-serif
```

| Token | Font | Use |
|---|---|---|
| `--font-sans`, `--font-heading` | Sora Variable (400/500/600) | all UI text and headings |
| `--font-mono` | JetBrains Mono Variable (400/500) | SHAs, URLs, logs, section labels, badges |
| `--font-serif` | Instrument Serif, italic 400 | the second line of big headings only (landing, auth, error pages, New project) |

### `apps/web/src/index.css`

Replace the Inter import, the `:root` block and the `.dark` block; add the new entries to `@theme inline`. The `--sidebar-*` and `--chart-*` tokens aren't used by these screens; leave them as they are.

```css
@import "@fontsource-variable/sora";
@import "@fontsource-variable/jetbrains-mono";
@import "@fontsource/instrument-serif/400-italic.css";

@theme inline {
    --font-sans: 'Sora Variable', sans-serif;
    --font-heading: var(--font-sans);
    --font-mono: 'JetBrains Mono Variable', ui-monospace, monospace;
    --font-serif: 'Instrument Serif', Georgia, serif;
    --color-primary-text: var(--primary-text);
    --color-faint: var(--faint);
    --color-terminal: var(--terminal);
    --color-status-queued: var(--status-queued);
    --color-status-queued-foreground: var(--status-queued-foreground);
    --color-status-building: var(--status-building);
    --color-status-building-foreground: var(--status-building-foreground);
    --color-status-ready: var(--status-ready);
    --color-status-ready-foreground: var(--status-ready-foreground);
    --color-status-failed: var(--status-failed);
    --color-status-failed-foreground: var(--status-failed-foreground);
    /* …existing entries unchanged… */
}

:root {
    --background: #fafafa;
    --foreground: #09090b;
    --card: #ffffff;
    --card-foreground: #09090b;
    --popover: #ffffff;
    --popover-foreground: #09090b;
    --primary: #10b981;              /* emerald-500: button fills, "live", focus ring */
    --primary-foreground: #022c22;   /* dark text on the fill; white on #10b981 fails contrast */
    --primary-text: #047857;         /* emerald-700: primary-coloured text and links (5.5:1 on white) */
    --secondary: #f1f1f3;
    --secondary-foreground: #09090b;
    --muted: #f1f1f3;
    --muted-foreground: #52525b;     /* 7:1 on --background */
    --faint: #71717a;                /* timestamps, hints, section labels (4.6:1) */
    --accent: #f1f1f3;
    --accent-foreground: #09090b;
    --destructive: #dc2626;
    --border: oklch(0 0 0 / 8%);
    --input: oklch(0 0 0 / 15%);
    --ring: oklch(0.7 0.15 163 / 50%);
    --radius: 0.625rem;              /* unchanged */

    --terminal: #0b0b0d;             /* log panes stay dark in both themes */
    --status-queued: #71717a;        /* queued, cancelled, archived; the mockup's Tokens board calls it --status-idle */
    --status-queued-foreground: #52525b;
    --status-building: #d97706;
    --status-building-foreground: #b45309;
    --status-ready: #10b981;
    --status-ready-foreground: #047857;
    --status-failed: #dc2626;
    --status-failed-foreground: #b91c1c;
}

.dark {
    --background: #09090b;
    --foreground: #fafafa;
    --card: #0f0f12;
    --card-foreground: #fafafa;
    --popover: #111114;
    --popover-foreground: #fafafa;
    --primary: #34d399;              /* emerald-400 */
    --primary-foreground: #09090b;
    --primary-text: #34d399;         /* bright enough for text on dark; same as --primary */
    --secondary: #1c1c20;
    --secondary-foreground: #fafafa;
    --muted: #18181b;
    --muted-foreground: #9d9da3;     /* 7:1 on --background; don't go dimmer for body text */
    --faint: #7c7c82;
    --accent: #1c1c20;
    --accent-foreground: #fafafa;
    --destructive: #f87171;
    --border: oklch(1 0 0 / 8%);
    --input: oklch(1 0 0 / 12%);
    --ring: oklch(0.77 0.15 163 / 50%);

    --terminal: #0b0b0d;
    --status-queued: #a1a1aa;
    --status-queued-foreground: #a1a1aa;
    --status-building: #fbbf24;
    --status-building-foreground: #fcd34d;
    --status-ready: #34d399;
    --status-ready-foreground: #6ee7b7;
    --status-failed: #f87171;
    --status-failed-foreground: #fca5a5;
}
```

Rules of thumb:

- **Fill vs text.** A colour used as a *fill* (`bg-primary`, `bg-status-ready/10`) uses the base token. A colour used as *text* on the page background uses its text partner: `text-primary-text`, `text-status-ready-foreground`. In dark the pairs are nearly the same; in light the text partner is two shades darker so it stays readable on white.
- **Primary buttons keep dark text** in both themes (`--primary-foreground` is near-black), because white text on emerald fails contrast.

### Layered surfaces

Surfaces are built from `--foreground` at low alpha, so the same class is a white wash in dark and a black wash in light. Tailwind v4's opacity modifier works on the CSS variable directly.

| Use | Class | Dark renders as | Light renders as |
|---|---|---|---|
| Hairline dividers, card inner border | `border-foreground/6` | white 6% | black 6% |
| Card outer border | `border-foreground/7` | white 7% | black 7% |
| Outline button / input border | `border-input` | white 12% | black 15% |
| Outer card fill | `bg-foreground/2` | white 2% | black 2% |
| Chip / secondary badge fill | `bg-foreground/6` | white 6% | black 6% |
| Hover fill on ghost items | `bg-foreground/6` | white 6% | black 6% |
| Secondary text | `text-muted-foreground` | `#9d9da3` | `#52525b` |
| Tertiary text (timestamps, hints) | `text-faint` | `#7c7c82` | `#71717a` |

### 2.1 Switching themes

- **Default: follow the system** (`prefers-color-scheme`). The user can override it with a `ThemeToggle`: a ghost icon button (sun / moon / monitor) in `AppHeader` left of the avatar, and a "Theme" submenu in the account `DropdownMenu` (Phase 3) with System, Light and Dark. The mockup doesn't draw the toggle.
- The choice (`"system" | "light" | "dark"`) is stored in `localStorage` under `theme` and applied as the `dark` (or `light`) class on `<html>`, so the existing `@custom-variant dark (&:is(.dark *))` keeps working. `system` follows OS changes live.
- **No flash on load:** the stored theme is applied by a script in `<head>`, before the page body is first painted.
- **One theme across tabs:** changing it in one tab or window changes it in the others.
- **No animation on switch:** colours change at once; transitions are switched off for that frame.
- **Native UI matches:** `color-scheme` follows the theme, so scrollbars, form controls and autofill match.
- **Pages can force a theme** regardless of the user's choice; none does today.
- All of this is a small provider in `apps/web/src/theme/`, not a library: [UI implementation §4.7](ui-implementation.md#47-theme).

---

## 3. Shared building blocks

Add the shadcn components once:

```bash
pnpm dlx shadcn@latest add button badge card input label field checkbox collapsible alert table tabs \
  separator pagination dropdown-menu avatar select breadcrumb tooltip skeleton sonner
```

Then add these app components in `src/components/`. Each is small; they exist so the pages don't repeat class strings. Props, states and file paths for these and the feature components are in [UI implementation §6](ui-implementation.md#6-component-catalogue).

| Component | What it is | Built from |
|---|---|---|
| `DoubleCard` | The signature card: an outer frame with 6px padding around an inner panel. Used for every card on every page. | `Card` |
| `PageHeader` | Breadcrumb → mono section label (`// PROJECTS`) → `h1` → optional description, with a slot on the right for actions. | `Breadcrumb` |
| `AppHeader` | 64px top bar: logo + wordmark, nav (`Projects`, `Docs`) as ghost buttons, `New project` (`Button size="sm"`), account `Avatar` + `DropdownMenu` (Phase 3). | `Button`, `Avatar`, `DropdownMenu` |
| `StatusBadge` | Deployment status pill with a dot. `building` pulses. | `Badge variant="outline"` |
| `StepTracker` | Six-stage progress: queued → cloning → detecting → building → uploading → ready. | plain elements |
| `LogTerminal` | Log pane with toolbar, line numbers, colour-coded step labels, follow/jump-to-bottom. | `DoubleCard`, `Button` |
| `CopyButton` | Icon button that copies text and swaps to a check for 1.5s. | `Button size="icon-sm" variant="ghost"`, `Tooltip` |
| `ErrorState` | Centered full-page message used by all error screens. | `Button`, `DoubleCard` |
| `GlowBackdrop` | The emerald radial glow (and optional dot grid) behind a page's top section. `aria-hidden`, `pointer-events-none`. | plain elements |

### `DoubleCard`

```tsx
export function DoubleCard({ className, innerClassName, children }: { className?: string; innerClassName?: string; children: React.ReactNode }) {
  return (
    <Card className={cn("rounded-[14px] border-foreground/7 bg-foreground/2 p-1.5 shadow-none", className)}>
      <div className={cn("h-full rounded-[9px] border border-foreground/6 bg-card", innerClassName)}>{children}</div>
    </Card>
  );
}
```

### `StatusBadge`

| Status | Text colour | Fill / border | Extra |
|---|---|---|---|
| `queued` | `text-status-queued-foreground` | `bg-foreground/6 border-foreground/12` | |
| `cloning`, `detecting`, `building`, `uploading` | `text-status-building-foreground` | `bg-status-building/10 border-status-building/30` | dot pulses |
| `ready` | `text-status-ready-foreground` | `bg-status-ready/10 border-status-ready/30` | |
| `failed` | `text-status-failed-foreground` | `bg-status-failed/10 border-status-failed/30` | |
| `cancelled` | `text-status-queued-foreground` | `bg-foreground/6 border-foreground/12` | |
| `archived` (retention deleted the files) | `text-faint` | `bg-foreground/6 border-foreground/12` | |
| **live** (active deployment) | `text-primary-foreground` | `bg-primary border-primary` | solid; shown instead of a Promote button |

Pill: `h-[22px] rounded-full px-2 font-mono text-[11px] font-medium lowercase`, dot `size-1.5 rounded-full bg-current`. The word is translated (`t("status.building")`); the `status.*` keys are capitalised ("Building") because the `StepTracker` labels use them too, so the pill lowercases them with CSS.

### `StepTracker`

Each stage is a 24px circle with a label under it, joined by 2px lines that fill the space between.

| Stage state | Circle | Label | Line to the next stage |
|---|---|---|---|
| done | `bg-primary`, check icon in `--primary-foreground` | `text-muted-foreground` | `bg-primary` |
| current | 2px `border-primary`, `bg-primary/12`, pulsing 8px dot | `font-semibold text-foreground` | gradient `primary → primary/30` |
| failed | `bg-destructive`, X icon in `--background` | `font-semibold text-status-failed-foreground` | gradient `primary → destructive` coming in |
| pending | 1px `border-foreground/14` | `text-faint` | `bg-foreground/12` |
| skipped (after a failure) | 1px **dashed** `border-foreground/14` | `text-faint` | `bg-foreground/12` |
| ready (final, done) | as done, plus `ring-4 ring-primary/20` | `font-semibold` | — |

An `archived` deployment was `ready` before retention deleted its files, so it shows every stage as done. A failed deployment must show *where* it failed. That needs the stage the worker was in when it failed (see [§8](#8-backend-changes-this-design-needs)).

### `LogTerminal`

- **Always dark.** The terminal ignores the theme: inside it, use fixed dark-surface classes (`bg-terminal`, `text-zinc-200`, `border-white/6`), not tokens. In light mode it sits inside a normal light `DoubleCard` frame.
- **Toolbar** (`bg-[#121215]`, bottom border `border-white/6`): `BUILD LOG` mono label, line count and state (`14 lines`, `· archived`, `· finished`); on the right a `Streaming` indicator while live, then `CopyButton` (whole log) and a download icon button.
- **Body**: `bg-terminal`, `font-mono text-[12.5px] leading-[23px]` (both fixed at every width; see [§7.2](#72-where-to-be-fluid-and-where-not)), height `h-log-live` (up to 470px) on the building page and `h-log` (up to 420px) elsewhere; both shrink with the screen height ([§7.3](#73-fluid-tokens)). Each line: right-aligned line number (`w-10 pr-4 text-white/25 select-none`), then the step label padded to 7 chars (`text-zinc-500 select-none`), then the text in the step's colour. `white-space: pre`, horizontal scroll.
- **Step colours**: `clone` sky-400 · `detect` violet-400 · `build` zinc-200 · `output` zinc-400 · `warn` amber-400 · `error` red-400 · `upload`/`promote`/`done` emerald-400.
- **Error line** (failed builds): the line that caused the failure gets `bg-red-400/10`, an inset 2px red left edge and a red line number. "Jump to error" scrolls to it.
- **Follow mode** as in Phase 2: auto-scroll until the user scrolls up, then show a floating `Button variant="outline" size="sm"` "Jump to bottom" in the bottom-right corner.
- While live, the last line ends with a blinking `▌` cursor.

### Page frame

- App pages: `AppHeader`, then `<main className="mx-auto w-full max-w-260 px-gutter pt-page-top pb-16">`. Vertical rhythm between blocks: `gap-5` (20px); between header and first block on list pages: `gap-7` (28px).
- `GlowBackdrop` behind the top 420px of app pages at `primary/10`; red at 7% on the failed deployment page, amber at 7% on the offline page.
- Headings: page `h1` is `text-page font-medium` (28 → 34px), `text-page-detail` on detail pages (26 → 30px); tracking comes with the token ([§7.3](#73-fluid-tokens)). Section label above it: `font-mono text-xs tracking-[0.14em] text-primary` with a `// ` prefix, uppercase.

---

## 4. Routes

| Route | Screen | Phase | Needs login (Phase 3+) |
|---|---|---|---|
| `/` | Landing | 2 | no |
| `/login`, `/signup` | Auth | 3 | no (redirect to `/projects` if already logged in) |
| `/projects` | Project list | 2 | yes |
| `/new` | New project | 2 | yes |
| `/projects/:id` | Project (history, promote, rollback) | 2 | yes |
| `/deployments/:id` | Deployment (building / failed / ready) | 2 | yes |
| `*` | 404 | 2 | no |

This changes Phase 2's route list: the project list moves from `/` to `/projects` so `/` can be the landing page. `AppHeader`'s logo links to `/projects` when logged in and `/` otherwise.

---

## 5. Pages

### 5.1 Landing — `/`

Canvas width 1440, content column 1152 (`mx-auto max-w-6xl px-gutter`). The 144px side margin in the mockup is not a value to implement: it is what's left of 1440 around a 1152 column, and it shrinks on its own as the window narrows. The accent is `--primary`; nothing on the page hard-codes emerald. Mobile behaviour of every section: [§7.5](#75-per-screen-behaviour).

| # | Section | Contents |
|---|---|---|
| 1 | Nav (72px) | Logo · ghost links `Features`, `Architecture`, `Compare`, `Docs` · `GitHub` (outline, sm) · `Open dashboard` (sm, white fill) |
| 2 | Hero | `GlowBackdrop` with dot grid · outline `Badge` "Self-hosted · open source" with pulsing dot · `h1` `text-hero` (40 → 80px) "Paste a repo." + serif line at 1.15em (46 → 92px) "Watch it ship." in primary with a hand-drawn SVG underline · 17px description · `Button size="xl"` (44px, the size [UI implementation §6.1](ui-implementation.md#61-changes-to-shadcn-primitives) adds) "Deploy a repo →" + outline "Star on GitHub" · terminal `DoubleCard` (`w-full max-w-225`, 900px at most) with corner brackets, window chrome, `ready` badge and 8 sample log lines · "Detects" row of `Badge variant="secondary"` per framework |
| 3 | `#features` | Label `// FEATURES` · h2 "Everything between git push and a live URL." + serif "None of the YAML." · grid of 8 `DoubleCard`s, 4 across at full width and fewer as space runs out (`grid-fluid-60`, [§7.4](#74-layout-rules)): icon, title, one-sentence description. Cards for features that aren't built yet carry an outline `Roadmap` badge (push to deploy, build cache, custom domains). |
| 4 | `#architecture` | See below |
| 5 | `#compare` | h2 "Less work than a VPS." + serif "More yours than a PaaS." · three `DoubleCard`s: top half "Versus X" + fair criticism, bottom half on `primary/6` "Shipyard" + our answer |
| 6 | Get started | Centered: label, h2 `text-display` (36 → 72px) "Your next deploy" + serif "is one URL away.", primary `xl` button + outline `xl` "Read the docs", radial glow behind |
| 7 | Footer (112px) | Logo + "a self-hosted deploy platform" · ghost links · © line |

Separators (`<Separator>`, `bg-border`) sit between sections; sections have `py-section` vertical padding (64 → 112px).

#### Architecture section

- Header on the left (label `// ARCHITECTURE`, h2 "From paste to live," + serif "service by service.", one-line description). On the right, a `Tabs` list: `Overview`, `01 Submit`, `02 Queue`, `03 Build`, `04 Serve`. The step number in each trigger is mono and turns primary when selected. Default tab: `03 Build`.
- Below, a `DoubleCard` (560px tall, faint dot grid) holding the diagram in a fixed 1130×540 coordinate box. From `lg` down to `md` the box scrolls horizontally inside the card rather than reflowing. **Below `md` the diagram is not shown**: the tabs list scrolls sideways, and the detail card gains a vertical list of the step's services in order (icon, name, mono subtitle, joined by a short line with the edge label). A third of a diagram you have to pan around teaches less than the same facts as a list.
- Below that, a detail `DoubleCard`: big mono step number, title, description, and the services involved as `Badge variant="secondary"`.

**Nodes** (150×64, `rounded-[10px] border`, icon + name + mono subtitle):

| Node | Subtitle | Position (x, y) | Zone |
|---|---|---|---|
| Developer | you | 20, 50 | — |
| Dashboard | React · shadcn | 255, 50 | Control plane |
| API | Express · SSE | 490, 50 | Control plane |
| Redis | BullMQ · pub/sub | 725, 50 | — |
| Build worker | queue consumer | 960, 50 | Build plane |
| Postgres | Prisma · state | 490, 240 | — |
| MinIO | S3 · build output | 725, 240 | — |
| Builder | Docker sandbox | 960, 240 | Build plane |
| Visitor | any browser | 20, 430 | — |
| Caddy | TLS · *.domain | 255, 430 | Serving path |
| Router | host → deploy | 490, 430 | Serving path |

Zones are dashed rounded rectangles with a mono label cut into the top border: Control plane (240,18 · 415×130), Build plane (945,18 · 180×322), Serving path (240,408 · 415×112).

**Edges** (one SVG layer under the nodes; mono label chip on each):

| Edge | Label | Step |
|---|---|---|
| Developer → Dashboard | paste URL | 01 |
| Dashboard → API | POST /projects | 01 |
| API → Postgres | insert rows | 01 |
| API → Redis | enqueue | 02 |
| Redis → Build worker | BullMQ job | 02 |
| Build worker → Builder | docker run | 03 |
| Build worker → Redis | log lines | 03 |
| Redis → API | pub/sub | 03 |
| API → Dashboard | SSE log stream | 03 |
| Build worker → MinIO | upload dist | 03 |
| Visitor → Caddy | GET site | 04 |
| Caddy → Router | proxy | 04 |
| Router → Postgres | resolve host | 04 |
| Router → MinIO | stream files | 04 |

**Highlighting:** a step lights its nodes and edges. The lit nodes are the step's services plus any node at the end of a lit edge, so step 03 also lights Dashboard (it receives the SSE stream) without listing it as a service: node border and icon turn primary, fill `primary/8`, a 2px primary top edge and a 4px `primary/7` halo; edges turn primary at 1.8px with a moving dash (`stroke-dasharray: 6 6`, 0.8s linear). Everything not in the step drops to 35% opacity. A zone's border and label turn primary when any node inside it is lit. `Overview` shows everything at full opacity, edges at `foreground/28` (`foreground/10` when dimmed), no animation. Unlit nodes are `bg-card` with a `border-foreground/12` border; lit labels and icons use `text-primary-text`. Step copy for the detail card:

| Step | Services | Description |
|---|---|---|
| Overview | Docker Compose, TypeScript, pnpm monorepo | Four services (dashboard, API, worker, router) behind Caddy, with Postgres for state, Redis for the queue and live logs, and MinIO for build output. Pick a step to follow one deploy through them. |
| 01 Submit | Dashboard, API, Postgres | You paste a repo into the dashboard. The API validates it, then writes the project and a queued deployment to Postgres. |
| 02 Queue | API, Redis · BullMQ, Build worker | The API adds a job to a BullMQ queue in Redis. Any free worker picks it up, so adding workers builds more in parallel. |
| 03 Build | Build worker, Docker builder, Redis pub/sub, API · SSE, MinIO | The worker clones the repo and runs install and build in a throwaway Docker container with CPU, memory and time limits. Every log line goes through Redis to the API, which streams it to your browser over SSE. The output lands in MinIO under the deployment's own prefix. |
| 04 Serve | Caddy, Router, Postgres, MinIO | A visitor reaches Caddy, which handles TLS for every subdomain and passes the request to the router. The router looks up which deployment the host points to and streams its files from MinIO. Promoting or rolling back only changes that pointer. |

Keep these facts in sync with the code: if the pipeline changes, this diagram is the first thing a visitor will catch out.

### 5.2 Project list — `/projects`

- `PageHeader`: `// PROJECTS`, "Projects", "48 projects · 1 building now". Right side: search `Input` (`w-full sm:w-65`, so 260px when there's room, full width under the title on a phone; search icon inset) and a `Select` "Sort: Recently updated | Name | Created".
- Grid of project `DoubleCard`s: 2 columns at full width (the page column caps it at 2), 1 when a column would drop below 320px (`grid-fluid-80`, [§7.4](#74-layout-rules)). Each card: name (link to project) + `StatusBadge` of the latest deployment · live hostname in mono · separator · latest commit SHA + message (truncated) · footer with `branch · relative time` and `Visit ↗` (ghost, sm) + `Open` (outline, sm).
- A project with no deployments shows a `queued`-style badge reading "no deployments", a dashed SHA, "Nothing deployed yet", and a `Deploy` button instead of `Visit`.
- **Pagination** (shadcn `Pagination`) under the grid: left "Showing 1–12 of 48 projects"; right Previous · page numbers · Next. Show the first page, the last page, the current page ±1, and `…` for gaps. The current page uses the `outline` look, the others `ghost`; Previous/Next are disabled (not hidden) at the ends. Hide the whole bar when everything fits on one page.
- Page, search and sort live in the URL (`/projects?page=2&q=blog&sort=name`) so reload and back work. Changing search or sort resets to page 1. Page size: 12, the API's default. (The mockup draws 6 cards and "Showing 1–6" only to keep the artboard short.)
- Loading: a grid of `Skeleton` cards the same size. Empty (no projects at all): a single `DoubleCard` with "No projects yet" and the `New project` button. Empty search: "No projects match “blog”" with a `Clear search` ghost button.

### 5.3 New project — `/new`

- Breadcrumb `Projects / New project`, label `// NEW PROJECT`, h1 "Deploy a repository." + serif "We'll handle the rest." Unlike the other two-line headings, the serif part follows on the same line when it fits and wraps under it on a phone.
- Two columns: the form (`DoubleCard`) and a 320px "What happens next" `DoubleCard` with the four steps (Queue, Clone & detect, Build in a sandbox, Go live). The side panel drops below the form under `lg`.
- Form (`Field` + `Label` + `Input`, mono inputs for URL, branch, paths and commands):
  1. GitHub repository URL with a GitHub icon inset; description "Public repositories for now. Private repos come with GitHub sign-in." (Phase 3 replaces this field with the repo picker.)
  2. Branch and Root directory side by side.
  3. **Detection panel** after the URL loses focus: a `primary/5` box with a primary border: check icon, "Detected **Next.js**", `Badge variant="secondary"` for package manager and Node version. Each warning below it is an amber `Alert` with a title and one sentence. While detecting, show a spinner and "Detecting framework…" in the same box.
  4. **Build settings** `Collapsible`, open when detection returned warnings: install command, build command, output directory, subdomain (input group with a `.localhost` / `.yourdomain.app` suffix), and a `Checkbox` "Serve index.html for unknown routes" with a one-line description.
  5. Field errors appear under the field (`aria-invalid`, red border, red description), e.g. `api.slug_taken` under Subdomain. Errors that don't belong to a field go in a destructive `Alert` above the footer.
  6. Footer: `Cancel` (ghost) and `Create & deploy →` (default).

### 5.4 Project — `/projects/:id`

- Breadcrumb `Projects / <name>`.
- Summary `DoubleCard`: h1 name · repo URL (mono link) · branch `Badge` · "Live at `{hostname}`" with a glowing primary dot. Right: `Visit site ↗` (outline) and `Deploy now` (default). Separator, then four stats in mono uppercase labels: Live deployment (`activeDeployment.commitSha`), Framework (`activeDeployment.framework`), Last deploy (newest deployment's `createdAt`), Deployments (`deploymentCount`).
- Deployments `DoubleCard` with a title, one-line description ("Promote any ready build to make it live. Rolling back never rebuilds."), and a `Table`:

| Column | Content |
|---|---|
| Commit | SHA (mono, links to the deployment) + message in muted text |
| Status | `StatusBadge` |
| Created | relative time |
| Duration | `finishedAt − startedAt`, mono; running builds show elapsed time with `…` |
| (actions) | see below, plus a `…` `DropdownMenu` on every row (Delete deployment; disabled on the live row with a tooltip) |

- Row actions: running → `View logs` (ghost); ready and newer than live → `Promote` (outline); ready and older than live → `Roll back` (outline, rollback icon); live → solid `live` badge and an inset 2px primary left edge on the row; failed → `View logs`; cancelled and archived → none (their SHA is plain muted text, not a link).
- Promote/Roll back opens no dialog; it acts immediately and shows a `sonner` toast "marketing-site now serves 9f8e7d6" with an `Undo` action that promotes the previous deployment.
- `Load older deployments` (ghost) at the bottom uses the existing cursor.

### 5.5 Deployment — `/deployments/:id`

Shared layout for all states: breadcrumb `Projects / <project> / <sha>` · h1 is the commit message (fallback: "Deployment `{sha}`") · meta row of `Badge variant="secondary"` chips (SHA, branch, framework) + "Started 1 minute ago · 1m 12s" · `StatusBadge` on the right · `StepTracker` in a `DoubleCard` · state-specific block · `LogTerminal`.

The time in the meta row is "Started …" while building or after a failure, and "Finished …" once ready.

| State | State-specific block | Header action |
|---|---|---|
| Building | none; terminal shows `Streaming` and the blinking cursor | — |
| Failed | destructive `Alert`: "The build command failed" (from `errorCode`/`errorParams` via `formatUserMessage`), one sentence of guidance, the offending log line in a mono box, then `Jump to error` (outline) and `Copy error` (ghost). Terminal highlights that line and shows `Jump to bottom`. Page glow turns red. | `Redeploy` (default) |
| Ready | `DoubleCard` with a primary-tinted border and two rows: **Preview** (deployment-id hostname, `CopyButton`, "Always serves this build, even after newer ones go live.", `Visit ↗`) and **Production** (project hostname; if this deployment isn't live: "Currently serving `{sha}`, an older build." + `Promote to production`; if it is: solid `live` badge). Meta row adds "24 files, 623 KB" from `fileCount`/`sizeBytes`. | — |

`Redeploy` calls `api.deploy(projectId)`, which builds the branch's **current** head, not this commit. Its tooltip says so: "Builds the latest commit on main".

### 5.6 Auth — `/login`, `/signup` (Phase 3)

- Split screen: a 600px brand panel on the left (glow + dot grid, logo top-left, big headline with a serif second line, "Self-hosted · open source" at the bottom) and the form centred in the rest. The brand panel is hidden below `lg`.
- **Login**: label `// LOG IN`, h1 "Welcome back", "Log in with the GitHub account that owns your projects.", a full-width `xl` button with the `inverse` fill "Continue with GitHub" (links to `GET /auth/github`), separator, "New to Shipyard? Create an account". Brand panel shows the headline and a three-line sample log.
- **Signup**: label `// SIGN UP`, h1 "Create your account", "Your GitHub account is your Shipyard account. No password to remember." A `DoubleCard` explains the two scopes (`read:user`: username and avatar; `repo`: clone private repos and add the push webhook) and that access can be revoked in GitHub settings. Button "Sign up with GitHub" (same endpoint), then "Already have an account? Log in". Brand panel shows "Your first deploy is a minute away." and three checkmarked benefits.
- **Sign-in failed**: the login screen with a destructive `Alert` above the button. The API redirects to `/login?error=<code>`; render it with `formatUserMessage`. Copy for `api.oauth_state_invalid`: title "Sign-in didn't finish", body "The sign-in link expired or was opened in another tab. Please try again." The body comes from the message catalogue, so `packages/shared/src/messages.ts` must change from its current "GitHub sign-in expired or was tampered with. Try again." (see [§8](#8-backend-changes-this-design-needs)). Button text becomes "Try again with GitHub". Strip `?error` from the URL after reading it.
- Account menu (in `AppHeader` once logged in): `Avatar` with the GitHub avatar (initials fallback) → `DropdownMenu` with the login name, `GitHub profile ↗`, separator, `Log out` (`POST /auth/logout`, then go to `/`).

### 5.7 Error screens

All use `ErrorState`: the app header, then a centred column (`w-full max-w-150`, 600px at most) with a coloured mono label, a `text-error` heading (34 → 52px) with a serif second line, one or two sentences, and buttons. Wire them through the router's `errorElement` and the API client:

| Screen | Trigger | Label / heading | Body | Actions | Extra |
|---|---|---|---|---|---|
| Not found | unknown route; `ApiError` 404 (`api.not_found`) | `// 404 · NOT FOUND` (primary) · "This page is / off the map." | "The link may be out of date, or the project was deleted or belongs to another account." | `Back to projects`, `Go to home page` (outline) | small terminal card showing the request and `404 api.not_found`; a faint dot grid (`GlowBackdrop dots`, no glow) behind the page instead of the glow |
| Server error | `ApiError` ≥ 500 (`api.internal`) | `// 500 · SERVER ERROR` (red) · "Something broke / on our side." | "The API hit an error it didn't expect. Your live sites keep serving; only the dashboard is affected. Try again in a moment." | `Try again` (refetch), `Back to projects` | `Collapsible` "Error details" (open): code, request, UTC time; a footer row "Keeps happening?" + `Report an issue ↗` (ghost, sm) |
| API unreachable | `fetch` throws (`TypeError: Failed to fetch`) on page load | `// CAN'T CONNECT` (amber) · "Can't reach / the Shipyard API." | "The dashboard loaded, but every request to https://api.localhost is failing." | `Retry now`, `Open api.localhost ↗`, `Setup guide` | numbered checklist: run `docker compose up`; trust Caddy's CA. Header shows "Reconnecting…" while it retries every 5s with backoff. |
| Session expired | 401 `api.unauthenticated` | — | — | — | no screen: redirect to `/login?next=<path>` |

Errors from a mutation (promote, delete, create) are toasts, not full-page errors. A full-page error is only for a failed page load.

### 5.8 Router 404 — any `*.domain` with nothing to serve

Served by `apps/router` for an unknown host, and for a missing path on a deployment that has no `404.html`. It replaces the `NOT_FOUND` string in `apps/router/src/serve.ts`.

- A single self-contained HTML string: inline `<style>`, no scripts, no web fonts (system sans and mono stacks), no external requests. It is served to strangers on other people's domains.
- Centred: a pill with a globe icon and the requested hostname (HTML-escaped), heading "Nothing / docked here." (serif fallback: `Georgia, serif` italic), "This address doesn't point to a live site, or the page isn't part of it. If it's yours, check the project's latest deployment.", an outline link "Deploy your own site →" to the landing page, and a footer "404 · served by shipyard" with the logo.
- Same background and faint dot grid as the app, in both themes: the inline `<style>` defines the light values on `:root` and overrides them in `@media (prefers-color-scheme: dark)`. There is no toggle here; it follows the visitor's system. Status stays 404.

---

## 6. Motion

| Effect | Where | Spec |
|---|---|---|
| Pulse | building badges, current step, "Streaming", live pill dot | opacity 1 → 0.35 → 1, 1.6s ease, infinite |
| Blink | live log cursor | step-end, 1s |
| Flow | lit architecture edges | dash offset −20 over 0.8s linear |
| Lift | primary buttons on hover (landing only) | `translateY(-1px)`, 150ms |
| Highlight change | architecture nodes, edges, labels | all properties 250ms ease |

Wrap every infinite animation in `motion-safe:`. Under `prefers-reduced-motion`, lit edges stay solid and nothing pulses.

---

## 7. Fluid sizing, mobile and accessibility

The mockup is drawn at 1280 (app) and 1440 (landing), but every screen must work from a 320px phone up. This section says which sizes grow with the screen, which stay fixed, and how each screen rearranges when space runs out. How to build it is in [UI implementation §4.9](ui-implementation.md#49-fluid-tokens-and-layout-utilities).

### 7.1 Approach

Four tools, in order of preference. Reach for the next one only when the previous can't do the job.

1. **Intrinsic layout.** Let things size themselves from the space they get: `w-full max-w-*` instead of a fixed width, `flex-wrap`, grids whose column count follows the available width. No rules, no breakpoints; this handles most of the UI.
2. **Fluid values (`clamp()`).** For the few sizes that should *grow* with the screen: display headings, section spacing, page gutters, the log pane height. Each is a token with a minimum, a maximum, and a smooth slope between them ([§7.3](#73-fluid-tokens)).
3. **Container queries.** When a component has to change its *arrangement* (a row becomes a stack, four stats become two by two), it reacts to its own width, not the screen's. The same `DeploymentUrls` card then works in the page and in a narrow side panel.
4. **Viewport breakpoints.** Only for changes to the *page structure*: a nav collapsing into a menu, a panel disappearing. The full list is in [§7.4](#74-layout-rules); nothing else uses `sm:`/`md:`/`lg:`.

**Range.** Fluid tokens reach their minimum at 360px and their maximum at 1440px, then stop: above 1440 the page column is capped and nothing grows. The smallest supported width is 320px (WCAG 1.4.10 Reflow): nothing may scroll the *page* sideways there.

### 7.2 Where to be fluid and where not

**Fluid:**

| What | How | Why |
|---|---|---|
| Display headings: hero, landing section `h2`, CTA, error screens, page `h1` | `clamp()` tokens: `text-hero`, `text-section`, `text-display`, `text-error`, `text-page`, `text-page-detail` | They are 2–6× body size. A fixed 80px hero on a phone fits two words per line and fills the first screen on its own. |
| Serif second line of a heading | `text-[1.15em]` of the first line | It inherits the first line's fluid size, so the 1.15 ratio holds at every width with no extra token. |
| Landing section padding, page gutters, space above the page header | `py-section`, `px-gutter`, `pt-page-top` | 112px of padding on a phone is a sixth of the screen showing nothing. |
| Width of large blocks: hero terminal, error column, auth form, search input | `w-full max-w-*` (a cap, not `clamp()`) | They don't need to grow; they need to stop at the design width and shrink below it. |
| Card grids: projects, features, compare | auto-fill grid (`grid-fluid-*`) | The column count follows the space instead of being set per breakpoint. |
| Log pane height | `clamp()` with `dvh` (`h-log`, `h-log-live`) | 470px is taller than a phone held sideways; the pane must leave room for the page around it. |
| Router 404 heading | the `text-error` `clamp()` written into its inline CSS | Served without Tailwind, but the same rule applies. |

**Fixed (do not make these fluid):**

| What | Why |
|---|---|
| Body and UI text (13–17px), labels, badges, table text | Already at the minimum comfortable reading size; shrinking hurts reading on phones, growing wastes space on desktop. Users scale it with browser zoom and their font-size setting, which works because sizes are in `rem`. |
| Log and code text (12.5px, 23px line height), line numbers | Monospace columns must line up, and the virtualised log ([UI implementation §7.1](ui-implementation.md#71-log-streaming-and-follow-mode)) relies on every row being exactly 23px. Long lines scroll inside the pane instead. |
| Control sizes: button and input heights, `StatusBadge` (22/24px), icon buttons, `StepTracker` circles (24px), `AppHeader` (64px) | Controls must stay predictable to align and hit. Touch gets bigger targets through the input type (`pointer-coarse:`, [§7.6](#76-touch)), not through the screen width. |
| Borders, radii, `DoubleCard`'s 6px frame, hairlines | A 1px line scaled to 1.3px renders blurry; the card style is part of the identity. |
| Architecture diagram coordinates (1130×540) | Scaling it down shrinks its 11px labels below readable size. Below `md` it is replaced by a list instead ([§5.1](#architecture-section)). |

Rule of thumb: **fluid for the sizes that set the page's proportions, fixed for the sizes a person reads or touches.**

### 7.3 Fluid tokens

**How a `clamp()` value is worked out.** Choose a minimum size at 360px and a maximum at 1440px; the size moves in a straight line between them:

```text
slope     = (max − min) / (1440 − 360)          px of size per px of viewport
intercept = min − slope × 360                   size at a 0px viewport (can be negative)
value     = clamp(min, intercept + slope×100 vw, max)    with px ÷ 16 → rem
```

Worked example, `text-hero` from 40px to 80px: slope = 40 / 1080 = 0.03704 → `3.704vw`; intercept = 40 − 0.03704 × 360 = 26.67px → `1.667rem`. Result: `clamp(2.5rem, 1.667rem + 3.704vw, 5rem)`, which is 40px at 360, about 56px at 768 and 80px at 1440.

| Token | Utility | Min @ 360 | Max @ 1440 | Value | Used by |
|---|---|---|---|---|---|
| `--text-hero` | `text-hero` | 40px | 80px | `clamp(2.5rem, 1.667rem + 3.704vw, 5rem)` | Landing hero `h1` |
| `--text-display` | `text-display` | 36px | 72px | `clamp(2.25rem, 1.5rem + 3.333vw, 4.5rem)` | Landing CTA `h2` |
| `--text-section` | `text-section` | 30px | 44px | `clamp(1.875rem, 1.583rem + 1.296vw, 2.75rem)` | Landing section `h2` (the mockup's `h2` is 44px at 1440, 30px on the phone board) |
| `--text-error` | `text-error` | 34px | 52px | `clamp(2.125rem, 1.75rem + 1.667vw, 3.25rem)` | Error screens, router 404 |
| `--text-page` | `text-page` | 28px | 34px | `clamp(1.75rem, 1.625rem + 0.556vw, 2.125rem)` | List page `h1` |
| `--text-page-detail` | `text-page-detail` | 26px | 30px | `clamp(1.625rem, 1.542rem + 0.37vw, 1.875rem)` | Detail page `h1` |
| `--spacing-section` | `py-section` | 64px | 112px | `clamp(4rem, 3rem + 4.444vw, 7rem)` | Landing sections |
| `--spacing-gutter` | `px-gutter` | 16px | 32px | `clamp(1rem, 0.667rem + 1.481vw, 2rem)` | Page side padding (app and landing) |
| `--spacing-page-top` | `pt-page-top` | 24px | 40px | `clamp(1.5rem, 1.167rem + 1.481vw, 2.5rem)` | Space above `PageHeader` |
| `--spacing-log-live` | `h-log-live` | 240px | 470px | `clamp(15rem, 60dvh, 29.375rem)` | Log pane, building page |
| `--spacing-log` | `h-log` | 240px | 420px | `clamp(15rem, 55dvh, 26.25rem)` | Log pane, everywhere else |

The display tokens carry their own line height (1.05) and tracking (−0.03em), so a heading needs one class.

**Rules for writing new tokens:**

- **Always `rem` + `vw`, never `vw` alone.** A `vw`-only size ignores browser zoom and the user's font-size setting, which fails WCAG 1.4.4 (text resizable to 200%). The `rem` part keeps responding to both.
- **Keep max ÷ min ≤ 2.5.** Zooming in narrows the viewport in CSS pixels, so a fluid size *shrinks* toward its minimum as the user zooms. With a ratio of 2.5 or less, 200% zoom still makes the text larger overall.
- **Use `dvh`, not `vh`, for heights.** On phones `100vh` includes the area behind the browser's address bar, so a `vh`-sized pane is cut off; `dvh` follows the visible area.

### 7.4 Layout rules

1. **Cap widths, don't set them.** Anything wider than about 240px is `w-full max-w-*`: hero terminal `max-w-225` (900px), error column `max-w-150` (600px), auth form `max-w-100` (400px), New project side panel `lg:w-80` (320px, only beside the form), search input `w-full sm:w-65` (260px).
2. **Auto-fill grids for lists of cards.** `grid-fluid-<n>` makes as many columns as fit with each at least `n` spacing units wide (n × 4px), then stretches them to fill the row:

   | Grid | Utility | Minimum column | Result |
   |---|---|---|---|
   | Project list | `grid-fluid-80` | 320px | 2 columns on desktop (the page column fits no more), 1 on phones |
   | Landing features | `grid-fluid-60` | 240px | 4 across at 1440, 3 at ~1024, 2 on tablets, 1 on phones |
   | Landing compare | `grid-fluid-72` | 288px | 3 across on desktop, 1 on phones |
   | Framework badges, chips, meta rows, button groups | `flex flex-wrap gap-*` | — | wrap onto the next line |

3. **Container queries for components that rearrange.** Mark the component's root `@container` and switch its layout on its own width:

   | Component | Narrow | Wide |
   |---|---|---|
   | `ProjectSummary` stats | 2 × 2 | 4 across from `@xl` (576px) |
   | `DeploymentsTable` | stacked rows ([§7.5](#75-per-screen-behaviour)) | table from `@2xl` (672px) |
   | `DeploymentUrls` rows | label, hostname, hint and action stacked | one row from `@xl` |
   | `ProjectCard` footer | branch/time above the buttons | one row from `@sm` (384px) |
   | `BuildSettings` fields | one column | two columns from `@lg` (512px) |
   | New project: Branch + Root directory | stacked | side by side from `@sm` |
   | `ProjectPagination` | Previous · "Page 2 of 4" · Next | numbered links from `@md` (448px) |

4. **Viewport breakpoints: the complete list.** Only these change with the screen width, because they change the page's structure:
   - **`md`**: `AppHeader` nav ↔ menu button; `MarketingNav` links ↔ menu button; architecture diagram ↔ step list; `StepTracker` labels for every stage ↔ for the current/failed stage only.
   - **`lg`**: New project side panel beside ↔ below the form; auth brand panel shown ↔ hidden.
   - **`sm`**: the search input's fixed width.
5. **Text that can't wrap gets truncated, never squeezed.** Hostnames, SHAs, URLs and commands are `truncate` inside a `min-w-0` flex/grid child, with the full value in a `title` and in the `CopyButton`. Commit messages used as headings wrap (`break-words`). A flex child without `min-w-0` refuses to shrink below its content and pushes the page wider.
6. **Only these scroll sideways, inside themselves:** the log pane, the hero terminal's lines, the architecture tab list (and the diagram between `md` and `lg`). The page itself never scrolls horizontally.

### 7.5 Per-screen behaviour

What changes on a phone (about 390px wide). Anything not listed keeps its desktop arrangement in a single column.

| Screen | Element | Phone behaviour |
|---|---|---|
| Landing | `MarketingNav` | Logo, `Open dashboard`, and a menu icon button opening a `DropdownMenu` with Features, Architecture, Compare, Docs, GitHub. |
| | Hero heading | `text-hero` (40px at 360). Line 2 is an `inline-block whitespace-nowrap` span, so the SVG underline always spans exactly one line; check that "Watch it ship." fits at 320. |
| | Hero buttons | `flex flex-wrap`, each `grow basis-48`: side by side when both fit at 192px+, otherwise stacked full width. No breakpoint. |
| | Hero terminal | Full width; log lines scroll horizontally inside; corner brackets stay at the corners. |
| | Architecture | Tabs list scrolls sideways; the diagram is replaced by the step's service list ([§5.1](#architecture-section)). |
| | Footer | `flex-wrap`; the © line goes last. |
| Project list | Header | Title and count, then search (full width) and sort below it. |
| | Pagination | "Showing 1–12 of 48" above; Previous · "Page 2 of 4" · Next. |
| New project | Layout | Form first, "What happens next" below it; Branch and Root directory stacked; build settings one column. |
| | Footer | `Create & deploy →` full width, `Cancel` under it. |
| Project | Summary | Actions under the name (both buttons share the row); stats 2 × 2. |
| | Deployments | Each row a block: line 1 SHA + `StatusBadge` + `…` menu; line 2 commit message (truncated); line 3 relative time · duration, then the row action. The live row keeps its 2px primary left edge. |
| Deployment | Header | Commit message `h1` wraps; `StatusBadge` moves under it; meta chips wrap. |
| | `StepTracker` | Six circles still in one row (24px each fits at 320); only the current/failed label shows. |
| | Failed alert | The offending line scrolls horizontally in its box; `Jump to error` and `Copy error` wrap. |
| | URLs card | Each row stacks: label + copy button, hostname (truncated), hint, action button full width. |
| | Log pane | `h-log` / `h-log-live`; same font size as desktop. |
| Auth | Layout | Brand panel hidden; form full width inside the gutter. |
| Errors | `ErrorState` | Heading `text-error`; buttons wrap; the details panel's mono values use `break-all`. |
| Router 404 | Page | Heading via `clamp()`; the hostname pill truncates at `max-width: 100%`. |

### 7.6 Touch

- **Detect touch by input, not by width.** Use Tailwind's `pointer-coarse:` variant (`@media (pointer: coarse)`). A phone held sideways is wide but still touch; an iPad with a trackpad is fine with desktop targets.
- **44px targets.** Icon-only buttons (`CopyButton`, download, row `…` menu, `ThemeToggle`, pagination links) are about 28px. On touch give them `pointer-coarse:size-11`, or keep the visual size and enlarge the hit area with `relative after:absolute after:-inset-2`.
- **Nothing only in a tooltip.** Tooltips don't open on touch. The `Redeploy` note ("Builds the latest commit on main") also appears as muted text under the header actions on `pointer-coarse`. The disabled Delete item carries its reason as a second line in the menu, which works for everyone.
- **No hover-only controls.** Row actions are always visible, never revealed on hover.
- **16px inputs on touch.** iOS Safari zooms the whole page when an input under 16px gets focus. The 13px mono inputs add `pointer-coarse:text-base`.

### 7.7 Accessibility

- Every icon-only button has an `aria-label` (Copy log, Download log, More actions, Account menu).
- Tabs, collapsibles and the pagination use the shadcn/Base UI primitives, which handle roles and keyboard support. Don't rebuild them from divs.
- Step labels in the log use `zinc-500`, not `zinc-600`, to stay readable on `--terminal`.
- Minimum body text is 13px; minimum mono labels 11px at ≥ 50% white.
- At 320px wide and at 200% zoom on a 1280px window (the same thing in CSS pixels), every screen works without sideways page scrolling and no text is cut off.

---

## 8. Backend changes this design needs

| Change | Where | Why |
|---|---|---|
| ✅ Done. Paginate `GET /projects`: `?page&pageSize&q&sort` → `{ items, total, page, pageSize }`; each item includes the latest deployment's status, SHA, message and time | `apps/api/src/routes/projects.ts` | Numbered pagination, search and sort across all pages |
| Record the stage a deployment failed in (`failedStage DeploymentStatus?`, set by `setStatus` when moving to `failed`) | Prisma schema, worker `lib/status.ts` | The step tracker's red stage |
| ✅ Done. Return `project.deploymentCount` and `activeDeployment.commitSha` from `GET /projects/:id` | API | Project summary stats |
| ✅ Done. Add `framework: true` to `ACTIVE_DEPLOYMENT` | `apps/api/src/utils/consts.ts` | The project summary's Framework stat; today the live deployment comes back without it |
| ✅ Done. Allow deleting `archived` deployments (`DELETE /deployments/:id` checks `TERMINAL`) | `apps/api/src/routes/deployment.ts` | It answered `409 api.deployment_in_progress` for a build that finished long ago |
| Change `api.oauth_state_invalid` to "The sign-in link expired or was opened in another tab. Please try again." (Phase 3) | `packages/shared/src/messages.ts` | Sign-in failed screen copy |
| OAuth callback redirects to `${WEB_URL}/projects` on success and `${WEB_URL}/login?error=<code>` on failure | `apps/api/src/routes/auth.ts` (Phase 3) | Auth screens |
| Replace the router's `NOT_FOUND` string with the page in §5.8, with the host injected | `apps/router/src/serve.ts` | Router 404 |
| Optional: add a request id header to API responses | API middleware | Shown in the 500 details for bug reports |

---

## 9. Build order

1. Tokens and fonts (§2) and the fluid tokens (§7.3), then `DoubleCard`, `StatusBadge`, `AppHeader`, `PageHeader`.
2. Deployment page (building → failed → ready) with `StepTracker` and `LogTerminal`, because it proves the log stream from Phase 2 Step 1.
3. Project page, then New project, then Project list with pagination.
4. Error screens and the API client's error routing.
5. Landing page, then the architecture section.
6. Phase 3: auth screens and the account menu. Phase 1 follow-up: router 404.

## Checklist

- [ ] `:root` and `.dark` tokens and fonts applied; no hard-coded emerald, `white/N` or `black/N` outside `index.css` and the terminal
- [ ] Theme follows the system by default, the toggle overrides it, and a reload shows no flash of the wrong theme
- [ ] Every screen checked in both themes; the log terminal stays dark in light mode
- [ ] Every card is a `DoubleCard`; every status is a `StatusBadge`
- [ ] Failed deployment shows the failing stage in red and the offending log line highlighted
- [ ] Project list paginates with page/search/sort in the URL; bar hidden on a single page
- [ ] Architecture tabs light the right nodes and edges for each step; reduced motion disables the flow
- [ ] 404, 500 and "API unreachable" screens reachable by forcing each failure
- [ ] Router 404 renders with no network requests
- [ ] Login error from `?error=` shows once and is removed from the URL
- [ ] No page scrolls sideways at 320, 390, 768, 1024, 1280 and 1440px wide, nor at 200% zoom
- [ ] Display headings, section padding and gutters use the fluid tokens; no font size above 20px is a fixed px value
- [ ] Viewport breakpoints appear only where §7.4 lists them; components rearrange with container queries
- [ ] On a touch device: focusing an input doesn't zoom the page, icon buttons have a 44px hit area, nothing is explained only by a tooltip
