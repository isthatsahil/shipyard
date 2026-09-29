import { simpleGit, type SimpleGitOptions } from "simple-git";
import fs from "node:fs/promises";
import { CloneError } from "@shipyard/shared/errors";
import { prisma } from "@shipyard/db";
import type { BuildContext } from "./context.js";
import {
  GITHUB_URL,
  GITHUB_TOKEN_RE,
  githubAuthUrl,
  SANDBOX_UID,
  SANDBOX_GID,
} from "../lib/constants.js";

/**
 * Runs git as the build's sandbox user, so every cloned file belongs to the
 * user the build container runs as, and the build can write into the repo.
 *
 * Cloning as that user, rather than cloning as root and changing owners
 * afterwards, means nothing ever walks the untrusted tree with root rights:
 * a committed symlink like `etc -> /etc` can't redirect a recursive chown.
 *
 * Only possible when the worker is root, as it is in its container. A worker
 * run on the host (`pnpm dev`) can't switch users; on Docker Desktop that's
 * harmless, because its file sharing ignores ownership.
 */
const asSandboxUser: Partial<SimpleGitOptions> =
  process.getuid?.() === 0
    ? { spawnOptions: { uid: SANDBOX_UID, gid: SANDBOX_GID } }
    : {};

/**
 * First pipeline step: puts a fresh copy of the project's repo in `ctx.workDir`,
 * owned by the build's sandbox user.
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
  // git runs as the sandbox user, so it must own the folder it clones into.
  // Safe as root: the folder was just created empty, so there's nothing to follow.
  if (asSandboxUser.spawnOptions)
    await fs.chown(ctx.workDir, SANDBOX_UID, SANDBOX_GID);

  const url = ctx.gitToken
    ? project.repoUrl.replace(GITHUB_URL, githubAuthUrl(ctx.gitToken))
    : project.repoUrl;

  logger.line("clone", `Cloning ${project.repoUrl} (branch ${project.branch})`);
  try {
    await simpleGit(asSandboxUser).clone(url, ctx.workDir, [
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

  // safe.directory: on Docker Desktop the bind-mounted clone doesn't show the
  // sandbox user as owner, and git refuses to read a repo someone else owns
  // ("dubious ownership"). Trusting this one folder is safe: git created its
  // .git a moment ago, and a clone can't bring the repo's own .git/config.
  const git = simpleGit(ctx.workDir, {
    ...asSandboxUser,
    config: [`safe.directory=${ctx.workDir}`],
  });
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
