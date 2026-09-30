import { Router } from "express";
import { prisma } from "@shipyard/db";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl, uniqueSlug } from "../service/project.js";
import { createDeployment } from "../service/deployments.js";
import { CreateProject } from "../utils/zodSchemas.js";
import { z } from "zod";

/** Routes for creating and reading projects. Mount at `/projects`. */
export const projects = Router();

/**
 * `POST /projects`: creates a project from a {@link CreateProject} body and,
 * unless `deploy` is false, starts its first deployment. Answers 201
 * `{ project, deployment }`, with `deployment` null when no build was started.
 *
 * `name` defaults to the repo name, and `slug` to a free slug derived from it.
 *
 * Fails with 400 `api.repo_unsupported` for a non-GitHub URL, 400
 * `api.slug_invalid` or 409 `api.slug_taken` for a bad `slug`, and 503
 * `api.enqueue_failed` if the first build could not be queued. In that last
 * case the project has already been created.
 */
projects.post("/", validate(CreateProject), async (req, res) => {
  const body = req.body as z.infer<typeof CreateProject>;
  const { repo, url } = normaliseRepoUrl(body.repoUrl);
  const slug = await uniqueSlug(body.slug, repo);
  // Phase 1: single seeded user. Replaced by req.user in Phase 3.
  const user = await prisma.user.findFirstOrThrow();
  const project = await prisma.project.create({
    data: {
      userId: user.id,
      name: body.name ?? repo,
      slug,
      repoUrl: url,
      branch: body.branch,
      rootDir: body.rootDir,
      installCmd: body.installCmd,
      buildCmd: body.buildCmd,
      outputDir: body.outputDir,
      spaFallback: body.spaFallback,
    },
  });
  const deployment = body.deploy ? await createDeployment(project.id) : null;
  res.status(201).json({ project, deployment });
});

/**
 * `GET /projects/:id`: the project with its 10 latest deployments, newest
 * first. Answers 404 `api.not_found` for an unknown id.
 */
projects.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { deployments: { orderBy: { createdAt: "desc" }, take: 10 } },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  res.json(project);
});

/**
 * `POST /projects/:id/deployments`: redeploys, building the project's branch
 * again with its current settings. Answers 201 with the new deployment,
 * 404 `api.not_found` for an unknown project, or 503 `api.enqueue_failed`
 * if the build could not be queued.
 */
projects.post("/:id/deployments", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  res.status(201).json(await createDeployment(project.id));
});
