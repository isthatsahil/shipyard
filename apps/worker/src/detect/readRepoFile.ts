import fs from "node:fs";
import path from "node:path";
import { isInside } from "../lib/paths.js";

/** Far above any real package.json or framework config. */
const MAX_BYTES = 1024 * 1024;

/**
 * Reads a file from the cloned repo as text, or returns `null` if it can't be
 * read safely; callers treat that the same as the file not existing.
 *
 * The repo is untrusted and can commit symlinks, and detection reads as root
 * in the worker process, so a plain `readFileSync` is unsafe:
 * `package.json -> /dev/zero` never ends and exhausts the worker's memory, and
 * `vite.config.js -> /proc/self/environ` would feed the worker's secrets to
 * the config regexes, whose matches reach the build log. So the file is read
 * only if, with symlinks followed, it is inside the repo, it is a regular file
 * (not a device or pipe), and it is at most {@link MAX_BYTES}. Symlinks that
 * stay inside the repo still work.
 *
 * @param root - The repo folder.
 * @param name - The file's path relative to `root`.
 */
export function readRepoFile(root: string, name: string): string | null {
  try {
    const real = fs.realpathSync(path.join(root, name));
    if (!isInside(fs.realpathSync(root), real)) return null;
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_BYTES) return null;
    return fs.readFileSync(real, "utf8");
  } catch {
    return null; // missing, or a broken or looping link
  }
}
