import { Router } from "express";
import { prisma } from "@shipyard/db";
import { HttpError } from "../lib/httpError.js";
import { log, redis, storage } from "../lib/clients.js";
import { keys } from "@shipyard/shared/redis";
import { TERMINAL } from "../utils/consts.js";

/** Routes for a single deployment, addressed by id. Mount at `/deployments`. */
export const deployments = Router();

/**
 * `GET /deployments/:id`: one deployment with its project's `slug`, which
 * the dashboard needs to build the preview URL.
 *
 * `sizeBytes` is a BigInt, which `JSON.stringify` cannot serialise, so it is
 * sent as a decimal string (or `null` before upload).
 *
 * Answers 404 `api.not_found` for an unknown id.
 */
deployments.get("/:id", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({
    where: { id: req.params.id },
    include: { project: { select: { slug: true } } },
  });
  if (!deployment) throw new HttpError(404, "api.not_found");
  res.json({
    ...deployment,
    sizeBytes: deployment.sizeBytes?.toString() ?? null,
  });
});

deployments.post("/:id/promote", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({
    where: { id: req.params.id },
    include: { project: true },
  });
  if (!deployment) throw new HttpError(404, "api.not_found");
  if (deployment.status !== "ready")
    throw new HttpError(409, "api.promote_not_ready");
  await prisma.project.update({
    where: { id: deployment.projectId },
    data: { activeDeploymentId: deployment.id },
  });
  await redis.del(keys.route(deployment.project.slug));
  res.json({ ok: true, activeDeploymentId: deployment.id });
});

deployments.delete("/:id", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({
    where: { id: req.params.id },
    include: { activeFor: true },
  });
  if (!deployment) throw new HttpError(404, "api.not_found");
  if (deployment.activeFor) throw new HttpError(409, "api.delete_active");
  if (!TERMINAL.has(deployment.status))
    throw new HttpError(409, "api.deployment_in_progress");
  await prisma.deployment.delete({ where: { id: deployment.id } });
  void storage
    .deletePrefix(deployment.storagePrefix)
    .catch((err) =>
      log.warn({ err, deploymentId: deployment.id }, "storage cleanup failed"),
    );
  res.status(204).end();
});
