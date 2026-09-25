import { loadEnv } from "@shipyard/shared/env";
import { z } from "zod";

// The single parsed env for this service. Phase 1 adds `storage` and `redis`
// here alongside it, so nothing in the entry point has to move.
export const env = loadEnv({ PORT: z.coerce.number().default(4001) });
