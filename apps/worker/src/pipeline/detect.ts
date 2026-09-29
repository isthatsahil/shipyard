import { prisma } from "@shipyard/db";
import { detectFramework, snapshotDirs } from "../detect/index.js";
import type { BuildContext } from "./context.js";

/**
 * Pipeline step: works out how to build the repo, using the project's
 * settings as overrides. Stores the result on `ctx.detect`, snapshots the
 * repo's folders for `postBuildScan`, logs the plan and any warnings, and
 * saves the framework and resolved commands on the deployment.
 */
export async function detect(ctx: BuildContext) {
  const { project, logger } = ctx;
  const detected = detectFramework(ctx.repoRoot, {
    installCmd: project.installCmd,
    buildCmd: project.buildCmd,
    outputDir: project.outputDir,
    nodeVersion: project.nodeVersion,
  });
  ctx.detect = detected;
  ctx.dirsBefore = snapshotDirs(ctx.repoRoot);
  logger.line(
    "detect",
    `Framework: ${detected.framework} · package manager: ${detected.packageManager} · node ${detected.nodeVersion}`,
  );
  logger.line(
    "detect",
    `Install: ${detected.installCmd ?? "(skip)"} · Build: ${detected.buildCmd ?? "(skip)"} · Output: ${detected.outputDir ?? "(auto)"}`,
  );
  for (const warning of detected.warnings) logger.line("warn", warning);
  await prisma.deployment.update({
    where: { id: ctx.deployment.id },
    data: {
      framework: detected.framework,
      resolvedBuildCmd: detected.buildCmd,
      resolvedOutputDir: detected.outputDir,
    },
  });
}
