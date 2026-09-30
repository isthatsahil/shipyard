import express from "express";
import pinoHttp from "pino-http";
import { log } from "./lib/clients.js";
import { projects } from "./routes/projects.js";
import { deployments } from "./routes/deployment.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { health } from "./routes/health.js";

const app = express();
app.use(pinoHttp({ logger: log }));
app.use(express.json({ limit: "1mb" }));

// Routes mount flat, as every phase doc writes them — no /v1 prefix. There is
// no compatibility boundary to version across: the dashboard ships in this
// repo and deploys in the same stack. If the Phase 6 CLI ever lands, add the
// prefix then and change the one BASE constant on the dashboard side.
app.get("/health", health);

app.use("/projects", projects);
app.use("/deployments", deployments);

// Order matters: notFound after every router, errorHandler last.
app.use(notFound);
app.use(errorHandler);

export default app;
