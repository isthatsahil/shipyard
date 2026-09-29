import { describe, it, expect } from "vitest";
import { buildContainerSpec, type ContainerSpecInput } from "../containerSpec";

const input: ContainerSpecInput = {
  image: "shipyard/builder:node22",
  cmd: "npm ci && npm run build",
  hostRepoRoot: "/host/builds/d1",
  envVars: ["API_URL=https://example.com"],
  deploymentId: "d1",
  projectId: "p1",
  limits: {
    memoryBytes: 2 * 1024 ** 3,
    cpus: 1.5,
    pidsLimit: 256,
    tmpSize: "512m",
    network: "shipyard_build_egress",
  },
};

describe("buildContainerSpec", () => {
  const spec = buildContainerSpec(input);

  // These are the sandbox guarantees. If one of these fails, a change has
  // weakened build isolation: make sure that was intended.
  it("keeps the sandbox locked down", () => {
    expect(spec.User).toBe("1000:1000");
    expect(spec.HostConfig).toMatchObject({
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      AutoRemove: true,
    });
  });

  it("disables swap", () => {
    expect(spec.HostConfig?.MemorySwap).toBe(spec.HostConfig?.Memory);
  });

  it("applies the host's limits", () => {
    expect(spec.HostConfig).toMatchObject({
      Memory: 2 * 1024 ** 3,
      NanoCpus: 1_500_000_000,
      PidsLimit: 256,
      Tmpfs: { "/tmp": "rw,exec,size=512m" },
      NetworkMode: "shipyard_build_egress",
    });
  });

  it("mounts the repo and runs the command in it", () => {
    expect(spec.HostConfig?.Binds).toEqual(["/host/builds/d1:/app"]);
    expect(spec.WorkingDir).toBe("/app");
    expect(spec.Cmd).toEqual(["sh", "-c", "npm ci && npm run build"]);
  });

  it("passes user env vars through and labels the container", () => {
    expect(spec.Env).toEqual([
      "API_URL=https://example.com",
      "CI=true",
      "HOME=/tmp",
    ]);
    expect(spec.Labels).toEqual({
      "shipyard.deployment": "d1",
      "shipyard.project": "p1",
    });
  });
});
