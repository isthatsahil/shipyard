import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { IPutOptions, IStoredObject } from "../types/storageTypes";
import type { ObjectStore } from "../interfaces/ObjectStorage";

interface Entry {
  buf: Buffer;
  opts: IPutOptions;
  etag: string;
}

async function toBuffer(body: Buffer | Readable): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body)
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/**
 * In-memory {@link ObjectStore} for tests, imported as
 * `@shipyard/shared/testing`. Never import it from app code.
 *
 * Matches S3 wherever the apps depend on it: a missing key is `null`,
 * metadata round-trips, the ETag is the quoted MD5 of the content (what S3
 * returns for a single-part upload), and every `get` returns a fresh stream,
 * so the same file can be read twice. `objects` is public so a test can
 * check what was written without going through `list`.
 */
export class MemoryStorage implements ObjectStore {
  readonly objects = new Map<string, Entry>();

  async put(key: string, body: Buffer | Readable, opts: IPutOptions) {
    const buf = await toBuffer(body);
    this.objects.set(key, {
      buf,
      opts,
      etag: `"${createHash("md5").update(buf).digest("hex")}"`,
    });
  }

  async get(key: string): Promise<IStoredObject | null> {
    const entry = this.objects.get(key);
    if (!entry) return null;
    return {
      body: Readable.from(entry.buf),
      contentType: entry.opts.contentType,
      contentLength: entry.buf.length,
      cacheControl: entry.opts.cacheControl,
      contentEncoding: entry.opts.contentEncoding,
      etag: entry.etag,
    };
  }

  async exists(key: string) {
    return this.objects.has(key);
  }

  async *list(prefix: string) {
    for (const [key, entry] of this.objects)
      if (key.startsWith(prefix)) yield { key, size: entry.buf.length };
  }

  async deletePrefix(prefix: string) {
    for (const key of [...this.objects.keys()])
      if (key.startsWith(prefix)) this.objects.delete(key);
  }
}
