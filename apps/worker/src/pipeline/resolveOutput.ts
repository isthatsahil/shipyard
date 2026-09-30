import fs from "node:fs";
import path from "node:path";
import { OutputNotFoundError } from "@shipyard/shared/errors";
import { prisma } from "@shipyard/db";
import { postBuildScan } from "../detect/index.js";
import { isInside, resolvesInside } from "../lib/paths.js";
import type { BuildContext } from "./context.js";

/**
 * Pipeline step: finds the folder to upload and stores its absolute path on
 * `ctx.outputPath`.
 *
 * Uses the detected or configured output folder if it contains `index.html`;
 * otherwise scans for one the build created (`postBuildScan`). Saves the
 * folder used on the deployment.
 *
 * @throws {OutputNotFoundError} If no folder with an `index.html` is found,
 *   or the folder is outside the repo, by path (`../../etc`) or through a
 *   symlink.
 */
export async function resolveOutput(ctx: BuildContext) {
  const detected = ctx.detect!;
  let out = detected.outputDir;
  const tried: string[] = [];

  // No escaping the repo: checked before anything outside it is even looked at.
  if (out && !isInside(ctx.repoRoot, path.resolve(ctx.repoRoot, out)))
    throw new OutputNotFoundError([out]);

  if (out && !fs.existsSync(path.join(ctx.repoRoot, out, "index.html"))) {
    tried.push(out);
    out = null;
  }
  if (!out) {
    out = postBuildScan(ctx.repoRoot, ctx.dirsBefore ?? new Set());
    if (out)
      ctx.logger.line("output", `Auto-detected output directory: ${out}/`);
  }
  if (!out)
    throw new OutputNotFoundError([...tried, "dist", "build", "out", "public"]);

  const abs = path.resolve(ctx.repoRoot, out);
  // The build may have made the folder a symlink (`dist -> /`), which the text
  // check above can't see. Uploading through it would publish the worker's files.
  if (!(await resolvesInside(ctx.repoRoot, abs)))
    throw new OutputNotFoundError([out]);
  ctx.outputPath = abs;
  ctx.logger.line("output", `Using ${out}/`);
  await prisma.deployment.update({
    where: { id: ctx.deployment.id },
    data: { resolvedOutputDir: out },
  });
}
