import { prisma, DeploymentStatus } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { redis } from "./clients.js";

/**
 * For each deployment status, the statuses it may move to next.
 *
 * A build normally runs `queued → cloning → detecting → building → uploading →
 * ready`. `detecting → uploading` skips `building` for plain static sites with
 * no build step. Any in-progress status can end in `failed` or `cancelled`.
 * `ready` becomes `archived` when retention cleanup deletes its stored files.
 * `failed`, `cancelled` and `archived` are final.
 */
const ALLOWED: Record<DeploymentStatus, DeploymentStatus[]> = {
  queued: ["cloning", "cancelled", "failed"],
  cloning: ["detecting", "failed", "cancelled"],
  detecting: ["building", "uploading", "failed", "cancelled"],
  building: ["uploading", "failed", "cancelled"],
  uploading: ["ready", "failed", "cancelled"],
  ready: ["archived"],
  failed: [],
  cancelled: [],
  archived: [],
};

/**
 * Moves a deployment to a new status, then publishes the new status on
 * `keys.status(id)` so the dashboard can update live.
 *
 * Refuses moves that {@link ALLOWED} doesn't permit, e.g. back to an earlier
 * step or out of a final status, so a late or duplicate update can't undo a
 * cancellation or failure. The check reads the current status, then writes
 * separately, so a change made by someone else between the two is not caught.
 *
 * @param id - The deployment to update.
 * @param status - The status to move to.
 * @param extra - Other `Deployment` fields to save in the same update, e.g.
 *   `error` and `errorCode` when moving to `failed`, or `finishedAt`.
 * @returns The updated deployment.
 * @throws If the deployment doesn't exist, or the move isn't allowed.
 *
 * @example
 * await setStatus(deploymentId, "cloning");
 */
export async function setStatus(
  id: string,
  status: DeploymentStatus,
  extra: Record<string, unknown> = {},
) {
  const current = await prisma.deployment.findUniqueOrThrow({
    where: { id },
    select: { status: true },
  });
  if (!ALLOWED[current.status].includes(status))
    throw new Error(`illegal transition ${current.status} → ${status}`);
  const updated = await prisma.deployment.update({
    where: { id },
    data: { status, ...extra },
  });
  await redis.publish(keys.status(id), status);
  return updated;
}
