import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readRepoFile } from "../readRepoFile";
import { detectFramework } from "../index";

// A repo next to an "outside" folder holding a secret, with the kinds of
// links and files a malicious repo could commit.
let tmp: string, repo: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "readRepoFile-"));
  repo = path.join(tmp, "repo");
  await fs.mkdir(repo);
  await fs.mkdir(path.join(tmp, "outside"));
  await fs.writeFile(
    path.join(tmp, "outside", "vite.config.js"),
    'export default { build: { outDir: "SECRET" } }',
  );
  await fs.writeFile(path.join(repo, "real.txt"), "hello");
  await fs.symlink("real.txt", path.join(repo, "alias.txt"));
  await fs.symlink(
    path.join(tmp, "outside", "vite.config.js"),
    path.join(repo, "vite.config.js"),
  );
  await fs.symlink("/dev/zero", path.join(repo, "package.json"));
  await fs.writeFile(path.join(repo, "huge.txt"), "x".repeat(1024 * 1024 + 1));
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

describe("readRepoFile", () => {
  it("reads a regular file", () =>
    expect(readRepoFile(repo, "real.txt")).toBe("hello"));
  it("follows a symlink that stays inside the repo", () =>
    expect(readRepoFile(repo, "alias.txt")).toBe("hello"));
  it("refuses a symlink that leads outside the repo", () =>
    expect(readRepoFile(repo, "vite.config.js")).toBeNull());
  it("refuses a device, without reading it", () =>
    expect(readRepoFile(repo, "package.json")).toBeNull());
  it("refuses a file over the size limit", () =>
    expect(readRepoFile(repo, "huge.txt")).toBeNull());
  it("returns null for a missing file", () =>
    expect(readRepoFile(repo, "nope.txt")).toBeNull());
});

describe("detectFramework on a hostile repo", () => {
  // Before readRepoFile, package.json -> /dev/zero made this read without end,
  // growing past 1.6 GB of memory until the process was killed.
  it("finishes, treating the unreadable package.json as absent", () => {
    const result = detectFramework(repo);
    expect(result.framework).toBe("static");
    expect(JSON.stringify(result)).not.toContain("SECRET");
  });
});
