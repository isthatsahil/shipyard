# UI Implementation — Architecture and Components

**What this is:** how to build the mockup in `apps/web`: the app's structure, every component with its props and states, and the approach for the tricky parts (log streaming, the step tracker, pagination, the architecture diagram, themes).
**Read with:** [UI design](ui-design.md) for how things look (tokens, colours, sizes, copy). This file says how to put them together; where the two overlap, `ui-design.md` wins on appearance and this file wins on structure.
**Mockup:** [Shipyard Dashboard Mockup](https://claude.ai/artifact/VFZVJQM48XQ4mJUcx46xck), **Dark** and **Light** pages. Private to the owner until shared.
**Phases:** the dashboard, landing and error screens are [Phase 2](phase-2-logs-dashboard.md); auth screens and the account menu are [Phase 3](phase-3-auth-github.md); the router 404 is a [Phase 1](phase-1-pipeline.md) follow-up.

---

## 1. Mockup → code map

Every artboard in the mockup and what builds it. Light boards are the same screens with the `light` theme. Six screens also have a 390px phone board (Landing, Project list, New project, Project, Deployment failed, Deployment ready), built from the same components; [ui-design §7.5](ui-design.md#75-per-screen-behaviour) lists what changes. The **Theme tokens** board is the source for `index.css`.

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

Already in `apps/web`: React 19, Vite, Tailwind v4, shadcn (`base-vega` style, built on **Base UI**, not Radix) with `button` and `sonner` generated, Hugeicons, react-i18next with `formatUserMessage`, and from Phase 2 Step 4 `react-router`, `@tanstack/react-query` and `zustand`.

Add (and remove `next-themes`, which shadcn installed alongside `sonner`; the app has its own theme provider, [§4.7](#47-theme)):

```bash
pnpm --filter @shipyard/web remove next-themes
pnpm --filter @shipyard/web add @fontsource-variable/sora @fontsource-variable/jetbrains-mono @fontsource/instrument-serif
pnpm --filter @shipyard/web remove @fontsource-variable/inter
pnpm --filter @shipyard/web add -D @testing-library/react @testing-library/user-event jsdom
pnpm dlx shadcn@latest add badge card input label field checkbox collapsible alert table tabs \
  separator pagination dropdown-menu avatar select breadcrumb tooltip skeleton
```

- **Routing:** `react-router` v8 (8.4.0). Everything, including `createBrowserRouter`, `RouterProvider`, `Link` and the hooks, is imported from `react-router`.
- **Theme:** a small provider of our own in `src/theme/` ([§4.7](#47-theme)), no library. The generated `components/ui/sonner.tsx` imports `next-themes`; point it at ours ([§6.1](#61-changes-to-shadcn-primitives)).
- **Dates and sizes:** use `Intl.RelativeTimeFormat`, `Intl.DateTimeFormat` and `Intl.NumberFormat` with `i18n.language` (the i18n convention); no date library.
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
│  ├─ provider.tsx           QueryClient, ThemeProvider (src/theme), TooltipProvider, Toaster
│  └─ layouts/               MarketingLayout, AppLayout, AuthLayout
├─ api/
│  ├─ client.ts              req(), ApiError, NetworkError
│  ├─ types.ts               Project, Deployment, DetectResult, Page<T>, isTerminal
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
├─ theme/                    config.ts, script.ts, ThemeProvider.tsx, ForcedTheme.tsx, index.ts (§4.7)
├─ stores/                   logStore.ts (Zustand; see Phase 2 "State: who owns what")
├─ hooks/                    useLogStream, useAutoScroll, useNow, useCopy
├─ lib/                      format.ts, logs.ts, stages.ts, pagination.ts, utils.ts
└─ i18n/                     existing
```

Rules: `components/` holds anything used by two or more features; everything else lives in its feature folder. Pages compose; they don't style. A page file should read as a list of components and hooks.

---

## 4. App shell

### 4.1 Providers — `app/provider.tsx`

Extends the Phase 2 file (which already has `staleTime`, `retry` and the `meta.silent` toast filter):

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
  mutationCache: new MutationCache({
    // Mutations never take over the page. `silent` ones (detect, create) show their errors inline.
    onError: (err, _vars, _ctx, mutation) => { if (!mutation.meta?.silent) toastError(err); },
  }),
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <TooltipProvider delay={300}>
          {children}
          <Toaster />
        </TooltipProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
```

`ThemeProvider` comes from `@/theme` and takes its settings from `THEME_CONFIG` (§4.7); `Toaster` is the generated `components/ui/sonner.tsx`, which reads the theme from it (§6.1). `toastError` renders `formatUserMessage(i18n, err, err.message)` in a destructive `sonner` toast.

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
| `AppLayout` | `AppHeader`, `GlowBackdrop` (variant from route `handle`), `<main className="mx-auto w-full max-w-260 px-gutter pt-page-top pb-16"><Outlet/></main>` | Phase 3: a loader calls `GET /auth/me`; on 401 redirect to `/login?next=…`. The failed-deployment and offline screens set the glow variant through `useMatches()` `handle`. |
| `AuthLayout` | two-column grid: `AuthBrandPanel` (`hidden lg:flex`, 600px) + centred `<Outlet />` (`w-full max-w-100 px-gutter`) | Loader redirects to `/projects` if already logged in. |

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

`api.projects({ page, pageSize, q, sort })` already returns `Page<ProjectListItem> = { items, total, page, pageSize }`. Add the one call the Phase 2 client lacks:

```ts
deleteDeployment: (id: string) => req<void>(`/deployments/${id}`, { method: "DELETE" }),
```

### 4.6 Query hooks — `api/queries.ts`

The keys are Phase 2's `queryKeys` (`projects(params)`, `project(id)`, `deployments(projectId)`, `deployment(id)`); the table below says what to add to each hook.

| Hook | Kind | Behaviour |
|---|---|---|
| `useProjects(params)` | `useQuery` | `placeholderData: keepPreviousData` so paging doesn't flash skeletons; `refetchInterval: 10_000` while any project is building |
| `useProject(id)` | `useQuery` | |
| `useDeployments(projectId)` | `useInfiniteQuery` | cursor from Phase 2 (`next`); `refetchInterval` 5 s while the first page has an unfinished row, 30 s otherwise (already in Phase 2) |
| `useDeployment(id)` | `useQuery` | `refetchInterval` stops at a terminal status; the SSE `status` event also calls `setQueryData` so the badge flips instantly |
| `useDetect()` | `useMutation` | fired on URL blur; debounced; its errors show inline, not as a toast (`meta: { silent: true }`) |
| `useCreateProject()` | `useMutation` | on success navigate to the new deployment; field errors (`api.slug_taken`, `api.validation_failed`) map to form fields |
| `useDeploy(projectId)` | `useMutation` | invalidates `deployments` and navigates to the new deployment |
| `usePromote(projectId)` | `useMutation` | optimistic: sets `project.activeDeploymentId` in `onMutate`, restores it in `onError`; the success toast has **Undo**, which promotes the previous id |
| `useDeleteDeployment(projectId)` | `useMutation` | calls `api.deleteDeployment`; removes the row from the cached pages, then invalidates `deployments` and `project` (the count changes) |

### 4.7 Theme

A small provider of our own in `src/theme/`, about 150 lines, instead of `next-themes`. What it does and how:

| Feature | How |
|---|---|
| Follows the system setting | `theme: "system"` resolves through `matchMedia("(prefers-color-scheme: dark)")`, read with `useSyncExternalStore`, so an OS switch updates the page live |
| Themed browser UI | sets `color-scheme` on `<html>` to the resolved theme, so scrollbars, form controls and autofill match |
| No flash on load | `themeScript()` runs in `<head>`, before the body renders, and applies the stored theme. A Vite plugin injects it, built from the same `THEME_CONFIG` as the provider, so the two can't disagree |
| Synced across tabs and windows | a `storage` event listener: when another tab writes the key, this tab applies it |
| No animation when switching | for one frame, a `*{transition:none!important}` style is in place while the class changes |
| Pages that force a theme | `<ForcedTheme theme="dark" />` overrides the user's choice while it's mounted; `forcedRoutes` in the config covers the first paint of those URLs |
| Class or data attribute | `attribute: "class"` (default, what shadcn's `dark:` variant uses) or any `data-*` attribute |

Next.js App Router and SSR/SSG support don't apply: `apps/web` is a Vite SPA rendered in the browser, and the inline script gives the same no-flash result. `themeScript()` returns a plain string, so a server-rendered app could put the same script in its `<head>`.

#### `theme/config.ts`

Imports nothing, so `vite.config.ts` can import it too.

```ts
export const THEMES = ["light", "dark"] as const;
export type Theme = (typeof THEMES)[number];
/** What the user picked; "system" follows the OS. */
export type ThemeSetting = Theme | "system";

export interface ThemeConfig {
  /** localStorage key holding the user's ThemeSetting. */
  storageKey: string;
  /** "class" adds `dark`/`light` to <html>; "data-theme" (or any data-*) sets that attribute. */
  attribute: "class" | `data-${string}`;
  defaultTheme: ThemeSetting;
  /** Set CSS `color-scheme` so native UI (scrollbars, inputs) matches. */
  enableColorScheme: boolean;
  /** URLs that always render in one theme, as regex sources matched against `location.pathname`. */
  forcedRoutes: { pattern: string; theme: Theme }[];
}

export const THEME_CONFIG: ThemeConfig = {
  storageKey: "theme",
  attribute: "class",
  defaultTheme: "system",
  enableColorScheme: true,
  forcedRoutes: [],
};

export const DARK_QUERY = "(prefers-color-scheme: dark)";

export const isThemeSetting = (value: unknown): value is ThemeSetting =>
  value === "system" || THEMES.includes(value as Theme);
```

#### `theme/script.ts`: no flash on load

```ts
/// <reference lib="dom" />
// Type-checked by tsconfig.node.json too (vite.config.ts imports it), which has no DOM lib
// and needs the `.ts` extension on relative imports.
import { DARK_QUERY, THEMES, type ThemeConfig } from "./config.ts";

/**
 * Runs in the page before anything else. Self-contained on purpose: it is sent as source text,
 * so it can't use imports, closures or helpers; everything it needs arrives as arguments.
 */
function applyStoredTheme(config: ThemeConfig, themes: readonly string[], darkQuery: string) {
  const root = document.documentElement;
  let theme: string | undefined;
  for (const route of config.forcedRoutes)
    if (new RegExp(route.pattern).test(location.pathname)) theme = route.theme;
  if (!theme) {
    let stored: string | null = null;
    try { stored = localStorage.getItem(config.storageKey); } catch {}   // storage can be blocked
    const setting = stored === "system" || themes.includes(stored ?? "") ? stored! : config.defaultTheme;
    theme = setting === "system" ? (matchMedia(darkQuery).matches ? "dark" : "light") : setting;
  }
  if (config.attribute === "class") { root.classList.remove(...themes); root.classList.add(theme); }
  else root.setAttribute(config.attribute, theme);
  if (config.enableColorScheme) root.style.colorScheme = theme;
}

/** The script's source, ready to put in a <script> tag. */
export const themeScript = (config: ThemeConfig) =>
  `(${applyStoredTheme.toString()})(${JSON.stringify(config)},${JSON.stringify(THEMES)},${JSON.stringify(DARK_QUERY)})`;
```

Inject it with a Vite plugin in `vite.config.ts`, so `index.html` never holds a hand-copied version:

```ts
import type { Plugin } from "vite";
import { THEME_CONFIG } from "./src/theme/config.ts";
import { themeScript } from "./src/theme/script.ts";

/** Adds the theme script to <head>: it runs before the body renders, so the first paint already has the right theme. */
const themeScriptPlugin = (): Plugin => ({
  name: "shipyard-theme-script",
  transformIndexHtml: () => [{ tag: "script", children: themeScript(THEME_CONFIG), injectTo: "head" }],
});

// plugins: [react(), tailwindcss(), themeScriptPlugin()]
```

Add `src/theme/config.ts` and `src/theme/script.ts` to `include` in `tsconfig.node.json`, which type-checks `vite.config.ts`.

#### `theme/ThemeProvider.tsx`

```tsx
import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { DARK_QUERY, THEME_CONFIG, THEMES, isThemeSetting, type Theme, type ThemeConfig, type ThemeSetting } from "./config";

interface ThemeContextValue {
  /** The user's choice, for the ThemeToggle radio group. */
  theme: ThemeSetting;
  setTheme: (next: ThemeSetting | ((current: ThemeSetting) => ThemeSetting)) => void;
  /** What is on screen: the forced theme, else the choice with "system" resolved. */
  resolvedTheme: Theme;
  systemTheme: Theme;
  forcedTheme: Theme | undefined;
  /** Used by <ForcedTheme>; pages render that instead of calling this. */
  setForcedTheme: (theme: Theme | undefined) => void;
  themes: readonly Theme[];
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStored(config: ThemeConfig): ThemeSetting {
  try {
    const value = localStorage.getItem(config.storageKey);
    return isThemeSetting(value) ? value : config.defaultTheme;
  } catch {
    return config.defaultTheme;
  }
}

const subscribeSystem = (onChange: () => void) => {
  const query = matchMedia(DARK_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
};
const getSystemTheme = (): Theme => (matchMedia(DARK_QUERY).matches ? "dark" : "light");

function applyToDocument(theme: Theme, config: ThemeConfig) {
  const root = document.documentElement;
  if (config.attribute === "class") {
    root.classList.remove(...THEMES);
    root.classList.add(theme);
  } else root.setAttribute(config.attribute, theme);
  if (config.enableColorScheme) root.style.colorScheme = theme;
}

/** Runs `change` with every CSS transition switched off, so colours swap at once instead of fading. */
function withoutTransitions(change: () => void) {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none!important}";
  document.head.appendChild(style);
  change();
  void getComputedStyle(document.body).opacity;   // forces a style recalculation while transitions are off
  setTimeout(() => style.remove(), 1);
}

export function ThemeProvider({
  children,
  config = THEME_CONFIG,
  disableTransitionOnChange = true,
}: {
  children: React.ReactNode;
  config?: ThemeConfig;
  disableTransitionOnChange?: boolean;
}) {
  const [theme, setThemeState] = useState<ThemeSetting>(() => readStored(config));
  const [forcedTheme, setForcedTheme] = useState<Theme>();
  const systemTheme = useSyncExternalStore(subscribeSystem, getSystemTheme);
  const resolvedTheme = forcedTheme ?? (theme === "system" ? systemTheme : theme);

  // Layout effect: the change lands before the browser paints.
  useLayoutEffect(() => {
    const apply = () => applyToDocument(resolvedTheme, config);
    if (disableTransitionOnChange) withoutTransitions(apply);
    else apply();
  }, [resolvedTheme, config, disableTransitionOnChange]);

  // Persist the choice. Writing the same value again doesn't fire `storage` in other tabs.
  useEffect(() => {
    try { localStorage.setItem(config.storageKey, theme); } catch {}
  }, [theme, config.storageKey]);

  // Another tab or window changed it. `key` is null when storage was cleared.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== config.storageKey) return;
      setThemeState(isThemeSetting(event.newValue) ? event.newValue : config.defaultTheme);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [config.storageKey, config.defaultTheme]);

  const setTheme = useCallback<ThemeContextValue["setTheme"]>((next) => setThemeState(next), []);

  const value = useMemo(
    () => ({ theme, setTheme, resolvedTheme, systemTheme, forcedTheme, setForcedTheme, themes: THEMES }),
    [theme, setTheme, resolvedTheme, systemTheme, forcedTheme],
  );
  return <ThemeContext value={value}>{children}</ThemeContext>;
}

export function useTheme() {
  const context = use(ThemeContext);
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>");
  return context;
}
```

#### `theme/ForcedTheme.tsx` and `theme/index.ts`

```tsx
import { useLayoutEffect } from "react";
import type { Theme } from "./config";
import { useTheme } from "./ThemeProvider";

/** Renders nothing; while mounted, the page shows `theme` whatever the user picked. */
export function ForcedTheme({ theme }: { theme: Theme }) {
  const { setForcedTheme } = useTheme();
  useLayoutEffect(() => {
    setForcedTheme(theme);
    return () => setForcedTheme(undefined);
  }, [theme, setForcedTheme]);
  return null;
}
```

`index.ts` re-exports `ThemeProvider`, `useTheme`, `ForcedTheme` and the types, so the app imports from `@/theme`.

Notes:

- **Why both the script and the provider apply the theme.** The script makes the first paint right; the provider takes over once React runs and handles every change after that. They read the same key and config, so the provider's first apply is a no-op visually.
- **Forcing a theme takes two steps for full page loads.** `<ForcedTheme>` covers navigation inside the app. A reload on that URL paints before React mounts, so add the route to `forcedRoutes` as well. No Shipyard page forces a theme today; the log terminal stays dark through its own `dark` class (§6.4), not through this.
- **Using a data attribute.** Set `attribute: "data-theme"` and change the variant in `index.css` to `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`. The `.dark { … }` token block becomes `[data-theme=dark] { … }`.
- **`erasableSyntaxOnly`.** Both tsconfigs enable it; the code above uses no enums, namespaces or parameter properties.

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

### 4.9 Fluid tokens and layout utilities

[UI design §7](ui-design.md#7-fluid-sizing-mobile-and-accessibility) decides *what* is fluid and *what* stays fixed; this section is how to build it with Tailwind v4 (4.3 in this repo: container queries and the `pointer-coarse:` variant are built in, no plugins).

#### Tokens — `index.css`

Add the [§7.3](ui-design.md#73-fluid-tokens) tokens to a plain `@theme` block (not `@theme inline`: these values don't reference other variables, and a plain `@theme` also emits them on `:root`, where they're visible in DevTools):

```css
@theme {
    /* Display type: one class sets size, line height and tracking. */
    --text-hero: clamp(2.5rem, 1.667rem + 3.704vw, 5rem);
    --text-hero--line-height: 1.05;
    --text-hero--letter-spacing: -0.03em;
    --text-display: clamp(2.25rem, 1.5rem + 3.333vw, 4.5rem);
    --text-display--line-height: 1.05;
    --text-display--letter-spacing: -0.03em;
    --text-section: clamp(1.875rem, 1.583rem + 1.296vw, 2.75rem);
    --text-section--line-height: 1.1;
    --text-section--letter-spacing: -0.03em;
    --text-error: clamp(2.125rem, 1.75rem + 1.667vw, 3.25rem);
    --text-error--line-height: 1.05;
    --text-error--letter-spacing: -0.03em;
    --text-page: clamp(1.75rem, 1.625rem + 0.556vw, 2.125rem);
    --text-page--line-height: 1.15;
    --text-page--letter-spacing: -0.03em;
    --text-page-detail: clamp(1.625rem, 1.542rem + 0.37vw, 1.875rem);
    --text-page-detail--line-height: 1.15;
    --text-page-detail--letter-spacing: -0.03em;

    /* Spacing: usable with any spacing utility (p-, m-, gap-, h-, w-, max-w-…). */
    --spacing-section: clamp(4rem, 3rem + 4.444vw, 7rem);
    --spacing-gutter: clamp(1rem, 0.667rem + 1.481vw, 2rem);
    --spacing-page-top: clamp(1.5rem, 1.167rem + 1.481vw, 2.5rem);
    --spacing-log-live: clamp(15rem, 60dvh, 29.375rem);
    --spacing-log: clamp(15rem, 55dvh, 26.25rem);
}
```

- **How Tailwind turns these into classes.** A `--text-<name>` variable becomes a `text-<name>` font-size utility, and its `--line-height` / `--letter-spacing` sub-keys are applied by the same class. A `--spacing-<name>` variable works with every spacing utility, so `py-section`, `px-gutter`, `h-log` and `gap-gutter` all exist.
- **Making a new fluid value.** Use the formula in [ui-design §7.3](ui-design.md#73-fluid-tokens), or paste this into the browser console:

  ```js
  const fluid = (minPx, maxPx, minVw = 360, maxVw = 1440) => {
    const slope = (maxPx - minPx) / (maxVw - minVw);
    const rem = (px) => `${+(px / 16).toFixed(3)}rem`;
    return `clamp(${rem(minPx)}, ${rem(minPx - slope * minVw)} + ${+(slope * 100).toFixed(3)}vw, ${rem(maxPx)})`;
  };
  fluid(40, 80);   // "clamp(2.5rem, 1.667rem + 3.704vw, 5rem)"
  ```

  Then add it as a token. Don't write `text-[clamp(...)]` inline in a component: a fluid size is a design decision and belongs in the token list, where the next person can see the whole scale.
- **Headings with a serif second line** don't need a second token. `DisplayHeading` puts the size token on the heading and `text-[1.15em]` on the serif `<span>`, so the second line is always 1.15× the first, at every width.

#### Auto-fill grids — `grid-fluid-*`

```css
@utility grid-fluid-* {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, calc(var(--spacing) * --value(integer))), 1fr));
}
```

- `grid-fluid-80 gap-5` means "as many columns as fit, each at least 80 × 4px = 320px, sharing the leftover space". The column count changes with the space, with no breakpoint.
- **`min(100%, …)` is what keeps phones from scrolling sideways.** Without it, a 320px minimum column inside a 288px container overflows. With it, the minimum shrinks to the container's width.
- **`auto-fill`, not `auto-fit`.** `auto-fill` keeps empty column slots, so a project list with a single project shows one normal-width card instead of one card stretched across the page. Use `auto-fit` (a second utility, if needed) only where a few items *should* fill the row.

#### Container queries

```tsx
// ProjectSummary stats: 2 × 2 in a narrow card, 4 across from 576px of card width.
<div className="@container">
  <dl className="grid grid-cols-2 gap-4 @xl:grid-cols-4">…</dl>
</div>
```

- `@container` marks the element whose width the `@sm:`/`@md:`/`@xl:`… variants measure. Sizes: `@xs` 320px, `@sm` 384px, `@md` 448px, `@lg` 512px, `@xl` 576px, `@2xl` 672px.
- **Name the container when they nest:** `@container/summary` on the root and `@xl/summary:grid-cols-4` on the child, so an inner container doesn't capture the query.
- **Put `@container` on something that gets its width from its parent** (a card, a `w-full` block). It sets `container-type: inline-size`, which stops the element from sizing itself from its children; on a shrink-to-fit element (an inline-flex, a flex item with no basis) it collapses to zero width.
- **Tables don't reflow with CSS.** Turning `<tr>`/`<td>` into grid items with `display` changes removes their table semantics in some screen readers. `DeploymentsTable` renders two views from the same rows and `rowAction()`: the `<Table>` with `hidden @2xl:table`, and a stacked list (`<ul>`) with `@2xl:hidden`. `display: none` takes the hidden one out of the accessibility tree, so screen readers only meet one.

#### Viewport breakpoints

Use `md:` and `lg:` only for the structural changes listed in [ui-design §7.4](ui-design.md#74-layout-rules) (nav menus, the architecture diagram, the side and brand panels, `StepTracker` labels). If you're about to add a breakpoint to make a component fit, it should be a container query or an intrinsic layout instead.

#### Overflow guards

- A flex or grid child holding a hostname, SHA, URL or command gets `min-w-0` and the text gets `truncate` with `title={value}`. Flex items default to `min-width: auto` (never narrower than their content), so a long hostname without `min-w-0` widens the whole page.
- Horizontal scrolling belongs to the element that needs it (`overflow-x-auto` on the log body, the hero terminal and the architecture tab list), never to `<body>`.
- Heights that depend on the screen use `dvh` (or the `h-log` tokens), never `vh`.

#### Touch

```css
/* A bigger tap area without changing how the button looks. */
@utility hit-area {
    position: relative;
    &::after { content: ""; position: absolute; inset: -0.5rem; }
}
```

- Icon-only buttons add `pointer-coarse:hit-area` (or `pointer-coarse:size-11` where the larger visual is fine).
- `components/ui/input.tsx` (and the `Select` trigger) add `pointer-coarse:text-base` to their base classes, so iOS doesn't zoom the page on focus. It wins over a caller's `text-[13px]` because Tailwind emits variant classes after plain ones.
- Tooltip-only information gets a visible twin under `pointer-coarse:block hidden` (see `DeploymentHeader`).

---

## 5. Shared logic — `lib/`

### 5.1 Stages — `lib/stages.ts`

```ts
import { isTerminal, type DeploymentStatus } from "@/api/types";

export const STAGES = ["queued", "cloning", "detecting", "building", "uploading", "ready"] as const;
export type Stage = (typeof STAGES)[number];
export type StageState = "done" | "current" | "failed" | "pending" | "skipped" | "final";

export function stageStates(status: DeploymentStatus, failedStage?: Stage | null): StageState[] {
  // `archived` was `ready` until retention deleted its files.
  if (status === "ready" || status === "archived") return STAGES.map((_, i) => (i === STAGES.length - 1 ? "final" : "done"));
  if (status === "failed" || status === "cancelled") {
    const at = STAGES.indexOf(failedStage ?? "queued");
    return STAGES.map((_, i) => (i < at ? "done" : i === at ? "failed" : "skipped"));
  }
  const at = STAGES.indexOf(status as Stage);
  return STAGES.map((_, i) => (i < at ? "done" : i === at ? "current" : "pending"));
}

export const isRunning = (s: DeploymentStatus) => !isTerminal(s) && s !== "queued";
```

`isTerminal` comes from `api/types.ts` (Phase 2), the one definition of "finished", which includes `archived`. Don't redefine it here.

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
| `input.tsx`, `select.tsx` (trigger) | Add `pointer-coarse:text-base` to the base classes. Mono inputs still pass `className="font-mono text-[13px]"`. | iOS zooms the page when an input under 16px is focused ([§4.9](#49-fluid-tokens-and-layout-utilities)) |
| `tabs.tsx` | none; the landing tabs use the default list style | |
| `sonner.tsx` | Import `useTheme` from `@/theme` instead of `next-themes`, and pass `theme={resolvedTheme}` | Toasts follow the app's own theme provider (§4.7) |

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
- **Renders:** sun or moon icon for `resolvedTheme`; menu with System / Light / Dark as a radio group bound to `theme` / `setTheme` from `useTheme()` (`@/theme`).
- **A11y:** `aria-label={t("theme.toggle")}`.

#### `AccountMenu` — `components/AccountMenu.tsx` (Phase 3)
- **Built from:** `Avatar` (GitHub `avatarUrl`, initials fallback) as the `DropdownMenu` trigger.
- **Items:** login name (label), `GitHub profile ↗`, Theme submenu (same as `ThemeToggle`, then drop the separate toggle), separator, `Log out` → `POST /auth/logout`, clear the query cache, navigate to `/`.

#### `PageHeader` — `components/PageHeader.tsx`
- **Props:** `breadcrumb?: { label: string; to?: string }[]`, `label?: string` (mono section label, rendered as `// LABEL`), `title: ReactNode`, `description?: ReactNode`, `actions?: ReactNode`.
- **Renders:** `Breadcrumb` → `SectionLabel` → `h1` (`text-page` on list pages; detail pages pass `size="detail"` for `text-page-detail`) → description in `text-muted-foreground`. `actions` sit bottom-right, `items-end`.
- **Mobile:** the title block and `actions` are siblings in `flex flex-wrap items-end justify-between gap-4`, with the title block `min-w-0 grow basis-80`. When both don't fit on one line, the actions wrap under the title; no breakpoint.

#### `SectionLabel` — `components/SectionLabel.tsx`
- **Props:** `children`, `tone?: "primary" | "destructive" | "warning"`.
- **Renders:** `font-mono text-xs tracking-[0.14em] uppercase`, prefixed with `// `, colour `text-primary-text` (or the status `-foreground` token for the tone).

#### `DisplayHeading` — `components/DisplayHeading.tsx`
- **Props:** `as?: "h1" | "h2"`, `line1: ReactNode`, `line2: ReactNode`, `size: "hero" | "display" | "section" | "page" | "error"`, `accent?: boolean` (second line in `text-primary-text` instead of muted), `inline?: boolean` (second line follows the first instead of starting a new line).
- **Renders:** the heading gets the size's fluid token (`text-hero`, `text-display`, `text-section`, `text-page`, `text-error`); Sora first line, `font-serif-accent` second line in a `<span className="block text-[1.15em]">`, so it scales with the first. With `inline` the span is `inline` instead of `block`, so it sits after the first line and wraps under it only when it doesn't fit; New project and the Architecture and Compare section headings use this. Used by the landing sections, auth, error screens and New project.

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
- **Renders:** dot + translated word, lowercased by the pill's `lowercase` class. `live` renders the solid primary pill ("live") and ignores `status`. `"none"` renders "no deployments" in the queued style.
- **Mapping:** one `const STYLE: Record<DeploymentStatus, string>` from [ui-design §3](ui-design.md#statusbadge), including `archived`, which the `Record` type forces; running statuses add `motion-safe:animate-pulse-soft` to the dot.
- **i18n:** `status.<name>` (already in `common.json`, capitalised because `StepTracker` labels share them), plus new `status.live` and `status.none`.

#### `StepTracker` — `components/StepTracker.tsx`
- **Props:** `status: DeploymentStatus`, `failedStage?: Stage | null`.
- **Renders:** `stageStates()` (§5.1) → six `Stage` items (circle + label) with `Connector` lines between them. Wrap in a `DoubleCard` at the call site.
- **A11y:** an `<ol>`; each item has a visually hidden state ("done", "in progress", "failed", "not started", "skipped"); the current one gets `aria-current="step"`.
- **Mobile:** labels for all but current/failed are `sr-only`.

#### `CopyButton` — `components/CopyButton.tsx`
- **Props:** `value: string | (() => string)`, `label: string` (used for `aria-label` and the tooltip), `size?: "icon-sm" | "sm"`.
- **Touch:** `pointer-coarse:hit-area` for a 44px tap area at the same visual size.
- **Behaviour:** `navigator.clipboard.writeText`; on success swap the icon to a check for 1.5s and announce "Copied" through an `aria-live="polite"` span. If the Clipboard API is missing (non-secure context), fall back to a hidden `<textarea>` + `document.execCommand("copy")`.

### 6.4 Logs

#### `LogTerminal` — `components/log/LogTerminal.tsx`
- **Props:** `lines: string[]`, `state: "streaming" | "finished" | "archived"`, `errorLine?: number`, `size?: "live" | "default"` (`h-log-live` / `h-log`: up to 470px / 420px, shrinking with the screen height), `onDownload?: () => void`.
- **Mobile:** the font size and 23px rows stay fixed at every width; long lines scroll sideways inside the body (`overflow-x-auto`). The toolbar's line count and state hide below `@sm` of the pane (`@container` on the frame); the buttons stay.
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
- **Layout:** cards sit in `grid-fluid-80 gap-5`. The card root is `@container`: the footer is one row from `@sm`, and below that branch/time sit above the buttons. Name and hostname are `min-w-0 truncate`.

#### `ProjectSearch` and `SortSelect` — `features/projects/`
- **ProjectSearch:** `Input` with an inset search icon, bound to `?q=`; updates the URL on a 250ms debounce with `replace: true` and resets `page`. `Esc` clears.
- **SortSelect:** `Select` bound to `?sort=` (`updated` | `name` | `created`), trigger reads "Sort  Recently updated".
- **Hook:** `useListParams()` wraps `useSearchParams` and returns typed `{ page, q, sort }` with setters, so the page never parses the URL itself.

#### `ProjectPagination` — `features/projects/ProjectPagination.tsx`
- **Built from:** shadcn `Pagination`, `PaginationContent`, `PaginationItem`, `PaginationLink`, `PaginationPrevious`, `PaginationNext`, `PaginationEllipsis`.
- **Props:** `page`, `pageSize`, `total`.
- **Renders:** "Showing 1–12 of 48 projects" on the left; `paginationRange()` (§5.4) on the right. Links are real `<Link to="?page=n">` so middle-click and back work. `null` when `total <= pageSize`.
- **Narrow:** the root is `@container`. Below `@md` the numbered links are hidden and a "Page 2 of 4" label sits between Previous and Next; the "Showing…" line wraps above. Links get `pointer-coarse:hit-area`.

#### `RepoUrlField`, `DetectionPanel`, `BuildSettings`, `NextStepsCard` — `features/projects/new/`
- **Form state:** one `useReducer` (or React Hook Form if you add it) with fields `repoUrl, branch, rootDir, installCmd, buildCmd, outputDir, slug, spaFallback`. `detect` results fill empty or untouched command fields only; don't overwrite what the user typed.
- **`RepoUrlField`:** `Field` + `Label` + mono `Input` with a GitHub icon; `onBlur` triggers `useDetect` when the URL parses. Phase 3 swaps it for a repo picker `Select`.
- **`DetectionPanel`** props: `state: "idle" | "detecting" | "done" | "error"`, `result?: DetectResult`, `error?`. Done: framework line + `Badge variant="secondary"` chips + one `Alert variant="warning"` per warning. Error: a muted line "Couldn't detect the framework; fill in the settings below." (the `Collapsible` opens).
- **Layout:** the page is `flex flex-col lg:flex-row` with `NextStepsCard` `lg:w-80 lg:shrink-0` (a structural `lg` breakpoint, [ui-design §7.4](ui-design.md#74-layout-rules)). The form card is `@container`; Branch + Root directory sit side by side from `@sm`, stacked below. The footer is `flex flex-wrap-reverse gap-2` with `Create & deploy →` `grow sm:grow-0`.
- **`BuildSettings`:** `Collapsible` (open when there are warnings or detection failed) with a grid of fields, one column below `@lg` and two from `@lg`; the subdomain field is an input group with a fixed suffix (`.{BASE_DOMAIN}`); `Checkbox` for SPA fallback.
- **Field errors:** a `fieldErrors` map from the create mutation's `ApiError` (`api.slug_taken` and `api.slug_invalid` → `slug`, `api.repo_unsupported` → `repoUrl`, `api.validation_failed` → its `params.field`). `api.invalid_root_dir` comes from `useDetect`, not create, and goes under Root directory the same way; set `aria-invalid` and render the message under the field. Anything unmapped goes in a destructive `Alert` above the footer.
- **`NextStepsCard`:** static, four numbered steps; i18n keys `newProject.next.1..4`.

#### `ProjectSummary` — `features/projects/ProjectSummary.tsx`
- **Props:** `project: ProjectDetail`.
- **Renders:** `DoubleCard` with name, repo link, branch badge, "Live at" line (glowing dot), actions (`Visit site ↗`, `Deploy now`) and a stat row (`SectionLabel`-style keys, mono values): `activeDeployment.commitSha`, `activeDeployment.framework` ("—" when null), the newest row's `createdAt`, and `deploymentCount`.
- **Layout:** the card is `@container`. Stats are `grid-cols-2 @xl:grid-cols-4`. The name block and actions use the `PageHeader` wrap pattern; the two buttons share the row (`grow`) when they wrap. Repo URL and hostname are `min-w-0 truncate`.

#### `DeploymentsTable` and `DeploymentRowActions` — `features/projects/`
- **Built from:** shadcn `Table` inside a `DoubleCard` with a header block.
- **Props:** `projectId`, `activeDeploymentId`, `pages` from `useDeployments`.
- **Two views, one data source:** the card body is `@container`. It renders the `<Table>` with `hidden @2xl:table` and a stacked `<ul>` with `@2xl:hidden`, both mapping the same rows through `rowAction()` ([§4.9](#49-fluid-tokens-and-layout-utilities) explains why not CSS-reflow the table). Each stacked item: line 1 SHA + `StatusBadge` + `…` menu; line 2 commit message (`truncate`); line 3 relative time · duration, then the row action. The live item keeps the inset primary left edge.
- **Row action logic** (keep it in one pure function so it's testable):

```ts
function rowAction(d: Deployment, active: Deployment | undefined): "view-logs" | "promote" | "rollback" | "live" | null {
  if (d.id === active?.id) return "live";
  if (d.status === "ready") return active && d.createdAt < active.createdAt ? "rollback" : "promote";
  if (d.status === "failed" || isRunning(d.status)) return "view-logs";
  return null;
}
```

- **Row menu:** `DropdownMenu` on `…` with "Delete deployment" (`useDeleteDeployment`); disabled on the live row and on queued or running rows (`api.delete_active`, `api.deployment_in_progress`), with the reason as a second line in the item (tooltips don't open on touch). Delete asks for confirmation in the menu itself (a second "Click again to delete" item state), not a dialog.
- **Live row:** `data-live` on the `<tr>` → `shadow-[inset_2px_0_0_var(--primary)]` on the first cell.
- **Footer:** `Load older deployments` calls `fetchNextPage`; hidden when `!hasNextPage`.

### 6.6 Deployments

#### `DeploymentHeader` — `features/deployments/DeploymentHeader.tsx`
- **Props:** `deployment`, `project`.
- **Renders:** breadcrumb, commit message as h1 (fallback "Deployment `{sha}`"), chips (SHA, branch, framework), started/finished time, live duration (`useNow(1000)` while running), `StatusBadge size="md"`, and `Redeploy` when failed (with the "Builds the latest commit on `{branch}`" tooltip).
- **Mobile:** the h1 uses `text-page-detail break-words`; chips and times are one `flex flex-wrap` row; title block and status/actions use the `PageHeader` wrap pattern, so the badge drops under the title when space runs out. The Redeploy tooltip text is repeated as a muted line under the button with `hidden pointer-coarse:block`, since tooltips don't open on touch.

#### `BuildFailedAlert` — `features/deployments/BuildFailedAlert.tsx`
- **Built from:** `Alert variant="destructive"`.
- **Props:** `deployment`, `errorLine?: { index: number; text: string }`, `onJump: () => void`.
- **Renders:** title from `formatUserMessage(i18n, { code: errorCode, params: errorParams }, error)`, one sentence of guidance, the offending line in a dark mono box, `Jump to error` (calls `LogTerminal`'s `scrollToLine`) and `Copy error` (`CopyButton size="sm"`).

#### `DeploymentUrls` — `features/deployments/DeploymentUrls.tsx`
- **Props:** `deployment`, `project`.
- **Renders:** `DoubleCard tone="primary"` with two `UrlRow`s: Preview (`<deploymentId>.<BASE_DOMAIN>`) and Production (`<slug>.<BASE_DOMAIN>`). The production row shows "Currently serving `{sha}`, an older build." + `Promote to production`, or a solid `live` badge when this deployment is live.
- **`UrlRow`** props: `label`, `href`, `hint`, `action?`. Mono label, mono link, `CopyButton`, muted hint, trailing action.
- **Layout:** the card is `@container`. From `@xl` each row is one line; below it, label + `CopyButton`, then the hostname (`min-w-0 truncate`, full value in `title`), the hint, and the action at full width. A preview hostname is a 25-character id plus the domain (35+ characters), which fits a 390px phone with `.localhost` but truncates on narrower screens and with longer domains.

### 6.7 Landing

All landing components live in `features/landing/`. Copy comes from `common.json` (`landing.*` keys), not hard-coded strings.

| Component | Props | Notes |
|---|---|---|
| `MarketingNav` | — | Anchor links scroll smoothly (`scroll-behavior: smooth` on `html`, `scroll-margin-top` on sections). `Open dashboard` is `Button variant="inverse" size="sm"` linking to `/projects`. Below `md` the links and `GitHub` move into a `DropdownMenu` behind a menu icon button (`aria-label`); logo and `Open dashboard` stay. |
| `Hero` | — | `GlowBackdrop dots`, outline `Badge` with pulsing dot, `DisplayHeading size="hero" accent` with the SVG underline (absolutely positioned under line 2, which is `inline-block whitespace-nowrap` so the underline always spans one line), two `Button size="xl"` in `flex flex-wrap gap-3` with `grow basis-48` (side by side when both fit, stacked otherwise), `TerminalPreview`, framework `Badge`s in `flex flex-wrap`. |
| `TerminalPreview` | `lines: LogLine[]`, `title`, `status` | Static, always dark (`className="dark"`), `w-full max-w-225`; lines scroll sideways inside on narrow screens. Corner brackets are four 12px absolutely positioned L-shapes in `border-primary`. Optional: reveal lines one by one with `motion-safe` when it scrolls into view (`IntersectionObserver`), like the reference. |
| `FeatureCard` | `icon`, `title`, `description`, `roadmap?: boolean` | `DoubleCard`; `roadmap` adds the outline `Roadmap` badge top-right. Laid out in `grid-fluid-60 gap-4`. Data array in `features.data.ts`. |
| `ArchitectureSection` | — | See §7.4. |
| `CompareCard` | `versus`, `criticism`, `answer` | `DoubleCard` split in two; bottom half `bg-primary/6`. Laid out in `grid-fluid-72 gap-4`. |
| `CtaSection` | — | Centred `DisplayHeading size="display"`, two `Button size="xl"` (same wrap pattern as `Hero`), radial glow behind. |
| `MarketingFooter` | — | Logo line, ghost links, © year from `new Date().getFullYear()`. `flex flex-wrap`; the © line goes last. |

Every landing section is `<section className="py-section"><div className="mx-auto max-w-6xl px-gutter">…</div></section>`, with section headings as `DisplayHeading size="section"`.

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

- **Batch incoming lines.** Phase 2's `useLogStream` already buffers lines and writes them to the Zustand log store once per animation frame, so an `npm install` doesn't re-render once per line. The core of it:

```ts
const pending: LogEntry[] = [];
let frame = 0;
const flush = () => { frame = 0; append(deploymentId, pending.splice(0)); };   // the store de-dupes by id
events.onmessage = (e) => { pending.push({ id: Number(e.lastEventId), line: e.data }); frame ||= requestAnimationFrame(flush); };
```

Components read lines with `useLogLines(deploymentId)`; `LogLine` rows can select a single line from the store so appending re-renders only the new row.

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
- **Below `md`: a list, not the diagram.** The diagram card is `hidden md:block`; a `md:hidden` list renders the selected step's nodes in order from the same `NODES`/`EDGES` data (icon, name, mono subtitle; between items, a short vertical line with the edge label). The `TabsList` gets `overflow-x-auto` so all five triggers stay reachable. `Overview` shows every service grouped by zone.
- **Rendering:** a `relative` box of fixed size 1130×540 inside `overflow-x-auto`. Zones and nodes are absolutely positioned divs (`style={{ left: x, top: y }}`), so they can use tokens and `DoubleCard`-like classes. Edges are `<path>`s in one `<svg>` under the nodes, with `className={cn("stroke-foreground/28 transition-[stroke]", lit && "stroke-primary motion-safe:animate-flow [stroke-dasharray:6_6]")}`. Edge labels are absolutely positioned chips.
- **Arrowheads:** one `<marker>` with `fill="context-stroke"` follows the edge colour in current browsers. If you need older Safari, define two markers (neutral and primary) and switch `markerEnd` with the lit state.
- **Dimming:** unlit nodes, edges and labels get `opacity-35` only when a step is selected.
- **A11y:** the diagram is decorative (`aria-hidden`); the detail card under it carries the same information as text, and the tabs are real `Tabs` with keyboard support.
- **Lit nodes:** a step's `services` plus the endpoints of its lit edges. Step 03 lights Dashboard this way (the end of `API → Dashboard`, the SSE stream) without listing it as a service, which matches the mockup.
- **Test:** for each step, assert that every service has a lit node, and that every lit node is a service or the endpoint of one of the step's edges, so the copy and the highlight stay consistent.

### 7.5 Promote with undo

```ts
onMutate: async (deploymentId) => {
  await qc.cancelQueries({ queryKey: queryKeys.project(projectId) });
  const prev = qc.getQueryData<ProjectDetail>(queryKeys.project(projectId));
  qc.setQueryData(queryKeys.project(projectId), { ...prev!, activeDeploymentId: deploymentId });
  return { prevId: prev?.activeDeploymentId };
},
onError: (_e, _id, ctx) => qc.setQueryData(queryKeys.project(projectId), (p) => p && { ...p, activeDeploymentId: ctx?.prevId ?? null }),
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
| Theme provider | Vitest + Testing Library: the choice persists; a `storage` event (another tab) updates it; a `matchMedia` change moves `system`; `<ForcedTheme>` wins and clears on unmount; the no-transition style is added and then removed; `data-theme` mode sets the attribute instead of the class |
| Theme script | Vitest with `jsdom`: evaluate `themeScript(config)` with each stored value (none, `light`, `dark`, `system`, garbage, storage throwing) and a forced route, and assert the `<html>` class and `color-scheme` |
| Theme, by eye | Reload with each stored value and system setting: no flash; the terminal stays dark in light mode |
| Architecture data consistency | Unit test: every service is lit, and every lit node is a service or an endpoint of a lit edge (§7.4) |
| Router 404 | Unit test: host is escaped, no external requests in the HTML, status 404 |
| Pages end to end | The Phase 2 checklist, run by hand against Compose; later Playwright with screenshots in light and dark |
| Accessibility | `@axe-core/react` in development, or axe in Playwright, on each page in both themes |
| Fluid layout | Playwright, each page at 320, 390, 768, 1024, 1280 and 1440px wide: assert `document.documentElement.scrollWidth <= innerWidth` (no sideways page scroll) and take a screenshot per width. While building, find the culprit in the console: `[...document.querySelectorAll("*")].filter(el => el.getBoundingClientRect().right > innerWidth)` |
| Touch | Chrome DevTools device mode (it emulates `pointer: coarse`); on a real iPhone, check that focusing an input doesn't zoom the page |

---

## 9. Build order

The same order as [ui-design §9](ui-design.md#9-build-order), with the pieces from this file:

1. **Foundation:** dependencies (§2), tokens and helpers (ui-design §2, §4.8 here), fluid tokens and layout utilities (§4.9), `src/theme` (provider, `ForcedTheme`, script and its Vite plugin), providers, router, layouts, API client with `NetworkError` and `deleteDeployment`, query hooks.
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
- [ ] Theme: no flash on reload, changes in one tab reach the others, switching doesn't animate, `next-themes` is no longer a dependency
- [ ] Fluid sizes come from the `@theme` tokens; no `text-[clamp(...)]` or fixed `w-[NNNpx]` for large blocks in components
- [ ] `md:`/`lg:` appear only for the structural changes in ui-design §7.4; components rearrange with `@container`
- [ ] The no-sideways-scroll check passes at every width in §8
