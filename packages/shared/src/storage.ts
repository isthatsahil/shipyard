import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
  HeadObjectCommand,
  S3ServiceException,
} from "@aws-sdk/client-s3";
import type { IPutOptions, IStoredObject } from "./types/storageTypes";
import type { BaseEnv } from "./env";
import type { ObjectStore } from "./interfaces/ObjectStorage";
import type { Readable } from "node:stream";

// interfaces/ and types/ aren't in the package's exports; consumers get these
// through the `@shipyard/shared/storage` subpath.
export type {
  ObjectStore,
  ObjectReader,
  ObjectWriter,
} from "./interfaces/ObjectStorage";
export type { IStoredObject, IPutOptions } from "./types/storageTypes";

/**
 * True when an S3 call failed because the object does not exist.
 *
 * Checks the HTTP status rather than a specific error class: AWS throws
 * `NoSuchKey` for GET and a bare `NotFound` for HEAD (whose response has no
 * error body), and some S3-compatible services use neither. All of them are
 * `S3ServiceException`s carrying a 404.
 */
function isNotFound(e: unknown): boolean {
  return e instanceof S3ServiceException && e.$metadata.httpStatusCode === 404;
}

/**
 * {@link ObjectStore} backed by any S3-compatible service: MinIO locally, AWS S3 or
 * Cloudflare R2 in production. Which one is decided entirely by the env config.
 *
 * Create one instance per service (in its `lib/clients.ts`) and share it: the
 * underlying `S3Client` keeps a connection pool, so creating one per request is wasteful.
 *
 * This file documents S3-specific behaviour; the contract every implementation
 * follows is documented on {@link ObjectStore}.
 *
 * @example
 * export const storage: ObjectStore = new Storage(env);
 */
export class Storage implements ObjectStore {
  private s3: S3Client;

  /**
   * @param env - Validated env. Uses `S3_ENDPOINT`, `S3_REGION`, `S3_FORCE_PATH_STYLE`,
   *   `S3_ACCESS_KEY`, `S3_SECRET_KEY` and, unless `bucket` is given, `S3_BUCKET`.
   *   `S3_FORCE_PATH_STYLE` must be `true` for MinIO in Docker (`http://minio:9000/<bucket>/<key>`)
   *   because virtual-host URLs (`http://<bucket>.minio:9000`) don't resolve there.
   * @param bucket - Bucket to operate on. Defaults to `env.S3_BUCKET`; override it
   *   to target another bucket (e.g. an archive) or an isolated one in tests.
   */
  constructor(
    private env: BaseEnv,
    private bucket = env.S3_BUCKET,
  ) {
    this.s3 = new S3Client({
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY,
        secretAccessKey: env.S3_SECRET_KEY,
      },
    });
  }

  /**
   * Uploads an object with a single `PutObject` request.
   *
   * The metadata is stored as the object's S3 system metadata (`Content-Type`,
   * `Cache-Control`, `Content-Encoding`), which is exactly what `get` returns later.
   *
   * For a `Readable` body, always pass `opts.contentLength`. A stream can't report
   * its own size, and without it the SDK warns and the upload may be rejected
   * (MinIO and S3 differ here), so don't rely on it working.
   *
   * @see {@link ObjectStore.put}
   */
  async put(key: string, body: Buffer | Readable, opts: IPutOptions) {
    await this.s3.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        ContentEncoding: opts.contentEncoding,
        ContentLength: opts.contentLength,
      }),
    );
  }

  /**
   * Downloads an object with `GetObject`. The body is a live HTTP stream from S3,
   * not a buffer, so large files flow through without being held in memory.
   *
   * A missing key (see {@link isNotFound}) resolves to `null`; every other error
   * is rethrown.
   *
   * `etag` is S3's quoted ETag (e.g. `"9b2cf5…"`), ready to send as an HTTP header as-is.
   *
   * @see {@link ObjectStore.get}
   */
  async get(key: string): Promise<IStoredObject | null> {
    try {
      const response = await this.s3.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return {
        body: response.Body as Readable,
        contentType: response.ContentType,
        contentLength: response.ContentLength,
        cacheControl: response.CacheControl,
        contentEncoding: response.ContentEncoding,
        etag: response.ETag,
      };
    } catch (e) {
      if (isNotFound(e)) return null;
      throw e;
    }
  }

  /**
   * Checks for an object with `HeadObject`, which returns metadata but no body.
   *
   * A missing key (see {@link isNotFound}) resolves to `false`; every other error
   * is rethrown.
   *
   * @see {@link ObjectStore.exists}
   */
  async exists(key: string) {
    try {
      await this.s3.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  /**
   * Lists objects with `ListObjectsV2`, following continuation tokens.
   *
   * S3 returns at most 1000 keys per request. Each page is requested only when
   * the caller has consumed the previous one, so stopping the loop early
   * (`break`) also stops further requests.
   *
   * @see {@link ObjectStore.list}
   */
  async *list(prefix: string) {
    let token: string | undefined;
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const object of page.Contents ?? [])
        if (object.Key) yield { key: object.Key, size: object.Size ?? 0 };
      token = page.NextContinuationToken;
    } while (token);
  }

  /**
   * Deletes everything under a prefix. S3 has no "delete folder" operation, so
   * this lists the keys and removes them with `DeleteObjects` in batches of 1000
   * (the per-request maximum): 2,347 objects take 3 requests, not 2,347.
   *
   * `DeleteObjects` answers 200 even when some keys fail, listing them in
   * `Errors`, so each response is checked: if any key failed, this rejects
   * after that batch. Earlier batches stay deleted, and calling it again
   * deletes whatever is left.
   *
   * @see {@link ObjectStore.deletePrefix}
   */
  async deletePrefix(prefix: string) {
    let batch: { Key: string }[] = [];
    /** Sends the pending batch, if any, and starts a new one. */
    const flush = async () => {
      if (!batch.length) return;
      const response = await this.s3.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: batch },
        }),
      );
      if (response.Errors?.length) {
        const sample = response.Errors.slice(0, 3)
          .map((failure) => `${failure.Key}: ${failure.Code}`)
          .join(", ");
        throw new Error(
          `failed to delete ${response.Errors.length} of ${batch.length} objects under ${prefix} (${sample})`,
        );
      }
      batch = [];
    };
    for await (const object of this.list(prefix)) {
      batch.push({ Key: object.key });
      if (batch.length === 1000) await flush();
    }
    await flush();
  }
}
