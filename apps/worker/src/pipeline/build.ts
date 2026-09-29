import { PassThrough } from "node:stream";
import {
  BuildFailedError,
  BuildTimeoutError,
  BuildCancelledError,
} from "@shipyard/shared/errors";
import { docker, env, log } from "../lib/clients.js";
import type { BuildContext } from "./context.js";
import { buildContainerSpec } from "./containerSpec.js";

/**
 * Pipeline step: runs the install and build commands in a sandboxed container
 * (see `containerSpec.ts`) and streams its output to the build log. Does
 * nothing for a static site with neither command.
 *
 * Stops the build when `BUILD_TIMEOUT_MS` passes or `ctx.signal` aborts.
 *
 * @throws {BuildCancelledError} If `ctx.signal` aborted.
 * @throws {BuildTimeoutError} If the build ran past `BUILD_TIMEOUT_MS`.
 * @throws {BuildFailedError} If the commands exited with a non-zero code.
 */
export async function build(ctx: BuildContext) {
  const detected = ctx.detect!;
  if (!detected.installCmd && !detected.buildCmd) {
    ctx.logger.line("build", "Static site — nothing to build.");
    return;
  }

  const cmd = [detected.installCmd, detected.buildCmd]
    .filter(Boolean)
    .join(" && ");
  const image = `${env.BUILDER_IMAGE_PREFIX}${detected.nodeVersion}`;
  const hostRepoRoot = ctx.hostWorkDir + ctx.repoRoot.slice(ctx.workDir.length);
  ctx.logger.line("build", `$ ${cmd}`);

  const container = await docker.createContainer(
    buildContainerSpec({
      image,
      cmd,
      hostRepoRoot,
      envVars: ctx.envVars,
      deploymentId: ctx.deployment.id,
      projectId: ctx.project.id,
      limits: {
        memoryBytes: env.BUILD_MEMORY_BYTES,
        cpus: env.BUILD_CPUS,
        pidsLimit: env.BUILD_PIDS_LIMIT,
        tmpSize: env.BUILD_TMP_SIZE,
        network: env.BUILD_NETWORK,
        proxyUrl: env.BUILD_HTTP_PROXY,
      },
    }),
  );

  const stream = await container.attach({
    stream: true,
    stdout: true,
    stderr: true,
  });
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  docker.modem.demuxStream(stream, stdout, stderr);
  ctx.logger.pipe("build", stdout);
  ctx.logger.pipe("build", stderr);

  await container.start();

  let timedOut = false,
    cancelled = false;
  const timer = setTimeout(() => {
    timedOut = true;
    container.kill().catch(() => {});
  }, env.BUILD_TIMEOUT_MS);
  const onAbort = () => {
    cancelled = true;
    container.kill().catch(() => {});
  };
  ctx.signal.addEventListener("abort", onAbort, { once: true });

  try {
    const { StatusCode } = await container.wait();
    await ctx.logger.flush();
    if (cancelled) throw new BuildCancelledError();
    if (timedOut) throw new BuildTimeoutError(env.BUILD_TIMEOUT_MS);
    if (StatusCode !== 0) throw new BuildFailedError(StatusCode);
    ctx.logger.line("build", "Build finished successfully.");
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener("abort", onAbort);
    log.debug({ deploymentId: ctx.deployment.id }, "container finished");
  }
}
