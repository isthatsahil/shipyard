import type { IPutOptions, IStoredObject } from "../types/storageTypes";
import type { Readable } from "node:stream";

/**
 * Key/value object storage used to hand deployment files from the worker to the router.
 *
 * Services depend on this interface rather than on S3 directly, and receive an
 * instance instead of importing one. Production uses the S3-backed implementation
 * (MinIO locally, S3/R2 in production); tests use an in-memory one.
 *
 * Keys are flat strings. "Folders" are key prefixes such as `deployments/<id>/`;
 * build them with the helpers in `storageKeys.ts` so every service agrees on the layout.
 *
 * Implementations may rely on `this`, so call methods on the instance
 * (`paths.map(key => store.get(key))`) rather than passing them loose (`paths.map(store.get)`).
 */
export interface ObjectStore {
  /**
   * Stores an object, replacing any existing object at the same key.
   *
   * The metadata in `opts` is saved with the object and returned by {@link ObjectStore.get},
   * where the router copies it into the HTTP response headers.
   *
   * @param key - Full object key, e.g. `deployments/abc123/index.html`.
   * @param body - The content. Use a `Buffer` for small in-memory data and a
   *   `Readable` stream for files on disk, so large files are never fully buffered.
   * @param opts - Content type and optional caching/encoding metadata. When `body`
   *   is a stream, pass `contentLength`: S3 needs the size before the upload starts.
   */
  put(key: string, body: Buffer | Readable, opts: IPutOptions): Promise<void>;

  /**
   * Fetches an object and its metadata.
   *
   * A missing key is an expected outcome (the router probes several candidate
   * paths per request), so it resolves to `null` instead of throwing. Any other
   * failure, such as bad credentials or storage being unreachable, rejects.
   *
   * @param key - Full object key.
   * @returns The object with its body as a stream, or `null` if the key does not exist.
   *   The caller must consume or destroy `body` to release the connection.
   */
  get(key: string): Promise<IStoredObject | null>;

  /**
   * Checks whether an object exists without downloading its content.
   *
   * @param key - Full object key.
   * @returns `true` if the object exists, `false` if it does not. Rejects on any other error.
   */
  exists(key: string): Promise<boolean>;

  /**
   * Lists every object whose key starts with `prefix`.
   *
   * Results are yielded one at a time and fetched page by page as the caller
   * iterates, so memory use stays flat however many objects match.
   *
   * @param prefix - Key prefix to match. End it with `/` (e.g. `deployments/abc123/`)
   *   so `deployments/abc1` does not also match `deployments/abc123/...`.
   * @returns An async iterable of `{ key, size }`, with `size` in bytes.
   *
   * @example
   * for await (const { key, size } of store.list("deployments/abc123/")) {
   *   console.log(key, size);
   * }
   */
  list(prefix: string): AsyncIterable<{ key: string; size: number }>;

  /**
   * Deletes every object whose key starts with `prefix`, e.g. an entire deployment.
   *
   * Deleting a prefix with no objects is a no-op. The operation is not atomic:
   * if it fails partway, some objects may already be gone, and calling it again is safe.
   *
   * @param prefix - Key prefix to delete. Always end it with `/`: a prefix without
   *   the trailing slash can match, and delete, other deployments' files.
   */
  deletePrefix(prefix: string): Promise<void>;
}

/**
 * Read-only view of an {@link ObjectStore}: only `get`.
 *
 * For code that serves stored files, such as the router. Accepting this instead
 * of the full store means that code cannot write or delete objects, and a test
 * fake only needs to implement `get`.
 *
 * @example
 * export async function serveDeployment(store: ObjectReader, target: Target, req: Request, res: Response) { ... }
 */
export type ObjectReader = Pick<ObjectStore, "get">;

/**
 * Write-only view of an {@link ObjectStore}: only `put`.
 *
 * For code that publishes files, such as the worker's upload step. Accepting this
 * instead of the full store means that code cannot read or delete objects, and a
 * test fake only needs to implement `put`.
 *
 * @example
 * export interface BuildContext { store: ObjectWriter; ... }
 */
export type ObjectWriter = Pick<ObjectStore, "put">;
