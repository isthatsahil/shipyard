import { Router } from "express";
import { prisma } from "@shipyard/db";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl, uniqueSlug } from "../service/project.js";
import { createDeployment } from "../service/deployments.js";
import { CreateProject } from "../utils/zodSchemas.js";
import { z } from "zod";
import { log, redis, storage } from "../lib/clients.js";
import { keys } from "@shipyard/shared/redis";
import { ACTIVE_DEPLOYMENT, PROJECT_ORDER } from "../utils/consts.js";

/** Routes for creating and reading projects. Mount at `/projects`. */
export const projects = Router();

const ProjectsPage = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
  q: z.string().trim().min(1).max(100).optional(),
  sort: z.enum(["updated", "name", "created"]).default("updated"),
});

const DeploymentsPage = z.object({ cursor: z.string().optional() });

/**
 * `GET /projects?page&pageSize&q&sort`: one page of projects, each with its
 * live deployment and its latest deployment. Answers
 * `{ items, total, page, pageSize }`.
 *
 * `q` matches name, slug or repo URL, ignoring case. `sort` is `updated`
 * (default), `name` or `created`. Answers 400 `api.validation_failed` for an
 * invalid query.
 */
projects.get("/", validate(ProjectsPage, "query"), async (req, res) => {
  const { page, pageSize, q, sort } = req.query as unknown as z.infer<
    typeof ProjectsPage
  >;
  const contains = { contains: q, mode: "insensitive" } as const;
  const where = q
    ? { OR: [{ name: contains }, { slug: contains }, { repoUrl: contains }] }
    : {};
  // One transaction, so `total` can't disagree with `items`.
  const [items, total] = await prisma.$transaction([
    prisma.project.findMany({
      where,
      orderBy: [PROJECT_ORDER[sort], { id: "desc" }], // id breaks ties
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        activeDeployment: ACTIVE_DEPLOYMENT,
        deployments: {
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          take: 1,
          select: {
            id: true,
            status: true,
            commitSha: true,
            commitMsg: true,
            createdAt: true,
          },
        },
      },
    }),
    prisma.project.count({ where }),
  ]);
  res.json({ items, total, page, pageSize });
});

/**
 * `GET /projects/:id`: the project with its live deployment
 * (`activeDeployment`, or null), its total `deploymentCount`, and its 10
 * latest deployments, newest first. Answers 404 `api.not_found` for an
 * unknown id.
 *
 * `sizeBytes` is a BigInt, which `JSON.stringify` cannot serialise, so it is
 * sent as a decimal string (or `null` before upload).
 */
projects.get("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: {
      activeDeployment: ACTIVE_DEPLOYMENT,
      deployments: {
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 10,
      },
      _count: { select: { deployments: true } },
    },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  const { _count, deployments, ...rest } = project;
  res.json({
    ...rest,
    deploymentCount: _count.deployments,
    deployments: deployments.map((row) => ({
      ...row,
      sizeBytes: row.sizeBytes?.toString() ?? null,
    })),
  });
});

projects.get(
  "/:id/deployments",
  // Typed params: otherwise the middleware's default `string | string[]` params win over the path's.
  validate<{ id: string }>(DeploymentsPage, "query"),
  async (req, res) => {
    const take = 20;
    const { cursor } = req.query as z.infer<typeof DeploymentsPage>;
    const rows = await prisma.deployment.findMany({
      where: { projectId: req.params.id },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }], // id breaks createdAt ties
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const items = rows.slice(0, take);
    // The cursor is the last row returned; `skip: 1` above skips it on the next request.
    const next = rows.length > take ? items[items.length - 1]!.id : null;
    res.json({
      items: items.map((row) => ({
        ...row,
        sizeBytes: row.sizeBytes?.toString() ?? null,
      })),
      next,
    });
  },
);

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

projects.delete("/:id", async (req, res) => {
  const project = await prisma.project.findUnique({
    where: { id: req.params.id },
    include: { deployments: { select: { storagePrefix: true } } },
  });
  if (!project) throw new HttpError(404, "api.not_found");
  await prisma.project.delete({ where: { id: project.id } }); // cascades deployments + domains
  await redis.del(keys.route(project.slug));
  // Storage cleanup is best-effort and async; the retention job (Phase 5) catches stragglers.
  void Promise.all(
    project.deployments.map((deployment) =>
      storage.deletePrefix(deployment.storagePrefix),
    ),
  ).catch((err) =>
    log.warn({ err, projectId: project.id }, "storage cleanup failed"),
  );
  res.status(204).end();
});
