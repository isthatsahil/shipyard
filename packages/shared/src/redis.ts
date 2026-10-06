import { Redis } from "ioredis";
import type { ICreateRedisOptions } from "./types/ICreateRedisOptions";

// types/ isn't in the package's exports; consumers get this through the
// `@shipyard/shared/redis` subpath.
export type { ICreateRedisOptions } from "./types/ICreateRedisOptions";

/**
 * Opens a Redis connection. Connects immediately and queues commands until the
 * server is ready.
 *
 * Create one regular connection per service (in its `lib/clients.ts`) and share
 * it. Subscribers are the exception: create one per subscription and `quit()` it
 * when done.
 *
 * Attach an `error` listener where you create it. ioredis reconnects on its own;
 * without a listener it prints every connection error with `console.error`,
 * bypassing the service's logger.
 *
 * @param url - A `redis://` or `rediss://` URL, normally `env.REDIS_URL`.
 *
 * @example
 * export const redis = createRedis(env.REDIS_URL);
 * redis.on("error", (err) => log.error({ err }, "redis error"));
 * const sub = createRedis(env.REDIS_URL, { subscriber: true });
 */
export function createRedis(
  url: string,
  { subscriber = false }: ICreateRedisOptions = {},
): Redis {
  return new Redis(url, { maxRetriesPerRequest: subscriber ? null : 3 });
}

/**
 * Every Redis key and pub/sub channel the platform uses, in one place.
 * Add new keys here rather than writing the string where it's used.
 */
export const keys = {
  /**
   * List of a deployment's build log lines (expires after `LOG_TTL_SECONDS` in
   * `constants.ts`), and the pub/sub channel each new line is also published on.
   */
  logs: (deploymentId: string) => `logs:${deploymentId}`,
  /** Pub/sub channel on which a deployment's status changes are published. */
  status: (deploymentId: string) => `status:${deploymentId}`,
  /**
   * Private pub/sub channel of one open log stream (one per SSE connection).
   * The API publishes markers on it to line its subscription up with its
   * replay; nothing else uses it.
   */
  logSync: (streamId: string) => `logsync:${streamId}`,
  /** Pub/sub channel the worker listens on to stop a running build. */
  cancel: (deploymentId: string) => `cancel:${deploymentId}`,
  /**
   * Router cache: JSON route target for a `<slug>.<BASE_DOMAIN>` host.
   *
   * The `v2` is the version of the cached JSON's shape (the router's
   * `Target`), not of the slug. Bump it whenever `Target` changes: the router
   * trusts cached values as-is, so the new code must not read entries in the
   * old shape. v2 added `storagePrefix`.
   */
  route: (slug: string) => `route:v2:${slug}`,
  /** Router cache: JSON route target for a custom domain. */
  routeHost: (hostname: string) => `route:host:${hostname}`,
  /** Session id → user id, with a sliding expiry. */
  session: (id: string) => `session:${id}`,
} as const satisfies Record<string, (id: string) => string>;
