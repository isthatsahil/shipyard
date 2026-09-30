import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import type { BuildContext } from "../context";

vi.mock("@shipyard/db", () => ({
  prisma: { deployment: { update: vi.fn() } },
}));
const { upload } = await import("../upload");

// An output folder holding one real page, plus symlinks to a secret outside it:
// one to the file directly, one to its folder.
let tmp: string, out: string;
beforeAll(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "upload-"));
  out = path.join(tmp, "dist");
  await fs.mkdir(out);
  await fs.mkdir(path.join(tmp, "outside"));
  await fs.writeFile(path.join(tmp, "outside", "secret.txt"), "SECRET");
  await fs.writeFile(path.join(out, "index.html"), "<title>ok</title>");
  await fs.symlink(
    path.join(tmp, "outside", "secret.txt"),
    path.join(out, "leak.txt"),
  );
  await fs.symlink(path.join(tmp, "outside"), path.join(out, "dirlink"));
});
afterAll(() => fs.rm(tmp, { recursive: true, force: true }));

async function text(body: Buffer | Readable) {
  if (Buffer.isBuffer(body)) return body.toString();
  let s = "";
  for await (const chunk of body) s += chunk;
  return s;
}

describe("upload", () => {
  it("uploads regular files and never reads through symlinks", async () => {
    const stored = new Map<string, string>();
    const logged: string[] = [];
    const ctx = {
      outputPath: out,
      deployment: { id: "d1", storagePrefix: "p/d1/" },
      store: {
        put: async (key: string, body: Buffer | Readable) =>
          void stored.set(key, await text(body)),
      },
      logger: { line: (_step: string, line: string) => logged.push(line) },
    } as unknown as BuildContext;

    await upload(ctx);

    expect([...stored.keys()].sort()).toEqual([
      "p/d1/_meta.json",
      "p/d1/index.html",
    ]);
    expect([...stored.values()].join()).not.toContain("SECRET");
    expect(logged).toEqual(
      expect.arrayContaining([
        "Skipped leak.txt: symbolic links are not uploaded.",
        "Skipped dirlink: symbolic links are not uploaded.",
      ]),
    );
  });
});
