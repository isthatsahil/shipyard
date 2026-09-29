import { simpleGit } from "simple-git";
import fs from "node:fs/promises";
import { CloneError } from "@shipyard/shared/errors";
import { prisma } from "@shipyard/db";
import type { BuildContext } from "./context.js";
import {
  GITHUB_URL,
  GITHUB_TOKEN_RE,
  githubAuthUrl,
} from "../lib/constants.js";

/**
 * First pipeline step: puts a fresh copy of the project's repo in `ctx.workDir`.
 *
 * Empties the work directory, then shallow-clones only the latest commit of
 * `project.branch`. If `ctx.gitToken` is set (private repos), it is added to
 * the GitHub URL for the clone only. Records the checked-out commit's hash and
 * message on the deployment, then deletes `.git`, which the build doesn't need.
 *
 * @param ctx - The build in progress. Uses `project`, `deployment`, `workDir`,
 *   `gitToken` and `logger`.
 * @throws {CloneError} If `git clone` fails, e.g. the repo or branch doesn't
 *   exist or access is denied. The token is removed from the message first,
 *   because it ends up in the dashboard.
 */
export async function clone(ctx: BuildContext) {
  const { project, logger } = ctx;
  await fs.rm(ctx.workDir, { recursive: true, force: true });
  await fs.mkdir(ctx.workDir, { recursive: true });

  const url = ctx.gitToken
    ? project.repoUrl.replace(GITHUB_URL, githubAuthUrl(ctx.gitToken))
    : project.repoUrl;

  logger.line("clone", `Cloning ${project.repoUrl} (branch ${project.branch})`);
  try {
    await simpleGit().clone(url, ctx.workDir, [
      "--depth",
      "1",
      "--branch",
      project.branch,
      "--single-branch",
    ]);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    // Never echo the URL back: it may contain the token.
    throw new CloneError(message.replace(GITHUB_TOKEN_RE, ""), project.branch);
  }

  const git = simpleGit(ctx.workDir);
  const head = await git.log({ maxCount: 1 });
  const commit = head.latest;
  logger.line(
    "clone",
    `Checked out ${commit?.hash.slice(0, 7)} — ${commit?.message}`,
  );
  await prisma.deployment.update({
    where: { id: ctx.deployment.id },
    data: { commitSha: commit?.hash, commitMsg: commit?.message },
  });
  await fs.rm(`${ctx.workDir}/.git`, { recursive: true, force: true }); // not needed in the build; keeps the mount smaller
}
