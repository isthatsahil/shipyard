import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

// Prisma does not load .env itself. `prisma init` scaffolds a bare
// `import "dotenv/config"`, which resolves against the cwd (packages/db when
// run via `pnpm --filter @shipyard/db`); anchor on this file instead so the one
// repo-root .env is found no matter where the command is invoked from.
dotenv.config({ path: path.join(import.meta.dirname, "../../.env") });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  datasource: {
    // Deliberately optional: `prisma generate` builds the client from the schema
    // alone and must run without a database (e.g. inside a Docker build). The
    // CLI itself rejects a missing url for commands that connect (migrate, db,
    // studio). env() would throw at config load, failing every command instead.
    url: process.env.DATABASE_URL,
  },
});
