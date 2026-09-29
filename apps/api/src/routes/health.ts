import { prisma } from "@shipyard/db";
import { Router } from "express";
import { redis } from "../lib/clients";

export const health = Router();

health.get("/", async (_req, res) => {
  // Checked in parallel and independently: allSettled never rejects, so one
  // dependency being down cannot hide the state of the other. A rejection is
  // the signal, not an error to surface.
  const [dbPing, redisPing] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);
  const checks = {
    db: dbPing.status === "fulfilled",
    redis: redisPing.status === "fulfilled" && redisPing.value === "PONG",
  };
  const ok = checks.db && checks.redis;
  res.status(ok ? 200 : 503).json({ ok, ...checks });
});
