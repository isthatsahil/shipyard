import type { Readable } from "node:stream";

export interface IStoredObject {
  body: Readable;
  contentType?: string;
  contentLength?: number;
  cacheControl?: string;
  contentEncoding?: string;
  etag?: string;
}

export interface IPutOptions {
  contentType: string;
  cacheControl?: string;
  contentEncoding?: string;
  contentLength?: number;
}
