import { Router } from "express";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { simpleGit } from "simple-git";
import { detectFramework } from "@shipyard/shared/detect";
import { resolvesInside } from "@shipyard/shared/paths";
import { validate } from "../middleware/validate.js";
import { HttpError } from "../lib/httpError.js";
import { normaliseRepoUrl } from "../service/project.js";
import { CLONE_TIMEOUT_MS } from "../utils/consts.js";

/** Framework detection for the "new project" form. Mount at `/detect`. */
export const detect = Router();

/**
 * `POST /detect`: shallow-clones `repoUrl` at `branch` into a temp folder and
 * returns `detectFramework` for `rootDir`, so the dashboard can pre-fill the
 * build settings. Only reads files; never runs the repo's code.
 *
 * Answers 400 `api.repo_unsupported` for a non-GitHub URL, 400
 * `pipeline.clone_failed` if the clone fails or takes longer than
 * `CLONE_TIMEOUT_MS`, and 400 `api.invalid_root_dir` if `rootDir` is missing
 * or leads outside the clone (symlinks included).
 */
detect.post(
  "/",
  validate(
    z.object({
      repoUrl: z.string(),
      branch: z.string().default("main"),
      rootDir: z.string().default("."),
    }),
  ),
  async (req, res) => {
    const { url } = normaliseRepoUrl(req.body.repoUrl);
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "detect-"));
    // Aborting kills the git process, so a timed-out clone stops instead of running on in the background.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CLONE_TIMEOUT_MS);
    try {
      try {
        await simpleGit({ abort: controller.signal }).clone(url, dir, [
          "--depth",
          "1",
          "--branch",
          req.body.branch,
          "--single-branch",
          "--filter=blob:limit=256k",
        ]);
      } catch {
        // git's message can echo the URL; send only the code.
        throw new HttpError(400, "pipeline.clone_failed", {
          branch: req.body.branch,
        });
      } finally {
        clearTimeout(timer);
      }
      const root = path.resolve(dir, req.body.rootDir);
      // Follows symlinks: a committed `site -> /` passes a plain text check but resolves outside the clone.
      if (!(await resolvesInside(dir, root)))
        throw new HttpError(400, "api.invalid_root_dir");
      res.json(detectFramework(root));
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
