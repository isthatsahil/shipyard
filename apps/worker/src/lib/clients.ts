import pino from "pino";
import { loadEnv } from "@shipyard/shared/env";

// Deliberately no schema extension yet. Phase 1 adds BUILD_CONCURRENCY,
// BUILDS_DIR, BUILDS_HOST_PATH and friends here — BUILDS_HOST_PATH has no
// default, so adding it before docker/compose.yaml supplies a real host path
// would make the worker refuse to boot.
export const env = loadEnv();

export const log = pino({ level: env.LOG_LEVEL });
