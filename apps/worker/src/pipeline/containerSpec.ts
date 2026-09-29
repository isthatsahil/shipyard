import type { ContainerCreateOptions, HostConfig } from "dockerode";
import { SANDBOX_UID, SANDBOX_GID } from "../lib/constants.js";

/**
 * Resource limits for one build container. These are the only sandbox knobs
 * an operator may tune; they come from env (see `lib/clients.ts`) so each host
 * can be sized to its hardware.
 */
export interface BuildLimits {
  /** Memory cap in bytes. Swap is disabled, so this is a hard limit. */
  memoryBytes: number;
  /** CPU cores the build may use; fractions are allowed (e.g. `1.5`). */
  cpus: number;
  /** Maximum processes and threads, which stops fork bombs. */
  pidsLimit: number;
  /** Size of the in-memory `/tmp`, in Docker's format, e.g. `"1g"` or `"512m"`. */
  tmpSize: string;
  /** Docker network the container joins: `internal`, so no direct route anywhere. */
  network: string;
  /** Egress proxy URL, the build's only way to the internet. Unset: no internet. */
  proxyUrl?: string;
}

/**
 * Env vars that send a build's traffic through the egress proxy. Package
 * managers and tools read different names: npm, pnpm, git and corepack use
 * HTTP(S)_PROXY in either case, Yarn 2+ only its own YARN_ ones, and Node's
 * built-in `fetch` (used by some build scripts) only with NODE_USE_ENV_PROXY,
 * which needs Node 22.21+ or 24; on Node 20 such scripts get no network.
 */
function proxyEnv(proxyUrl?: string) {
  if (!proxyUrl) return [];
  const names = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"];
  names.push("YARN_HTTP_PROXY", "YARN_HTTPS_PROXY");
  return [
    ...names.map((name) => `${name}=${proxyUrl}`),
    "NODE_USE_ENV_PROXY=1",
  ];
}

/** Everything that differs from one build to the next. */
export interface ContainerSpecInput {
  /** Builder image, e.g. `shipyard/builder:node22`. */
  image: string;
  /** Shell command to run, e.g. `npm ci && npm run build`. */
  cmd: string;
  /** Repo root as the Docker daemon sees it; mounted at `/app`. */
  hostRepoRoot: string;
  /** User's build env vars, as `KEY=value`. */
  envVars: string[];
  deploymentId: string;
  projectId: string;
  limits: BuildLimits;
}

/**
 * Container user. Builds never run as root, so a container escape starts
 * without root privileges. See {@link SANDBOX_UID} for why this uid.
 */
const SANDBOX_USER = `${SANDBOX_UID}:${SANDBOX_GID}`;

/**
 * Isolation every build container gets, whatever the host or project.
 * Deliberately not configurable: builds run untrusted code, and each of these
 * closes a way out of the container. Change them only in code review.
 */
const SANDBOX_HOST_CONFIG = {
  /** The image can't be modified; only `/app` and `/tmp` are writable. */
  ReadonlyRootfs: true,
  /** No Linux capabilities (no raw sockets, mounts, chown, …). */
  CapDrop: ["ALL"],
  /** setuid binaries can't gain privileges. */
  SecurityOpt: ["no-new-privileges"],
  /** Docker deletes the container once it exits, so none are left behind. */
  AutoRemove: true,
} satisfies HostConfig;

/**
 * Builds the `docker.createContainer` options for one build: the fixed
 * sandbox settings above, the host's resource limits, and this build's image,
 * command, mount and env.
 *
 * Pure, so the sandbox guarantees can be unit-tested without Docker.
 */
export function buildContainerSpec(
  input: ContainerSpecInput,
): ContainerCreateOptions {
  const { limits } = input;
  return {
    Image: input.image,
    Cmd: ["sh", "-c", input.cmd],
    WorkingDir: "/app",
    User: SANDBOX_USER,
    Env: [
      ...input.envVars,
      "CI=true",
      "HOME=/tmp",
      ...proxyEnv(limits.proxyUrl),
    ],
    Labels: {
      "shipyard.deployment": input.deploymentId,
      "shipyard.project": input.projectId,
    },
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    HostConfig: {
      Binds: [`${input.hostRepoRoot}:/app`],
      Memory: limits.memoryBytes,
      MemorySwap: limits.memoryBytes, // equal to Memory: no swap
      NanoCpus: Math.round(limits.cpus * 1e9),
      PidsLimit: limits.pidsLimit,
      // exec: some tools write binaries to $TMPDIR and run them
      Tmpfs: { "/tmp": `rw,exec,size=${limits.tmpSize}` },
      NetworkMode: limits.network,
      // Last, so nothing above can override the sandbox.
      ...SANDBOX_HOST_CONFIG,
    },
  };
}
