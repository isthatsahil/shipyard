import { prisma, type Deployment } from "@shipyard/db";
import { deploymentPrefix } from "@shipyard/shared/storageKeys";
import { buildQueue, log } from "../lib/clients.js";
import { HttpError } from "../lib/httpError.js";

/**
 * Creates a deployment for `projectId` and enqueues its build.
 *
 * The row is inserted and then given its `storagePrefix` in one
 * transaction, because the prefix is derived from the generated id. The
 * build job is added only after the transaction commits, so the worker
 * never picks up a deployment it cannot read.
 *
 * If enqueueing fails, the deployment is marked `failed` with
 * `errorCode: "api.enqueue_failed"` and its English text in `error`, and an
 * `HttpError(503, "api.enqueue_failed")` is thrown.
 *
 * @param projectId - Project the deployment belongs to.
 * @param meta - Optional commit details stored on the deployment.
 * @returns The created deployment, with `storagePrefix` set.
 */
export async function createDeployment(
  projectId: string,
  meta: { commitSha?: string; commitMsg?: string } = {},
): Promise<Deployment> {
  const deployment = await prisma.$transaction(async (tx) => {
    const created = await tx.deployment.create({
      data: { projectId, storagePrefix: "", ...meta },
    });
    return tx.deployment.update({
      where: { id: created.id },
      data: { storagePrefix: deploymentPrefix(created.id) },
    });
  });
  try {
    // jobId = deploymentId → enqueueing the same deployment twice is a no-op
    await buildQueue.add(
      "build",
      { deploymentId: deployment.id },
      { jobId: deployment.id },
    );
  } catch (err) {
    // No job was queued, so no worker will move this row out of `queued`.
    // Mark it failed so history shows it. HttpError answers 503 with the
    // reason, so log the Redis error here or it is lost.
    log.error({ err, deploymentId: deployment.id }, "build enqueue failed");
    const httpError = new HttpError(503, "api.enqueue_failed");
    await prisma.deployment.update({
      where: { id: deployment.id },
      data: {
        status: "failed",
        errorCode: httpError.code,
        error: httpError.message,
      },
    });
    throw httpError;
  }
  return deployment;
}
