import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvesInside } from "../paths";

// A repo folder next to an "outside" folder, with symlinks of each kind a
// malicious repo could commit.
let tmp: string, repo: string;
beforeAll(async () => {
  tmp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paths-")));
  repo = path.join(tmp, "repo");
  await fs.mkdir(path.join(repo, "site"), { recursive: true });
  await fs.mkdir(path.join(tmp, "outside"));
  await fs.symlink(path.join(tmp, "outside"), path.join(repo, "escape"));
  await fs.symlink("site", path.join(repo, "alias"));
  await fs.symlink(path.join(tmp, "missing"), path.join(repo, "broken"));
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe("resolvesInside", () => {
  it("accepts a real folder inside", async () =>
    expect(await resolvesInside(repo, path.join(repo, "site"))).toBe(true));
  it("accepts the folder itself", async () =>
    expect(await resolvesInside(repo, repo)).toBe(true));
  it("accepts a symlink that stays inside", async () =>
    expect(await resolvesInside(repo, path.join(repo, "alias"))).toBe(true));
  it("rejects a symlink that leads outside", async () =>
    expect(await resolvesInside(repo, path.join(repo, "escape"))).toBe(false));
  it("rejects a path through a symlink that leads outside", async () =>
    expect(await resolvesInside(repo, path.join(repo, "escape", "x"))).toBe(
      false,
    ));
  it("rejects a broken symlink", async () =>
    expect(await resolvesInside(repo, path.join(repo, "broken"))).toBe(false));
  it("rejects a path that doesn't exist", async () =>
    expect(await resolvesInside(repo, path.join(repo, "nope"))).toBe(false));
});
