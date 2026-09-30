import { Queue, type ConnectionOptions } from "bullmq";
import type { BuildJob } from "./types/queueTypes";
import { BUILD_QUEUE } from "./constants";

// types/ isn't in the package's exports; consumers get this through the
// `@shipyard/shared/queue` subpath.
export type { BuildJob } from "./types/queueTypes";

/**
 * Turns a Redis URL into the connection options BullMQ expects.
 *
 * Pass the result, not a shared ioredis client, to every `Queue` and `Worker`:
 * BullMQ then opens and manages its own connections, including the blocking
 * ones a `Worker` needs.
 *
 * Sets `maxRetriesPerRequest: null`, which BullMQ requires for `Worker`
 * connections: a blocking wait for the next job must not fail just because
 * Redis took a while to reconnect.
 *
 * Reads only the host, port (default `6379`) and password. The username, the
 * database number (`/<db>`) and TLS (`rediss://`) are ignored.
 *
 * @param url - A `redis://` URL, normally `env.REDIS_URL`.
 *
 * @example
 * new Worker<BuildJob>(BUILD_QUEUE, handler, { connection: connectionFromUrl(env.REDIS_URL) });
 */
export function connectionFromUrl(url: string): ConnectionOptions {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    password: parsed.password || undefined,
    maxRetriesPerRequest: null,
  };
}

/**
 * Creates the producer side of the build queue, used by the API to enqueue builds.
 *
 * Job defaults:
 * - `attempts: 1`: a failed build is never retried automatically; the user redeploys.
 * - `removeOnComplete: 1000` / `removeOnFail: 5000`: only the most recent jobs are
 *   kept in Redis, for debugging. The deployment row is the lasting record.
 *
 * Create one per service (in its `lib/clients.ts`) and share it, and attach an
 * `error` listener there. BullMQ reconnects on its own; without a listener it
 * prints every connection error with `console.error`, bypassing the service's logger.
 *
 * @param redisUrl - A `redis://` URL, normally `env.REDIS_URL`.
 *
 * @example
 * export const buildQueue = createBuildQueue(env.REDIS_URL);
 * buildQueue.on("error", (err) => log.error({ err }, "build queue error"));
 *
 * // Using the deployment id as the job id means adding the same deployment twice doesn't queue it twice.
 * await buildQueue.add("build", { deploymentId: deployment.id }, { jobId: deployment.id });
 */
export function createBuildQueue(redisUrl: string) {
  return new Queue<BuildJob>(BUILD_QUEUE, {
    connection: connectionFromUrl(redisUrl),
    defaultJobOptions: {
      attempts: 1,
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}
