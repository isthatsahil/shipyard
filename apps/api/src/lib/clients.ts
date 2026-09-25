import { loadEnv } from "@shipyard/shared/env";
import { z } from "zod";

export const env = loadEnv({ PORT: z.coerce.number().default(4000) });
