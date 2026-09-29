import express from "express";
import pinoHttp from "pino-http";
import type { ObjectReader } from "@shipyard/shared/storage";
import type { Resolver } from "./resolve.js";
import { serveDeployment } from "./serve.js";

export interface RouterDeps {
  store: ObjectReader;
  resolve: Resolver;
  logLevel?: string;
}

export function createApp({ store, resolve, logLevel = "info" }: RouterDeps) {
  const app = express();

  // Caddy terminates TLS in front of this process, so req.protocol and req.ip
  // have to come from the forwarded headers rather than the socket.
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(pinoHttp({ level: logLevel }));

  // Double-underscored because this process serves arbitrary user sites on
  // wildcard subdomains: a bare /health would shadow that path in every deployed
  // site. Compose's healthcheck for `router` must target this exact path.
  app.get("/__health", (_req, res) => res.json({ ok: true }));

  app.use(async (req, res, next) => {
    try {
      const target = await resolve(req.hostname.toLowerCase());
      if (!target)
        return res
          .status(404)
          .type("html")
          .send(`<!doctype html><h1>No site deployed at ${req.hostname}</h1>`);
      await serveDeployment(store, target, req, res);
    } catch (e) {
      next(e);
    }
  });

  return app;
}
