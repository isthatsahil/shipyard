import { prisma, type Deployment } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import { ROUTE_TTL_SECONDS } from "@shipyard/shared/constants";
import { env, log, redis } from "../lib/clients.js";
import { setStatus } from "../lib/status.js";
import type { BuildContext } from "./context.js";

/**
 * Makes `deployment` its project's live deployment, unless something newer
 * already is or is about to be.
 *
 * The check and the write run in one transaction that first locks the
 * project row. Two builds of the same project finishing at the same moment
 * therefore promote one after the other, and the second sees the first's
 * result. Without the lock, an older build could read "nothing newer", pause,
 * and then overwrite a newer build that went live in between.
 *
 * Skips the switch when either:
 * - the current live deployment is newer (a newer build already went live), or
 * - a newer production deployment is already `ready`. That covers a newer
 *   build that was rolled back by hand: an older build finishing later
 *   shouldn't undo the rollback.
 *
 * @returns `null` if the deployment is now live, otherwise the id of the newer
 *   deployment that blocked it.
 */
async function makeLive(deployment: Deployment): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    // Concurrent promotions of this project wait here until this one commits.
    await tx.$queryRaw`SELECT id FROM "Project" WHERE id = ${deployment.projectId} FOR UPDATE`;

    const { activeDeployment } = await tx.project.findUniqueOrThrow({
      where: { id: deployment.projectId },
      select: { activeDeployment: { select: { id: true, createdAt: true } } },
    });
    if (activeDeployment && activeDeployment.createdAt > deployment.createdAt)
      return activeDeployment.id;

    const newer = await tx.deployment.findFirst({
      where: {
        projectId: deployment.projectId,
        kind: "production",
        status: "ready",
        createdAt: { gt: deployment.createdAt },
      },
      select: { id: true },
    });
    if (newer) return newer.id;

    await tx.project.update({
      where: { id: deployment.projectId },
      data: { activeDeploymentId: deployment.id },
    });
    return null;
  });
}

/**
 * Last pipeline step: marks the deployment `ready`, then makes it the
 * project's live deployment (see {@link makeLive}) and clears the router's
 * cached route so the switch takes effect at once.
 *
 * `ready` means the build succeeded and its files are stored, not that it's
 * live: `Project.activeDeploymentId` says what's live. So a deployment that
 * isn't promoted still stays `ready`, keeping its preview URL and remaining
 * available to promote or roll back to by hand.
 *
 * Never throws once the deployment is `ready`. A failure to switch is written
 * to the build log instead: throwing would send `runPipeline` into its error
 * path, which can't mark a `ready` deployment `failed`, so the failure would
 * go unreported.
 */
export async function promote(ctx: BuildContext) {
  const { deployment, project } = ctx;
  await setStatus(deployment.id, "ready", { finishedAt: new Date() });

  let blockedBy: string | null;
  try {
    blockedBy = await makeLive(deployment);
  } catch (err) {
    log.error({ err, deploymentId: deployment.id }, "promotion failed");
    ctx.logger.line(
      "promote",
      "The build succeeded, but making it live failed. Promote it from the dashboard to try again.",
    );
    return;
  }
  if (blockedBy) {
    ctx.logger.line(
      "promote",
      `A newer deployment (${blockedBy}) is already built; not promoting.`,
    );
    return;
  }

  try {
    await redis.del(keys.route(project.slug));
  } catch (err) {
    // The switch is already committed; the router picks it up when its
    // cached route expires.
    log.warn({ err, deploymentId: deployment.id }, "route cache clear failed");
    ctx.logger.line(
      "promote",
      `Live, but the previous version may be served for up to ${ROUTE_TTL_SECONDS}s.`,
    );
  }
  ctx.logger.line(
    "promote",
    `Live at https://${project.slug}.${env.BASE_DOMAIN}`,
  );
}
