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
