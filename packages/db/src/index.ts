import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client";

// `globalThis` is the one object that outlives module re-evaluation within a
// single process, so stashing the client there keeps repeated imports from each
// opening their own pg pool. Note this does NOT survive `tsx watch`, which
// restarts the process outright — it guards in-process re-imports (vitest
// --watch, or the package resolving through two paths).
// The double assertion is compile-time only: globalForPrisma IS globalThis.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createPrismaClient() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Copy .env.example to .env at the repo root.",
    );
  }
  return new PrismaClient({
    // Prisma 7 ships no pool of its own; the adapter owns the pg connections.
    adapter: new PrismaPg({ connectionString }),
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;

export * from "../generated/prisma/client";
