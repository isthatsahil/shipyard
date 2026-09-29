import fs from "node:fs";
import path from "node:path";

/** Common output folder names, checked in this order. */
const PREFERRED = [
  "dist",
  "build",
  "out",
  "public",
  "_site",
  ".output/public",
  "www",
];
/** Folders a build may create that are never the site output. */
const IGNORE = new Set([
  "node_modules",
  ".git",
  ".next",
  ".svelte-kit",
  ".cache",
  "src",
  "test",
  "tests",
]);

/**
 * Names of the top-level folders in `root`. Taken before the build so
 * {@link postBuildScan} can tell which folders the build created.
 */
export function snapshotDirs(root: string): Set<string> {
  return new Set(
    fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

/**
 * Find the build output after the build has run.
 * 1. Preferred names that contain index.html.
 * 2. Any directory created during the build that contains index.html.
 *
 * @param root - The repo root.
 * @param before - Result of {@link snapshotDirs} taken before the build.
 * @returns The folder, relative to `root`, or `null` if none qualifies.
 */
export function postBuildScan(
  root: string,
  before: Set<string>,
): string | null {
  const hasIndex = (dir: string) =>
    fs.existsSync(path.join(root, dir, "index.html"));
  for (const dir of PREFERRED)
    if (fs.existsSync(path.join(root, dir)) && hasIndex(dir)) return dir;
  const after = snapshotDirs(root);
  for (const dir of after)
    if (!before.has(dir) && !IGNORE.has(dir) && hasIndex(dir)) return dir;
  return null;
}
