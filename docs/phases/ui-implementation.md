# UI Implementation — Architecture and Components

**What this is:** how to build the mockup in `apps/web`: the app's structure, every component with its props and states, and the approach for the tricky parts (log streaming, the step tracker, pagination, the architecture diagram, themes).
**Read with:** [UI design](ui-design.md) for how things look (tokens, colours, sizes, copy). This file says how to put them together; where the two overlap, `ui-design.md` wins on appearance and this file wins on structure.
**Mockup:** [Shipyard Dashboard Mockup](https://claude.ai/artifact/VFZVJQM48XQ4mJUcx46xck), **Dark** and **Light** pages. Private to the owner until shared.
**Phases:** the dashboard, landing and error screens are [Phase 2](phase-2-logs-dashboard.md); auth screens and the account menu are [Phase 3](phase-3-auth-github.md); the router 404 is a [Phase 1](phase-1-pipeline.md) follow-up.

---

## 1. Mockup → code map

Every artboard in the mockup and what builds it. Light boards are the same screens with the `light` theme.

| Artboard | Route | Page component | Main components |
|---|---|---|---|
| Landing page | `/` | `features/landing/LandingPage` | `MarketingNav`, `Hero`, `TerminalPreview`, `FeatureCard`, `ArchitectureSection`, `CompareCard`, `CtaSection`, `MarketingFooter` |
| Project list | `/projects` | `features/projects/ProjectListPage` | `PageHeader`, `ProjectSearch`, `SortSelect`, `ProjectCard`, `ProjectPagination`, `EmptyState` |
| New project | `/new` | `features/projects/NewProjectPage` | `PageHeader`, `RepoUrlField`, `DetectionPanel`, `BuildSettings`, `NextStepsCard` |
| Project | `/projects/:id` | `features/projects/ProjectPage` | `ProjectSummary`, `DeploymentsTable`, `DeploymentRowActions` |
| Deployment — building / failed / ready | `/deployments/:id` | `features/deployments/DeploymentPage` | `DeploymentHeader`, `StepTracker`, `BuildFailedAlert`, `DeploymentUrls`, `LogTerminal` |
| Log in / Sign up / Sign-in failed | `/login`, `/signup` | `features/auth/LoginPage`, `SignupPage` | `AuthLayout`, `GitHubButton`, `ScopeList`, `Alert` |
| 404 / 500 / API unreachable | `*`, `errorElement` | `features/errors/*` | `ErrorState` |
| Router 404 | any `*.domain` | `apps/router/src/notFoundPage.ts` | plain HTML string |
| Theme tokens | — | `src/index.css` | tokens only |

---

## 2. Stack and dependencies

Already in `apps/web`: React 19, Vite, Tailwind v4, shadcn (`base-vega` style, built on **Base UI**, not Radix), Hugeicons, react-i18next with `formatUserMessage`.

Add:

```bash
pnpm --filter @shipyard/web add react-router @tanstack/react-query
pnpm --filter @shipyard/web add @fontsource-variable/sora @fontsource-variable/jetbrains-mono @fontsource/instrument-serif
pnpm --filter @shipyard/web remove @fontsource-variable/inter
pnpm --filter @shipyard/web add -D @testing-library/react @testing-library/user-event jsdom
pnpm dlx shadcn@latest add badge card input label field checkbox collapsible alert table tabs \
  separator pagination dropdown-menu avatar select breadcrumb tooltip skeleton sonner
```

- **Routing:** `react-router` v7 (the `react-router-dom` name in Phase 2 is the same library; v7 ships everything from `react-router`).
- **Dates and sizes:** use `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat` and `Intl.NumberFormat` with `i18n.language` (the i18n convention), so `date-fns` from the Phase 2 list isn't needed.
- **Base UI, not Radix.** shadcn's `base-vega` components have no `asChild`. To render a link that looks like a button, either pass Base UI's `render` prop (`<Button render={<Link to="/new" />}>New project</Button>`) or put the classes on the link (`<Link className={buttonVariants({ variant: "outline" })}>`). The same `render` prop replaces `asChild` on `DropdownMenu.Trigger`, `Tooltip.Trigger`, `Collapsible.Trigger` and `Breadcrumb` links.
- **Icons:** Hugeicons (`<HugeiconsIcon icon={Search01Icon} size={16} />`). Icon names below are suggestions; confirm them at hugeicons.com.

---

## 3. Folder structure

```
apps/web/src/
├─ main.tsx                  providers + <RouterProvider>
├─ index.css                 tokens (ui-design §2), @utility helpers, keyframes
├─ app/
│  ├─ router.tsx             route tree, lazy routes, errorElement
│  ├─ providers.tsx          QueryClient, ThemeProvider, TooltipProvider, Toaster
│  └─ layouts/               MarketingLayout, AppLayout, AuthLayout
├─ api/
│  ├─ client.ts              req(), ApiError, NetworkError
│  ├─ types.ts               Project, Deployment, DetectResult, Page<T>
│  └─ queries.ts             query keys + useQuery/useMutation hooks
├─ components/
│  ├─ ui/                    shadcn-generated (owned code; small edits allowed, see §6.1)
│  ├─ brand/Logo.tsx
│  ├─ DoubleCard.tsx  PageHeader.tsx  SectionLabel.tsx  DisplayHeading.tsx
│  ├─ StatusBadge.tsx  StepTracker.tsx  CopyButton.tsx  GlowBackdrop.tsx
│  ├─ log/LogTerminal.tsx  log/LogLine.tsx
│  ├─ AppHeader.tsx  ThemeToggle.tsx  AccountMenu.tsx
│  └─ ErrorState.tsx  EmptyState.tsx
├─ features/
│  ├─ landing/               LandingPage + sections, architecture.data.ts
│  ├─ projects/              list, new, project page + their pieces
│  ├─ deployments/           DeploymentPage + pieces
│  ├─ auth/                  LoginPage, SignupPage, GitHubButton, ScopeList
│  └─ errors/                NotFoundPage, RouteError
├─ hooks/                    useLogStream, useAutoScroll, useTheme, useNow, useCopy
├─ lib/                      format.ts, logs.ts, stages.ts, pagination.ts, utils.ts
└─ i18n/                     existing
```

Rules: `components/` holds anything used by two or more features; everything else lives in its feature folder. Pages compose; they don't style. A page file should read as a list of components and hooks.

---

## 4. App shell

### 4.1 Providers — `app/providers.tsx`

```tsx
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
      // Page-load failures go to the route's error screen; see §4.4.
      throwOnError: (err) => err instanceof NetworkError || (err instanceof ApiError && (err.status >= 500 || err.status === 404)),
    },
  },
  mutationCache: new MutationCache({ onError: (err) => toastError(err) }),   // mutations never take over the page
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delay={300}>
          {children}
          <ThemedToaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
```

`toastError` renders `formatUserMessage(i18n, err, err.message)` in a destructive `sonner` toast.

### 4.2 Routes — `app/router.tsx`

```tsx
export const router = createBrowserRouter([
  { element: <MarketingLayout />, errorElement: <RouteError />, children: [
    { index: true, lazy: () => import("@/features/landing/LandingPage") },
  ]},
  { element: <AuthLayout />, children: [                                     // Phase 3
    { path: "login", lazy: () => import("@/features/auth/LoginPage") },
    { path: "signup", lazy: () => import("@/features/auth/SignupPage") },
  ]},
  { element: <AppLayout />, errorElement: <RouteError />, children: [
    { path: "projects", lazy: () => import("@/features/projects/ProjectListPage") },
    { path: "new", lazy: () => import("@/features/projects/NewProjectPage") },
    { path: "projects/:id", lazy: () => import("@/features/projects/ProjectPage") },
    { path: "deployments/:id", lazy: () => import("@/features/deployments/DeploymentPage") },
    { path: "*", lazy: () => import("@/features/errors/NotFoundPage") },
  ]},
]);
```

Each lazy module exports `Component` (React Router's lazy convention). The landing page and the dashboard end up in separate chunks, so visitors to `/` don't download the log terminal.

### 4.3 Layouts

| Layout | Renders | Notes |
|---|---|---|
| `MarketingLayout` | `<Outlet />` only | Landing draws its own nav and footer. |
| `AppLayout` | `AppHeader`, `GlowBackdrop` (variant from route `handle`), `<main className="mx-auto w-full max-w-260 px-4 pt-10 pb-16"><Outlet/></main>` | Phase 3: a loader calls `GET /auth/me`; on 401 redirect to `/login?next=…`. The failed-deployment and offline screens set the glow variant through `useMatches()` `handle`. |
| `AuthLayout` | two-column grid: `AuthBrandPanel` (`hidden lg:flex`, 600px) + centred `<Outlet />` (max 400px) | Loader redirects to `/projects` if already logged in. |

### 4.4 Error routing — `features/errors/RouteError.tsx`

`useRouteError()` gets whatever a loader or a `throwOnError` query threw. Map it to a screen:

| Error | Screen |
|---|---|
| `NetworkError` | `ErrorState variant="offline"`: retries every 5s with backoff (1, 2, 5, 10, 30s), calling `queryClient.refetchQueries({ type: "active" })` |
| `ApiError` 404, or a route with no match | `ErrorState variant="not-found"` |
| `ApiError` 401 | `<Navigate to={`/login?next=${path}`} />` (Phase 3) |
| `ApiError` ≥ 500, or anything else | `ErrorState variant="server"` with code, request and time |

Keep a small `lastRequest` record in `api/client.ts` (method, path, time of the failed call) so the 500 details panel has something to show.

### 4.5 API client additions — `api/client.ts`

Start from the Phase 2 `req()` and `ApiError`, and add:

```ts
/** The request never got a response: API down, DNS, or an untrusted certificate. */
export class NetworkError extends Error {}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(BASE + path, { credentials: "include", headers: { "content-type": "application/json" }, ...init });
  } catch (cause) {
    throw new NetworkError("network", { cause });           // TypeError: Failed to fetch
  }
  // …unchanged: 204, JSON, ApiError…
}
```

Add `api.projects({ page, pageSize, q, sort })` returning `Page<Project> = { items, total, page, pageSize }` (see [ui-design §8](ui-design.md#8-backend-changes-this-design-needs)).

### 4.6 Query hooks — `api/queries.ts`

```ts
export const qk = {
  projects: (p: ProjectListParams) => ["projects", p] as const,
  project: (id: string) => ["project", id] as const,
  deployments: (projectId: string) => ["deployments", projectId] as const,
  deployment: (id: string) => ["deployment", id] as const,
};
```

| Hook | Kind | Behaviour |
|---|---|---|
| `useProjects(params)` | `useQuery` | `placeholderData: keepPreviousData` so paging doesn't flash skeletons; `refetchInterval: 10_000` while any project is building |
| `useProject(id)` | `useQuery` | |
| `useDeployments(projectId)` | `useInfiniteQuery` | cursor from Phase 2 (`next`); `refetchInterval: 5000` while the first page has a running row |
| `useDeployment(id)` | `useQuery` | `refetchInterval` stops at a terminal status; the SSE `status` event also calls `setQueryData` so the badge flips instantly |
| `useDetect()` | `useMutation` | fired on URL blur; debounced; its errors show inline, not as a toast (`meta: { silent: true }`) |
| `useCreateProject()` | `useMutation` | on success navigate to the new deployment; field errors (`api.slug_taken`, `api.validation_failed`) map to form fields |
| `useDeploy(projectId)` | `useMutation` | invalidates `deployments` and navigates to the new deployment |
| `usePromote(projectId)` | `useMutation` | optimistic: sets `project.activeDeploymentId` in `onMutate`, restores it in `onError`; the success toast has **Undo**, which promotes the previous id |
| `useDeleteDeployment()` | `useMutation` | removes the row from the cached pages, then invalidates |

### 4.7 Theme — `hooks/useTheme.tsx`

```tsx
type Theme = "system" | "light" | "dark";
const query = "(prefers-color-scheme: dark)";

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => readStored() ?? "system");
  const systemDark = useSyncExternalStore(
    (cb) => { const m = matchMedia(query); m.addEventListener("change", cb); return () => m.removeEventListener("change", cb); },
    () => matchMedia(query).matches,
  );
  const resolved = theme === "system" ? (systemDark ? "dark" : "light") : theme;

  useLayoutEffect(() => { document.documentElement.classList.toggle("dark", resolved === "dark"); }, [resolved]);
  const set = (t: Theme) => { setTheme(t); try { localStorage.setItem("theme", t); } catch {} };

  return <ThemeContext.Provider value={{ theme, resolved, setTheme: set }}>{children}</ThemeContext.Provider>;
}
```

And in `apps/web/index.html`, before the module script, so the first paint is already right:

```html
<script>
  try {
    var t = localStorage.getItem("theme");
    var dark = t === "dark" || (t !== "light" && matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) {}
</script>
```

### 4.8 `index.css` helpers

Beyond the tokens in [ui-design §2](ui-design.md#2-theme-tokens):

```css
:root { color-scheme: light; }
.dark { color-scheme: dark; }

@theme {
    --animate-pulse-soft: pulse-soft 1.6s ease infinite;
    --animate-blink: blink 1s step-end infinite;
    --animate-flow: flow 0.8s linear infinite;
    @keyframes pulse-soft { 50% { opacity: 0.35; } }
    @keyframes blink { 50% { opacity: 0; } }
    @keyframes flow { to { stroke-dashoffset: -20; } }
}

@utility dot-grid {
    background-image: radial-gradient(color-mix(in oklab, var(--foreground) 8%, transparent) 1px, transparent 1px);
    background-size: 16px 16px;
}
@utility font-serif-accent {
    font-family: var(--font-serif);
    font-style: italic;
    font-weight: 400;
}
```

Use them as `motion-safe:animate-pulse-soft`, `dot-grid [mask-image:radial-gradient(...)]`, `font-serif-accent`.

---

## 5. Shared logic — `lib/`

### 5.1 Stages — `lib/stages.ts`

```ts
export const STAGES = ["queued", "cloning", "detecting", "building", "uploading", "ready"] as const;
export type Stage = (typeof STAGES)[number];
export type StageState = "done" | "current" | "failed" | "pending" | "skipped" | "final";

export function stageStates(status: DeploymentStatus, failedStage?: Stage | null): StageState[] {
  if (status === "ready") return STAGES.map((_, i) => (i === STAGES.length - 1 ? "final" : "done"));
  if (status === "failed" || status === "cancelled") {
    const at = STAGES.indexOf(failedStage ?? "queued");
    return STAGES.map((_, i) => (i < at ? "done" : i === at ? "failed" : "skipped"));
  }
  const at = STAGES.indexOf(status as Stage);
  return STAGES.map((_, i) => (i < at ? "done" : i === at ? "current" : "pending"));
}

export const isTerminal = (s: DeploymentStatus) => s === "ready" || s === "failed" || s === "cancelled";
export const isRunning = (s: DeploymentStatus) => !isTerminal(s) && s !== "queued";
```

`failedStage` needs the schema change in [ui-design §8](ui-design.md#8-backend-changes-this-design-needs). Until it exists, pass `"building"`; that is where almost every failure happens.

### 5.2 Log lines — `lib/logs.ts`

```ts
export interface LogLine { step: string; text: string }
const LINE = /^\[(\w+)\] (.*)$/;
export const parseLine = (raw: string): LogLine => {
  const m = LINE.exec(raw);
  return m ? { step: m[1]!, text: m[2]! } : { step: "build", text: raw };
};

/** Index of the line that most likely caused the failure, or -1. */
export function findErrorLine(lines: LogLine[]): number {
  const last = lines.findLastIndex((l) => l.step === "error");
  const end = last === -1 ? lines.length : last;
  for (let i = end - 1; i >= 0; i--) if (/\berror\b/i.test(lines[i]!.text)) return i;
  return last;
}
```

The heuristic finds the last line mentioning "error" before the worker's `[error]` line. If it misfires often, have the worker record the index when it fails instead.

### 5.3 Formatting — `lib/format.ts`

- `relativeTime(date, lng, now)`: `Intl.RelativeTimeFormat(lng, { numeric: "auto" })` with the largest fitting unit ("1 minute ago", "yesterday").
- `duration(ms, lng)`: `Intl.NumberFormat(lng, { style: "unit", unit: "second" })` below a minute, then `1m 12s` (compact, mono).
- `bytes(n, lng)`: `Intl.NumberFormat(lng, { style: "unit", unit: "kilobyte" | "megabyte", maximumFractionDigits: 0 })`.
- `useNow(intervalMs = 30_000)` re-renders relative times; running durations use `useNow(1000)`.

### 5.4 Pagination range — `lib/pagination.ts`

```ts
/** [1, 2, "…", 8] — first, last, current ±1, with gaps collapsed. */
export function paginationRange(page: number, pageCount: number): (number | "…")[] {
  const pages = [...new Set([1, page - 1, page, page + 1, pageCount])].filter((p) => p >= 1 && p <= pageCount).sort((a, b) => a - b);
  return pages.flatMap((p, i) => (i > 0 && p - pages[i - 1]! > 1 ? ["…" as const, p] : [p]));
}
```

---

## 6. Component catalogue

Every component lists its file, what it's built from, its props, its states and anything non-obvious. Visual values (colours, sizes) are in [ui-design.md](ui-design.md); don't repeat them in code comments.

### 6.1 Changes to shadcn primitives

These are small edits to the generated files in `components/ui/`. shadcn code is owned code; keep the edits minimal so regenerating is easy to diff.

| Primitive | Change | Why |
|---|---|---|
| `button.tsx` | Add variant `inverse: "bg-foreground text-background hover:bg-foreground/90"`. Add size `xl: "h-11 gap-2 rounded-[10px] px-5 text-[15px]"`. Add `shadow-[inset_0_1px_rgb(255_255_255/0.3)]` to `default`. | GitHub and "Open dashboard" buttons; landing and auth CTAs; the mockup's top highlight on primary buttons |
| `alert.tsx` | Add variant `warning`: `border-status-building/30 bg-status-building/6 [&>svg]:text-status-building` with the title in `text-status-building-foreground`. Tune `destructive` to the same shape with `status-failed`. | Detection warnings, sign-in failed, build failed |
| `card.tsx` | none; `DoubleCard` wraps it | |
| `badge.tsx` | none; `StatusBadge` and chips pass classes | |
| `input.tsx` | none; mono inputs pass `className="font-mono text-[13px]"` | |
| `tabs.tsx` | none; the landing tabs use the default list style | |

### 6.2 Layout and brand

#### `Logo` — `components/brand/Logo.tsx`
- **Props:** `size?: "sm" | "md"` (22px / 24px mark), `withWordmark?: boolean = true`, `href?: string`.
- **Renders:** the sailboat mark (inline SVG, `stroke="currentColor"`, wrapped in `text-primary`) and the lowercase "shipyard" wordmark in `font-semibold tracking-[-0.02em]`.
- **Notes:** one source for the mark; the router 404 inlines a copy of the same path data.

#### `AppHeader` — `components/AppHeader.tsx`
- **Props:** none; reads the current user (Phase 3) and route.
- **Renders:** 64px bar, bottom `border-foreground/6`. Left: `Logo` (links to `/projects` when logged in, `/` otherwise) and nav (`Projects`, `Docs ↗`) as `Button variant="ghost" size="sm"`; the active item gets `bg-foreground/6 text-foreground` via `NavLink`'s `isActive`. Right: `New project` (`Button size="sm"`, `Add01Icon`), `ThemeToggle`, `AccountMenu` (Phase 3).
- **States:** on the offline screen the right side is replaced by the amber "Reconnecting…" indicator.
- **Mobile:** below `md`, nav collapses into a `DropdownMenu` behind a menu icon button.

#### `ThemeToggle` — `components/ThemeToggle.tsx`
- **Built from:** `DropdownMenu` + `Button variant="ghost" size="icon-sm"`.
- **Renders:** sun or moon icon for the resolved theme; menu with System / Light / Dark as a radio group bound to `useTheme()`.
- **A11y:** `aria-label={t("theme.toggle")}`.

#### `AccountMenu` — `components/AccountMenu.tsx` (Phase 3)
- **Built from:** `Avatar` (GitHub `avatarUrl`, initials fallback) as the `DropdownMenu` trigger.
- **Items:** login name (label), `GitHub profile ↗`, Theme submenu (same as `ThemeToggle`, then drop the separate toggle), separator, `Log out` → `POST /auth/logout`, clear the query cache, navigate to `/`.

#### `PageHeader` — `components/PageHeader.tsx`
- **Props:** `breadcrumb?: { label: string; to?: string }[]`, `label?: string` (mono section label, rendered as `// LABEL`), `title: ReactNode`, `description?: ReactNode`, `actions?: ReactNode`.
- **Renders:** `Breadcrumb` → `SectionLabel` → `h1` (34px list pages; detail pages pass `size="detail"` for 30px) → description in `text-muted-foreground`. `actions` sit bottom-right, `items-end`.
- **Mobile:** actions wrap under the title.

#### `SectionLabel` — `components/SectionLabel.tsx`
- **Props:** `children`, `tone?: "primary" | "destructive" | "warning"`.
- **Renders:** `font-mono text-xs tracking-[0.14em] uppercase`, prefixed with `// `, colour `text-primary-text` (or the status `-foreground` token for the tone).

#### `DisplayHeading` — `components/DisplayHeading.tsx`
- **Props:** `as?: "h1" | "h2"`, `line1: ReactNode`, `line2: ReactNode`, `size: "hero" | "section" | "page" | "error"`, `accent?: boolean` (second line in `text-primary-text` instead of muted).
- **Renders:** Sora first line, `font-serif-accent` second line about 1.15× larger. Used by the landing sections, auth, error screens and New project.

#### `DoubleCard` — `components/DoubleCard.tsx`
- **Props:** `className?`, `innerClassName?`, `tone?: "default" | "primary"` (primary-tinted outer border, used by the deployment URLs card), `children`.
- **Code:** see [ui-design §3](ui-design.md#doublecard).
- **Notes:** the only card style in the app. Anything that looks like a card is a `DoubleCard`.

#### `GlowBackdrop` — `components/GlowBackdrop.tsx`
- **Props:** `tone?: "primary" | "destructive" | "warning"`, `dots?: boolean`, `height?: number = 420`, `origin?: "top" | "center"`.
- **Renders:** an absolutely positioned, `aria-hidden`, `pointer-events-none` div with a radial gradient of the tone at 10% (7% for destructive/warning). With `dots`, a second layer with `dot-grid` and a radial `mask-image` so the dots fade out.

#### `EmptyState` / `ErrorState` — `components/`
- **`EmptyState` props:** `icon`, `title`, `description?`, `action?`. A `DoubleCard` with centred content; used for "No projects yet" and empty search.
- **`ErrorState` props:** `variant: "not-found" | "server" | "offline"`, `error?: ApiError`, `onRetry?`.
- **Renders:** see [ui-design §5.7](ui-design.md#57-error-screens). Each variant sets `SectionLabel tone`, `DisplayHeading`, body copy, buttons and its extra block (request card, details `Collapsible`, checklist). Also sets the `AppLayout` glow tone.

### 6.3 Status and progress

#### `StatusBadge` — `components/StatusBadge.tsx`
- **Built from:** `Badge variant="outline"`.
- **Props:** `status: DeploymentStatus | "none"`, `live?: boolean`, `size?: "sm" | "md"` (22px in lists, 24px in page headers).
- **Renders:** dot + translated word. `live` renders the solid primary pill ("live") and ignores `status`. `"none"` renders "no deployments" in the queued style.
- **Mapping:** one `const STYLE: Record<DeploymentStatus, string>` from [ui-design §3](ui-design.md#statusbadge); running statuses add `motion-safe:animate-pulse-soft` to the dot.
- **i18n:** `status.<name>`, `status.live`, `status.none`.

#### `StepTracker` — `components/StepTracker.tsx`
- **Props:** `status: DeploymentStatus`, `failedStage?: Stage | null`.
- **Renders:** `stageStates()` (§5.1) → six `Stage` items (circle + label) with `Connector` lines between them. Wrap in a `DoubleCard` at the call site.
- **A11y:** an `<ol>`; each item has a visually hidden state ("done", "in progress", "failed", "not started", "skipped"); the current one gets `aria-current="step"`.
- **Mobile:** labels for all but current/failed are `sr-only`.

#### `CopyButton` — `components/CopyButton.tsx`
- **Props:** `value: string | (() => string)`, `label: string` (used for `aria-label` and the tooltip), `size?: "icon-sm" | "sm"`.
- **Behaviour:** `navigator.clipboard.writeText`; on success swap the icon to a check for 1.5s and announce "Copied" through an `aria-live="polite"` span. If the Clipboard API is missing (non-secure context), fall back to a hidden `<textarea>` + `document.execCommand("copy")`.

### 6.4 Logs

#### `LogTerminal` — `components/log/LogTerminal.tsx`
- **Props:** `lines: string[]`, `state: "streaming" | "finished" | "archived"`, `errorLine?: number`, `height?: number`, `onDownload?: () => void`.
- **Composition:** `DoubleCard` outer frame (themed) → `div.dark-surface` (always dark, see below) → toolbar + scroll body.
- **Toolbar:** `BUILD LOG` label, line count and state, `Streaming` indicator when streaming, `CopyButton` (whole log), download button (`Blob` → `URL.createObjectURL` → `<a download="<sha>.log">`).
- **Body:** `useAutoScroll` (§7.1); `lines.map(parseLine)` memoised; each row is a memoised `LogLine`.
- **Always dark:** wrap the inner panel in a class that re-declares the dark tokens (`.dark-surface { --foreground: #fafafa; … }`, or just put the `dark` class on it: `@custom-variant dark` is `&:is(.dark *)`, so `<div className="dark">` makes everything inside it dark, even in light mode).
- **Imperative handle:** `ref` exposes `scrollToLine(i)` for "Jump to error".

#### `LogLine` — `components/log/LogLine.tsx`
- **Props:** `n: number`, `line: LogLine`, `highlighted?: boolean`.
- **Renders:** line number, step label padded to 7 chars, text in the step colour (`STEP_COLOR` map from ui-design). `white-space: pre`. `React.memo` so appending a line re-renders only the new row.

### 6.5 Projects

#### `ProjectCard` — `features/projects/ProjectCard.tsx`
- **Props:** `project: ProjectListItem` (name, slug, host, branch, latest deployment summary, updatedAt).
- **Renders:** `DoubleCard` → name link + `StatusBadge` · host (mono) · `Separator` · SHA + message (truncate) · footer: `branch · relative time` and `Visit ↗` / `Open`, or `Deploy` when there's no deployment.
- **Notes:** the whole card isn't a link; only the name and `Open` are, so `Visit ↗` can be its own link.

#### `ProjectSearch` and `SortSelect` — `features/projects/`
- **ProjectSearch:** `Input` with an inset search icon, bound to `?q=`; updates the URL on a 250ms debounce with `replace: true` and resets `page`. `Esc` clears.
- **SortSelect:** `Select` bound to `?sort=` (`updated` | `name` | `created`), trigger reads "Sort  Recently updated".
- **Hook:** `useListParams()` wraps `useSearchParams` and returns typed `{ page, q, sort }` with setters, so the page never parses the URL itself.

#### `ProjectPagination` — `features/projects/ProjectPagination.tsx`
- **Built from:** shadcn `Pagination`, `PaginationContent`, `PaginationItem`, `PaginationLink`, `PaginationPrevious`, `PaginationNext`, `PaginationEllipsis`.
- **Props:** `page`, `pageSize`, `total`.
- **Renders:** "Showing 1–12 of 48 projects" on the left; `paginationRange()` (§5.4) on the right. Links are real `<Link to="?page=n">` so middle-click and back work. `null` when `total <= pageSize`.

#### `RepoUrlField`, `DetectionPanel`, `BuildSettings`, `NextStepsCard` — `features/projects/new/`
- **Form state:** one `useReducer` (or React Hook Form if you add it) with fields `repoUrl, branch, rootDir, installCmd, buildCmd, outputDir, slug, spaFallback`. `detect` results fill empty or untouched command fields only; don't overwrite what the user typed.
- **`RepoUrlField`:** `Field` + `Label` + mono `Input` with a GitHub icon; `onBlur` triggers `useDetect` when the URL parses. Phase 3 swaps it for a repo picker `Select`.
- **`DetectionPanel`** props: `state: "idle" | "detecting" | "done" | "error"`, `result?: DetectResult`, `error?`. Done: framework line + `Badge variant="secondary"` chips + one `Alert variant="warning"` per warning. Error: a muted line "Couldn't detect the framework; fill in the settings below." (the `Collapsible` opens).
- **`BuildSettings`:** `Collapsible` (open when there are warnings or detection failed) with a 2-column grid of fields; the subdomain field is an input group with a fixed suffix (`.{BASE_DOMAIN}`); `Checkbox` for SPA fallback.
- **Field errors:** a `fieldErrors` map from the create mutation's `ApiError` (`api.slug_taken` → `slug`, `api.invalid_root_dir` → `rootDir`, `api.repo_unsupported` → `repoUrl`); set `aria-invalid` and render the message under the field. Anything unmapped goes in a destructive `Alert` above the footer.
- **`NextStepsCard`:** static, four numbered steps; i18n keys `newProject.next.1..4`.

#### `ProjectSummary` — `features/projects/ProjectSummary.tsx`
- **Props:** `project: ProjectDetail`.
- **Renders:** `DoubleCard` with name, repo link, branch badge, "Live at" line (glowing dot), actions (`Visit site ↗`, `Deploy now`) and a 4-column stat row (`SectionLabel`-style keys, mono values).

#### `DeploymentsTable` and `DeploymentRowActions` — `features/projects/`
- **Built from:** shadcn `Table` inside a `DoubleCard` with a header block.
- **Props:** `projectId`, `activeDeploymentId`, `pages` from `useDeployments`.
- **Row action logic** (keep it in one pure function so it's testable):

```ts
function rowAction(d: Deployment, active: Deployment | undefined): "view-logs" | "promote" | "rollback" | "live" | null {
  if (d.id === active?.id) return "live";
  if (d.status === "ready") return active && d.createdAt < active.createdAt ? "rollback" : "promote";
  if (d.status === "failed" || isRunning(d.status)) return "view-logs";
  return null;
}
```

- **Row menu:** `DropdownMenu` on `…` with "Delete deployment"; disabled with a `Tooltip` on the live row and on running rows (`api.delete_active`, `api.deployment_in_progress`). Delete asks for confirmation in the menu itself (a second "Click again to delete" item state), not a dialog.
- **Live row:** `data-live` on the `<tr>` → `shadow-[inset_2px_0_0_var(--primary)]` on the first cell.
- **Footer:** `Load older deployments` calls `fetchNextPage`; hidden when `!hasNextPage`.

### 6.6 Deployments

#### `DeploymentHeader` — `features/deployments/DeploymentHeader.tsx`
- **Props:** `deployment`, `project`.
- **Renders:** breadcrumb, commit message as h1 (fallback "Deployment `{sha}`"), chips (SHA, branch, framework), started/finished time, live duration (`useNow(1000)` while running), `StatusBadge size="md"`, and `Redeploy` when failed (with the "Builds the latest commit on `{branch}`" tooltip).

#### `BuildFailedAlert` — `features/deployments/BuildFailedAlert.tsx`
- **Built from:** `Alert variant="destructive"`.
- **Props:** `deployment`, `errorLine?: { index: number; text: string }`, `onJump: () => void`.
- **Renders:** title from `formatUserMessage(i18n, { code: errorCode, params: errorParams }, error)`, one sentence of guidance, the offending line in a dark mono box, `Jump to error` (calls `LogTerminal`'s `scrollToLine`) and `Copy error` (`CopyButton size="sm"`).

#### `DeploymentUrls` — `features/deployments/DeploymentUrls.tsx`
- **Props:** `deployment`, `project`.
- **Renders:** `DoubleCard tone="primary"` with two `UrlRow`s: Preview (`<deploymentId>.<BASE_DOMAIN>`) and Production (`<slug>.<BASE_DOMAIN>`). The production row shows "Currently serving `{sha}`, an older build." + `Promote to production`, or a solid `live` badge when this deployment is live.
- **`UrlRow`** props: `label`, `href`, `hint`, `action?`. Mono label, mono link, `CopyButton`, muted hint, trailing action.

### 6.7 Landing

All landing components live in `features/landing/`. Copy comes from `common.json` (`landing.*` keys), not hard-coded strings.

| Component | Props | Notes |
|---|---|---|
| `MarketingNav` | — | Anchor links scroll smoothly (`scroll-behavior: smooth` on `html`, `scroll-margin-top` on sections). `Open dashboard` is `Button variant="inverse" size="sm"` linking to `/projects`. |
| `Hero` | — | `GlowBackdrop dots`, outline `Badge` with pulsing dot, `DisplayHeading size="hero" accent` with the SVG underline (absolutely positioned under line 2), two `Button size="xl"`, `TerminalPreview`, framework `Badge`s. |
| `TerminalPreview` | `lines: LogLine[]`, `title`, `status` | Static, always dark (`className="dark"`), corner brackets are four 12px absolutely positioned L-shapes in `border-primary`. Optional: reveal lines one by one with `motion-safe` when it scrolls into view (`IntersectionObserver`), like the reference. |
| `FeatureCard` | `icon`, `title`, `description`, `roadmap?: boolean` | `DoubleCard`; `roadmap` adds the outline `Roadmap` badge top-right. Data array in `features.data.ts`. |
| `ArchitectureSection` | — | See §7.4. |
| `CompareCard` | `versus`, `criticism`, `answer` | `DoubleCard` split in two; bottom half `bg-primary/6`. |
| `CtaSection` | — | Centred `DisplayHeading size="section"`, two `Button size="xl"`, radial glow behind. |
| `MarketingFooter` | — | Logo line, ghost links, © year from `new Date().getFullYear()`. |

### 6.8 Auth (Phase 3)

| Component | Props | Notes |
|---|---|---|
| `AuthBrandPanel` | `variant: "login" | "signup"` | Glow + dot grid, logo, headline; login shows a three-line `TerminalPreview`, signup three check-marked benefits. |
| `GitHubButton` | `label`, `next?: string` | `Button variant="inverse" size="xl" className="w-full"` rendering an `<a href={`${API}/auth/github?next=…`}>` (a full navigation, not `fetch`). GitHub mark icon. |
| `ScopeList` | — | `DoubleCard` listing `read:user` and `repo` as secondary badges with one-line reasons; revoke hint below. |
| Sign-in error | — | `LoginPage` reads `?error=` once with `useSearchParams`, keeps it in state, and immediately `setSearchParams({}, { replace: true })`; renders `Alert variant="destructive"` with `formatUserMessage`. |

---

## 7. Implementation notes for the tricky parts

### 7.1 Log streaming and follow mode

- **Batch incoming lines.** Phase 2's `useLogStream` does `setLines(prev => [...prev, line])` per event, which re-renders once per line during an `npm install`. Buffer lines in a ref and flush once per animation frame:

```ts
const buffer = useRef<string[]>([]);
const flush = useCallback(() => { const b = buffer.current.splice(0); if (b.length) setLines((p) => p.concat(b)); frame.current = 0; }, []);
events.onmessage = (e) => { /* de-dupe by id as before */ buffer.current.push(e.data); frame.current ||= requestAnimationFrame(flush); };
```

- **`useAutoScroll(ref, deps)`** returns `{ following, jumpToBottom }`. It sets `following` from the scroll position (`scrollHeight - scrollTop - clientHeight < 8`) in a passive scroll listener and scrolls to the bottom in `useLayoutEffect` when `deps` change and `following` is true.
- **Long logs.** Above ~5,000 lines, render through `@tanstack/react-virtual` (fixed 23px rows make it simple). Below that, plain rendering with memoised rows is fine.
- **Status and done.** The SSE `status` event updates the deployment query cache (`setQueryData`); `done` closes the stream and invalidates the deployment and its project so the ready/failed blocks appear.

### 7.2 Step tracker

Everything visual comes from `stageStates()`; the component is a map over six items with a `switch` on the state for circle and label classes. Unit-test `stageStates` for each status (and for `failed` at each stage) rather than the markup.

### 7.3 Project list URL state

Treat the URL as the source of truth: `useListParams()` reads it, `useProjects(params)` keys on it, and every control writes back to it. `keepPreviousData` keeps the old page on screen while the next loads; show a thin progress state on the pagination (`aria-busy`) instead of skeletons. Clamp `page` to `pageCount` when the response says it's out of range.

### 7.4 Architecture diagram

Make it data-driven so the copy, layout and highlighting can't drift apart:

```ts
// features/landing/architecture.data.ts
export const NODES = [
  { id: "dev", label: "Developer", sub: "you", x: 20, y: 50, icon: UserIcon },
  { id: "dash", label: "Dashboard", sub: "React · shadcn", x: 255, y: 50, icon: ComputerIcon, zone: "control" },
  // …the table in ui-design §5.1
] as const;
export const EDGES = [
  { id: "e1", from: "dev", to: "dash", d: "M170 82 H251", label: "paste URL", at: [212, 40], step: "01" },
  // …
] as const;
export const STEPS = { "01": { title, description, services }, /* … */ } as const;
```

- **State:** the `Tabs` value (`"all" | "01" | … | "04"`, default `"03"`). Derive `litNodes` and `litEdges` sets with `useMemo`.
- **Rendering:** a `relative` box of fixed size 1130×540 inside `overflow-x-auto`. Zones and nodes are absolutely positioned divs (`style={{ left: x, top: y }}`), so they can use tokens and `DoubleCard`-like classes. Edges are `<path>`s in one `<svg>` under the nodes, with `className={cn("stroke-foreground/28 transition-[stroke]", lit && "stroke-primary motion-safe:animate-flow [stroke-dasharray:6_6]")}`. Edge labels are absolutely positioned chips.
- **Arrowheads:** one `<marker>` with `fill="context-stroke"` follows the edge colour in current browsers. If you need older Safari, define two markers (neutral and primary) and switch `markerEnd` with the lit state.
- **Dimming:** unlit nodes, edges and labels get `opacity-35` only when a step is selected.
- **A11y:** the diagram is decorative (`aria-hidden`); the detail card under it carries the same information as text, and the tabs are real `Tabs` with keyboard support.
- **Test:** for each step, assert the lit node set equals the step's `services` in the data file, so the copy and the highlight stay consistent.

### 7.5 Promote with undo

```ts
onMutate: async (deploymentId) => {
  await qc.cancelQueries({ queryKey: qk.project(projectId) });
  const prev = qc.getQueryData<ProjectDetail>(qk.project(projectId));
  qc.setQueryData(qk.project(projectId), { ...prev!, activeDeploymentId: deploymentId });
  return { prevId: prev?.activeDeploymentId };
},
onError: (_e, _id, ctx) => qc.setQueryData(qk.project(projectId), (p) => p && { ...p, activeDeploymentId: ctx?.prevId ?? null }),
onSuccess: (_r, id, ctx) => toast.success(t("promote.done", { slug, sha: short(id) }), {
  action: ctx?.prevId ? { label: t("common.undo"), onClick: () => promote.mutate(ctx.prevId!) } : undefined,
}),
```

### 7.6 Router 404 page — `apps/router/src/notFoundPage.ts`

```ts
export function notFoundPage(host: string): string {
  const safeHost = escapeHtml(host.slice(0, 253));
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Nothing here · ${safeHost}</title><style>${CSS}</style></head><body>…${safeHost}…</body></html>`;
}
```

- `CSS` is a constant string: light values on `:root`, dark in `@media (prefers-color-scheme: dark)`, system font stacks, the dot grid as a CSS gradient. No external URLs anywhere (a unit test can assert the output has no `http` other than the "Deploy your own" link).
- Build it once per request; it's small. Send `Cache-Control: no-store` so a later deploy isn't hidden behind a cached 404.
- `escapeHtml` must cover `& < > " '`; the host comes from the request.

### 7.7 i18n

- Every string in the mockup becomes a key in `locales/en/common.json`, grouped by screen: `nav.*`, `landing.*`, `projects.*`, `newProject.*`, `project.*`, `deployment.*`, `auth.*`, `errors.page.*`, `status.*`, `theme.*`, `common.*`.
- Headings with a serif second line are two keys (`landing.hero.line1`, `landing.hero.line2`) so translators can keep the split.
- Counts use i18next plurals: `projects.count_one` / `projects.count_other`, `log.lines_one` / `log.lines_other`.
- Server messages always go through `formatUserMessage`; never render `error.message` directly.

---

## 8. Testing

| What | How |
|---|---|
| Pure logic: `stageStates`, `parseLine`, `findErrorLine`, `paginationRange`, `rowAction`, formatters | Vitest unit tests (fast; most bugs live here) |
| Components: `StatusBadge` per status, `StepTracker` per state, `ProjectPagination` edges, `CopyButton` fallback, `DetectionPanel` states | Vitest + Testing Library with `jsdom` |
| Theme: no flash, toggle persists, terminal stays dark | Testing Library for the provider; a manual check in both themes |
| Architecture data consistency | Unit test: lit nodes per step match the step's service list |
| Router 404 | Unit test: host is escaped, no external requests in the HTML, status 404 |
| Pages end to end | The Phase 2 checklist, run by hand against Compose; later Playwright with screenshots in light and dark |
| Accessibility | `@axe-core/react` in development, or axe in Playwright, on each page in both themes |

---

## 9. Build order

The same order as [ui-design §9](ui-design.md#9-build-order), with the pieces from this file:

1. **Foundation:** dependencies (§2), tokens and helpers (ui-design §2, §4.8 here), `ThemeProvider` + inline script, providers, router, layouts, API client with `NetworkError`, query hooks.
2. **Shared components:** `Logo`, `DoubleCard`, `SectionLabel`, `DisplayHeading`, `PageHeader`, `AppHeader`, `ThemeToggle`, `GlowBackdrop`, `StatusBadge`, `CopyButton`, the shadcn edits (§6.1).
3. **Deployment page:** `lib/stages.ts` + `StepTracker`, `lib/logs.ts` + `LogTerminal` with batched `useLogStream` and `useAutoScroll`, `DeploymentHeader`, `BuildFailedAlert`, `DeploymentUrls`.
4. **Project page:** `ProjectSummary`, `DeploymentsTable` with `rowAction`, promote with undo, delete.
5. **New project:** form state, `RepoUrlField`, `DetectionPanel`, `BuildSettings`, field-error mapping.
6. **Project list:** `useListParams`, `ProjectSearch`, `SortSelect`, `ProjectCard`, `ProjectPagination`, empty and loading states (needs the paginated API).
7. **Errors:** `RouteError`, `ErrorState` variants, offline retry loop, mutation toasts.
8. **Landing:** sections, then `architecture.data.ts` and `ArchitectureSection`.
9. **Phase 3:** `AuthLayout`, `LoginPage`, `SignupPage`, `GitHubButton`, `AccountMenu`, auth loader.
10. **Router 404:** `notFoundPage.ts` in `apps/router`.

## Checklist

- [ ] Every artboard in §1 has a route and a page component
- [ ] No component outside `components/ui/` and `index.css` contains a hex colour, `white/N` or `black/N` (the log terminal's step colours excepted)
- [ ] Links styled as buttons use Base UI's `render` prop or `buttonVariants`, never `asChild`
- [ ] Page-load errors reach `RouteError`; mutation errors are toasts
- [ ] Log streaming stays smooth through a large `npm install` (batched updates, memoised rows)
- [ ] `stageStates`, `paginationRange`, `rowAction`, `findErrorLine` and the architecture data are unit-tested
- [ ] Every string is an i18n key; server messages go through `formatUserMessage`
- [ ] Both themes checked on every page; axe reports no violations
