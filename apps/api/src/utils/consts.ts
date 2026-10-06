export const GITHUB_RE =
  /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i;

export const TERMINAL = new Set(["ready", "failed", "cancelled", "archived"]);

export const CLONE_TIMEOUT_MS = 20_000;

/** The live deployment's fields the dashboard shows next to a project. */
export const ACTIVE_DEPLOYMENT = {
  select: {
    id: true,
    status: true,
    commitSha: true,
    framework: true,
    createdAt: true,
    finishedAt: true,
  },
} as const;

/** `orderBy` for each `sort` option; the client picks a name, never a column. */
export const PROJECT_ORDER = {
  updated: { updatedAt: "desc" },
  name: { name: "asc" },
  created: { createdAt: "desc" },
} as const;
