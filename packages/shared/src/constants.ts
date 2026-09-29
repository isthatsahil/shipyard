/**
 * Platform-wide constants shared by more than one service.
 * Add new ones here rather than repeating the value where it's used.
 */

/**
 * How long a build log stays in Redis. Older logs are read from the archived
 * `_logs.txt` in object storage instead.
 */
export const LOG_TTL_SECONDS = 24 * 60 * 60;

/**
 * How long the router caches a route target. Promoting or deleting deployments
 * deletes the key directly, so this only limits how long a missed invalidation
 * can go unnoticed.
 */
export const ROUTE_TTL_SECONDS = 60;

/**
 * Name of the BullMQ queue the API adds builds to and the worker takes them from.
 * Both sides must use this constant; a typo on either side means jobs are
 * added to a queue nobody reads.
 */
export const BUILD_QUEUE = "builds";

/**
 * Pattern a slug must match: 3–40 characters of lowercase letters, digits
 * and hyphens, starting and ending with a letter or digit.
 */
export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;

/**
 * Shape of a deployment id (a Prisma cuid). The router serves
 * `<deploymentId>.<BASE_DOMAIN>` as a preview of that deployment, so no slug
 * may have this shape, or the two kinds of hostname would be ambiguous.
 */
export const DEPLOYMENT_ID_RE = /^c[a-z0-9]{20,30}$/;

/** Slugs that are not allowed because they clash with system subdomains. */
export const RESERVED = new Set([
  "api",
  "app",
  "www",
  "admin",
  "mail",
  "ftp",
  "ns1",
  "ns2",
  "status",
  "docs",
  "cdn",
  "static",
  "assets",
]);
