import Docker from "dockerode";
import pino from "pino";
import { loadEnv } from "@shipyard/shared/env";
import { Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
import { z } from "zod";

/**
 * The worker's validated environment: the shared base variables plus the
 * build settings below. Starting with an invalid value exits the process.
 */
export const env = loadEnv({
  BUILD_CONCURRENCY: z.coerce.number().default(2),
  BUILD_TIMEOUT_MS: z.coerce.number().default(15 * 60_000),
  BUILD_MEMORY_BYTES: z.coerce.number().default(2 * 1024 ** 3),
  BUILD_CPUS: z.coerce.number().default(2),
  BUILD_PIDS_LIMIT: z.coerce.number().int().positive().default(512),
  // Docker tmpfs size: a number with a k/m/g unit, e.g. "512m".
  BUILD_TMP_SIZE: z
    .string()
    .regex(/^\d+[kmg]$/)
    .default("1g"),
  BUILDS_DIR: z.string().default("/builds"), // path inside the worker container
  BUILDS_HOST_PATH: z.string(), // same directory as seen by the Docker daemon
  BUILD_NETWORK: z.string().default("shipyard_build_egress"),
  // Egress proxy for builds, e.g. http://build-proxy:3128. The build network is
  // `internal`, so without it builds have no internet access at all.
  BUILD_HTTP_PROXY: z.url().optional(),
  BUILDER_IMAGE_PREFIX: z.string().default("shipyard/builder:node"),
});

/** The worker's logger. For build output shown to users, use `BuildLogger`. */
export const log = pino({ level: env.LOG_LEVEL });
/** Object storage that deployments are uploaded to. */
export const storage: ObjectStore = new Storage(env);
/** Shared Redis connection, for build logs, status events and the route cache. */
export const redis = createRedis(env.REDIS_URL);
// ioredis reconnects on its own; without a listener it prints every
// connection error with console.error, bypassing the logger.
redis.on("error", (err) => log.error({ err }, "redis error"));
/**
 * The host's Docker daemon, through the socket mounted into the worker
 * container. Build containers it creates are siblings of the worker, so bind
 * mounts must use host paths (`BUILDS_HOST_PATH`), not worker paths.
 */
export const docker = new Docker({ socketPath: "/var/run/docker.sock" });
