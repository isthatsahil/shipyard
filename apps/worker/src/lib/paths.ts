import fs from "node:fs/promises";
import path from "node:path";

/** True when `child` is `parent` itself or somewhere below it. Both must be absolute. */
export function isInside(parent: string, child: string) {
  return child === parent || child.startsWith(parent + path.sep);
}

/**
 * Like {@link isInside}, but for where the paths really lead: true only when
 * `child` exists and, with every symlink followed, is inside `parent`.
 *
 * Needed for any path inside a cloned repo. The repo is untrusted and can
 * commit symlinks such as `site -> /`, so `<repo>/site` passes the plain text
 * check while pointing at the whole filesystem.
 */
export async function resolvesInside(parent: string, child: string) {
  try {
    const [realParent, realChild] = await Promise.all([
      fs.realpath(parent),
      fs.realpath(child),
    ]);
    return isInside(realParent, realChild);
  } catch {
    return false; // missing, or a broken or looping link
  }
}
