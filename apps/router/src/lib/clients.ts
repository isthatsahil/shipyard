import { loadEnv } from "@shipyard/shared/env";
import { createLogger } from "@shipyard/shared/logger";
import { z } from "zod";
import { Storage, type ObjectStore } from "@shipyard/shared/storage";
import { createRedis } from "@shipyard/shared/redis";
// The single parsed env for this service. Phase 1 adds `storage` and `redis`
// here alongside it, so nothing in the entry point has to move.
export const env = loadEnv({ PORT: z.coerce.number().default(4001) });
export const log = createLogger("router", env.LOG_LEVEL);
export const storage: ObjectStore = new Storage(env);
export const redis = createRedis(env.REDIS_URL);
// ioredis reconnects on its own; without a listener it prints every
// connection error with console.error, bypassing the logger.
redis.on("error", (err) => log.error({ err }, "redis error"));
