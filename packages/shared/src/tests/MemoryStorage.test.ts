import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { MemoryStorage } from "../testing/memoryStorage";

async function text(body: Readable) {
  let s = "";
  for await (const chunk of body) s += chunk;
  return s;
}

const md5 = (s: string) => `"${createHash("md5").update(s).digest("hex")}"`;

describe("MemoryStorage", () => {
  it("returns null for a missing key", async () => {
    const store = new MemoryStorage();
    expect(await store.get("deployments/d1/index.html")).toBeNull();
    expect(await store.exists("deployments/d1/index.html")).toBe(false);
  });

  it("round-trips the body and metadata, from a buffer or a stream", async () => {
    const store = new MemoryStorage();
    await store.put("a.html", Buffer.from("<h1>a</h1>"), {
      contentType: "text/html",
      cacheControl: "public, max-age=0, must-revalidate",
    });
    await store.put("b.js", Readable.from(["console.", "log(1)"]), {
      contentType: "text/javascript",
      contentEncoding: "br",
    });

    const a = await store.get("a.html");
    expect(await text(a!.body)).toBe("<h1>a</h1>");
    expect(a).toMatchObject({
      contentType: "text/html",
      contentLength: 10,
      cacheControl: "public, max-age=0, must-revalidate",
    });
    const b = await store.get("b.js");
    expect(await text(b!.body)).toBe("console.log(1)");
    expect(b).toMatchObject({
      contentType: "text/javascript",
      contentEncoding: "br",
    });
  });

  it("returns a fresh stream on every get", async () => {
    const store = new MemoryStorage();
    await store.put("a.txt", Buffer.from("same"), {
      contentType: "text/plain",
    });
    expect(await text((await store.get("a.txt"))!.body)).toBe("same");
    expect(await text((await store.get("a.txt"))!.body)).toBe("same");
  });

  it("uses the quoted MD5 of the content as the ETag", async () => {
    const store = new MemoryStorage();
    await store.put("a.txt", Buffer.from("v1"), { contentType: "text/plain" });
    expect((await store.get("a.txt"))!.etag).toBe(md5("v1"));
    await store.put("a.txt", Buffer.from("v2"), { contentType: "text/plain" });
    expect((await store.get("a.txt"))!.etag).toBe(md5("v2"));
  });

  it("lists and deletes only the keys under a prefix", async () => {
    const store = new MemoryStorage();
    const opts = { contentType: "text/plain" };
    await store.put("deployments/abc1/index.html", Buffer.from("12"), opts);
    await store.put("deployments/abc123/index.html", Buffer.from("123"), opts);

    const listed = [];
    for await (const entry of store.list("deployments/abc1/"))
      listed.push(entry);
    expect(listed).toEqual([{ key: "deployments/abc1/index.html", size: 2 }]);

    await store.deletePrefix("deployments/abc1/");
    expect([...store.objects.keys()]).toEqual([
      "deployments/abc123/index.html",
    ]);
  });
});
