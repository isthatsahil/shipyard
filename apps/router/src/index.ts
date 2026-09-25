import express from "express";
import pinoHttp from "pino-http";

import { env } from "./lib/clients.js";

const app = express();

// Caddy terminates TLS in front of this process, so req.protocol and req.ip
// have to come from the forwarded headers rather than the socket.
app.disable("x-powered-by");
app.set("trust proxy", true);

app.use(pinoHttp({ level: env.LOG_LEVEL }));

// Double-underscored because this process serves arbitrary user sites on
// wildcard subdomains: a bare /health would shadow that path in every deployed
// site. Compose's healthcheck for `router` must target this exact path.
app.get("/__health", (_req, res) => res.json({ ok: true }));

// Placeholder until Phase 1 adds host resolution and object-storage serving.
app.use((req, res) =>
  res.status(404).type("text").send(`No deployment for ${req.hostname}`),
);

export default app;
