import { loadEnv } from "@shipyard/shared/env";
import { createLogger } from "@shipyard/shared/logger";
import { Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
import { createBuildQueue } from "@shipyard/shared/queue";
import { z } from "zod";

export const env = loadEnv({ PORT: z.coerce.number().default(4000) });
export const log = createLogger("api", env.LOG_LEVEL);
export const storage: ObjectStore = new Storage(env);
export const redis = createRedis(env.REDIS_URL);
// ioredis reconnects on its own; without a listener it prints every
// connection error with console.error, bypassing the logger.
redis.on("error", (err) => log.error({ err }, "redis error"));

export const buildQueue = createBuildQueue(env.REDIS_URL);
// Same for BullMQ's own connections.
buildQueue.on("error", (err) => log.error({ err }, "build queue error"));
