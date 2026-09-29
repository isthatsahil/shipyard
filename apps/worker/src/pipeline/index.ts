import fs from "node:fs/promises";
import path from "node:path";
import { prisma } from "@shipyard/db";
import {
  BuildCancelledError,
  RootDirError,
  toUserMessage,
} from "@shipyard/shared/errors";
import { env, log, storage } from "../lib/clients.js";
import { BuildLogger } from "../lib/logs.js";
import { isInside } from "../lib/paths.js";
import { setStatus } from "../lib/status.js";
import type { BuildContext } from "./context.js";
import { clone } from "./clone.js";
import { detect } from "./detect.js";
import { build } from "./build.js";
import { resolveOutput } from "./resolveOutput.js";
import { upload } from "./upload.js";
import { promote } from "./promote.js";

/**
 * Runs one deployment's build: clone → detect → build → find output → upload
 * → promote, updating its status at each stage.
 *
 * Never throws for a build problem: any error marks the deployment `failed`
 * (or `cancelled`) with a translatable error code, and is written to the
 * build log. The work folder is always deleted at the end.
 *
 * Does nothing if the deployment isn't `queued`, e.g. when a job is delivered
 * twice or the deployment was cancelled while waiting.
 *
 * @param deploymentId - The deployment to build.
 * @param signal - Aborting it cancels the build.
 */
export async function runPipeline(deploymentId: string, signal: AbortSignal) {
  const deployment = await prisma.deployment.findUniqueOrThrow({
    where: { id: deploymentId },
    include: { project: true },
  });
  if (deployment.status !== "queued") {
    log.warn(
      { deploymentId, status: deployment.status },
      "skipping non-queued job",
    );
    return;
  }

  const logger = new BuildLogger(deploymentId);
  const workDir = path.join(env.BUILDS_DIR, deploymentId);
  const ctx: BuildContext = {
    deployment,
    project: deployment.project,
    store: storage,
    workDir,
    hostWorkDir: path.join(env.BUILDS_HOST_PATH, deploymentId),
    repoRoot: path.resolve(workDir, deployment.project.rootDir),
    envVars: [],
    logger,
    signal,
  };

  const startedAt = Date.now();
  try {
    // Inside the try, so a bad rootDir marks the deployment failed like any other build error.
    if (!isInside(workDir, ctx.repoRoot))
      throw new RootDirError(deployment.project.rootDir);
    await setStatus(deploymentId, "cloning", { startedAt: new Date() });
    await clone(ctx);
    await setStatus(deploymentId, "detecting");
    await detect(ctx);
    await setStatus(deploymentId, "building");
    await build(ctx);
    await resolveOutput(ctx);
    await setStatus(deploymentId, "uploading");
    await upload(ctx);
    await promote(ctx);
    logger.line(
      "done",
      `Completed in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
    );
  } catch (e) {
    const status = e instanceof BuildCancelledError ? "cancelled" : "failed";
    const { code, params, fallback } = toUserMessage(e);
    log.error({ err: e, deploymentId }, "pipeline failed");
    // Build logs stay English; the dashboard translates errorCode/errorParams.
    logger.line("error", fallback);
    await setStatus(deploymentId, status, {
      error: fallback,
      errorCode: code,
      errorParams: params,
      finishedAt: new Date(),
    }).catch(() => {});
  } finally {
    await logger.flush();
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
