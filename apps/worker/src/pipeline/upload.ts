import fs from "node:fs";
import path from "node:path";
import fg from "fast-glob";
import pLimit from "p-limit";
import { prisma } from "@shipyard/db";
import { contentTypeFor, cacheControlFor } from "@shipyard/shared/contentType";
import { metaKey } from "@shipyard/shared/storageKeys";
import type { BuildContext } from "./context.js";

/**
 * Never uploaded: dependencies, git data, env files that may hold secrets,
 * and source maps, which would expose the original source.
 */
const EXCLUDE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/.env",
  "**/.env.*",
  "**/*.map",
];

/**
 * Pipeline step: uploads every regular file in the output folder (symlinks are
 * skipped and logged) to the deployment's
 * storage prefix, 16 at a time, with its content type and cache headers.
 * Then writes `_meta.json` and saves the file count and total size on the
 * deployment.
 *
 * @throws If the output folder has no files after the exclusions.
 */
export async function upload(ctx: BuildContext) {
  const root = ctx.outputPath!;
  // Every entry, not just files, so symlinks show up and can be reported:
  // with `onlyFiles` fast-glob would drop them silently.
  const listed = await fg("**/*", {
    cwd: root,
    onlyFiles: false,
    dot: true,
    ignore: EXCLUDE,
    followSymbolicLinks: false,
  });
  // Regular files only. The worker reads as root, so a symlink in the output
  // (committed, or made by the build) such as `env.txt -> /proc/self/environ`
  // would publish whatever it points at, including the worker's own secrets.
  const files: string[] = [];
  for (const rel of listed) {
    const entry = await fs.promises.lstat(path.join(root, rel));
    if (entry.isFile()) files.push(rel);
    else if (entry.isSymbolicLink())
      ctx.logger.line(
        "warn",
        `Skipped ${rel}: symbolic links are not uploaded.`,
      );
  }
  if (!files.length) throw new Error("output directory is empty");

  const limit = pLimit(16);
  let bytes = 0;
  ctx.logger.line("upload", `Uploading ${files.length} files…`);

  await Promise.all(
    files.map((rel) =>
      limit(async () => {
        const abs = path.join(root, rel);
        const size = (await fs.promises.lstat(abs)).size;
        bytes += size;
        await ctx.store.put(
          ctx.deployment.storagePrefix + rel,
          fs.createReadStream(abs),
          {
            contentType: contentTypeFor(rel),
            cacheControl: cacheControlFor(rel),
            contentLength: size,
          },
        );
      }),
    ),
  );

  const meta = {
    fileCount: files.length,
    sizeBytes: bytes,
    framework: ctx.detect?.framework,
    outputDir: ctx.detect?.outputDir,
  };
  await ctx.store.put(
    metaKey(ctx.deployment.storagePrefix),
    Buffer.from(JSON.stringify(meta)),
    { contentType: "application/json" },
  );
  await prisma.deployment.update({
    where: { id: ctx.deployment.id },
    data: { fileCount: files.length, sizeBytes: BigInt(bytes) },
  });
  ctx.logger.line(
    "upload",
    `Uploaded ${files.length} files (${(bytes / 1024).toFixed(0)} KB).`,
  );
}
