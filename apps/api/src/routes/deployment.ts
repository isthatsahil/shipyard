import { Router } from "express";
import { prisma } from "@shipyard/db";
import { HttpError } from "../lib/httpError.js";

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
