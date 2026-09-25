import express from "express";
import pinoHttp from "pino-http";

import { prisma } from "@shipyard/db";
import { env } from "./lib/clients.js";

const app = express();
app.use(pinoHttp({ level: env.LOG_LEVEL }));
app.use(express.json({ limit: "1mb" }));

// Routes mount flat, as every phase doc writes them — no /v1 prefix. There is
// no compatibility boundary to version across: the dashboard ships in this
// repo and deploys in the same stack. If the Phase 6 CLI ever lands, add the
// prefix then and change the one BASE constant on the dashboard side.
app.get("/health", async (_req, res) => {
  const checks = { db: false };
  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.db = true;
  } catch {
    /* an unreachable DB is the signal, not an error to surface */
  }
  const ok = checks.db;
  res.status(ok ? 200 : 503).json({ ok, ...checks });
});

export default app;
