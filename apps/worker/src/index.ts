/**
 * Worker entry point: takes build jobs from the queue and runs each through
 * the pipeline, up to `BUILD_CONCURRENCY` at a time. Exits at once if the
 * Docker socket isn't mounted.
 */
import { Worker } from "bullmq";
import { BUILD_QUEUE } from "@shipyard/shared/constants";
import { connectionFromUrl, type BuildJob } from "@shipyard/shared/queue";
import { env, log, docker } from "./lib/clients.js";
import { runPipeline } from "./pipeline/index.js";

await docker.ping(); // fail fast if the socket is not mounted

/**
 * BullMQ worker for the build queue. Each job carries a `deploymentId` and is
 * handed to {@link runPipeline}. The lock lasts the build timeout plus a
 * 60s grace period, so a slow build isn't marked stalled and retried
 * while it's still running.
 */
const worker = new Worker<BuildJob>(
  BUILD_QUEUE,
  async (job) => {
    const controller = new AbortController();
    log.info({ deploymentId: job.data.deploymentId }, "build started");
    await runPipeline(job.data.deploymentId, controller.signal);
  },
  {
    connection: connectionFromUrl(env.REDIS_URL),
    concurrency: env.BUILD_CONCURRENCY,
    lockDuration: env.BUILD_TIMEOUT_MS + 60_000,
  },
);

worker.on("failed", (job, err) =>
  log.error({ jobId: job?.id, err }, "job failed"),
);
worker.on("error", (err) => log.error({ err }, "worker error"));

/**
 * Graceful shutdown on SIGTERM/SIGINT. `worker.close()` waits for in-flight
 * jobs to finish before the process exits.
 */
const shutdown = async () => {
  log.info("shutting down");
  await worker.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
log.info({ concurrency: env.BUILD_CONCURRENCY }, "worker ready");
