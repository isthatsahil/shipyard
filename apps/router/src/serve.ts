import type { Request, Response } from "express";
import posix from "node:path/posix";
import type { ObjectReader } from "@shipyard/shared/storage";
import { deploymentPrefix, INTERNAL_FILES } from "@shipyard/shared/storageKeys";
import type { Target } from "./resolve.js";

/** Fallback 404 page, for deployments that don't ship their own `404.html`. */
const NOT_FOUND = `<!doctype html><title>404</title><h1>404 — Not found</h1>`;

/**
 * Turns a URL path into a storage key relative to the deployment's prefix.
 *
 * Decodes percent-encoding, drops any query string, collapses `//` and `./`,
 * and maps a trailing `/` to `index.html`: `/a//b/` → `a/b/index.html`.
 *
 * Returns `null` for a path that is malformed (bad percent-encoding) or
 * hostile: one containing a NUL byte or a `..` segment, including encoded
 * forms like `%2e%2e`. `..` is rejected rather than resolved, so a request can
 * never reach another deployment's files.
 *
 * @example
 * normalise("/docs/") // "docs/index.html"
 * normalise("/%2e%2e/secret") // null
 */
export function normalise(raw: string): string | null {
  // split always returns at least one element; the default only satisfies
  // noUncheckedIndexedAccess.
  const [pathPart = ""] = raw.split("?");
  let urlPath: string;
  try {
    urlPath = decodeURIComponent(pathPart);
  } catch {
    return null;
  }
  // Check before normalising: posix.normalize("/../../etc") quietly becomes "/etc".
  if (urlPath.includes("\0") || urlPath.split("/").includes("..")) return null;
  urlPath = posix.normalize("/" + urlPath);
  if (urlPath.endsWith("/")) urlPath += "index.html";
  return urlPath.slice(1);
}

/**
 * Sends one stored object as the response, if it exists.
 *
 * Copies the metadata stored at upload (content type, length, cache headers,
 * encoding, ETag) onto the response and streams the body from storage without
 * buffering it. For a normal (200) response, answers `304 Not Modified`, with
 * no body, when the browser's `If-None-Match` matches the object's ETag. A
 * `404.html` is always sent in full with status 404, and without an ETag, so
 * a cached copy can never turn a missing page into a 304.
 *
 * @param status - Status for a found object; `404` when sending `404.html`.
 * @returns `false` if there's no object at `key`, so the caller can try the
 *   next candidate; `true` once a response has been sent.
 */
async function send(
  store: ObjectReader,
  res: Response,
  key: string,
  req: Request,
  status = 200,
) {
  const obj = await store.get(key);
  if (!obj) return false;
  // Revalidation only applies to a real hit: answering 304 for `404.html`
  // would turn "not found" into "your cached copy is still good".
  const etag = status === 200 ? obj.etag : undefined;
  if (etag && req.headers["if-none-match"] === etag) {
    // The body is a live stream from storage holding a pooled connection;
    // it must be released even though nothing is read from it.
    obj.body.destroy();
    res.status(304).end();
    return true;
  }
  res.status(status);
  if (obj.contentType) res.setHeader("Content-Type", obj.contentType);
  if (obj.contentLength != null)
    res.setHeader("Content-Length", obj.contentLength);
  if (obj.cacheControl) res.setHeader("Cache-Control", obj.cacheControl);
  if (obj.contentEncoding)
    res.setHeader("Content-Encoding", obj.contentEncoding);
  if (etag) res.setHeader("ETag", etag);
  obj.body.pipe(res);
  return true;
}

/**
 * Serves a request from a deployment's stored files, trying keys in order
 * until one exists:
 *
 * 1. The exact path, e.g. `/app.js` → `app.js`.
 * 2. For paths without an extension (pretty URLs, as Next.js and Astro
 *    output): `/docs` → `docs/index.html`, then `docs.html`.
 * 3. With `target.spaFallback`, for paths without an extension: the root
 *    `index.html`, so client-side routes like `/settings/profile` load the
 *    app. Paths with an extension (`/missing.js`) never fall back, so a
 *    missing asset is a 404 and not HTML served as JavaScript.
 * 4. The deployment's own `404.html`, with status 404.
 * 5. A plain 404 page.
 *
 * A malformed or hostile path (see {@link normalise}) gets 400. The platform's
 * internal files (`_meta.json`, `_logs.txt`) get 404, so their existence
 * isn't revealed.
 *
 * Responses from steps 1–5 also get `X-Content-Type-Options: nosniff` and a
 * `Referrer-Policy`, since these are user-built sites the platform serves.
 *
 * @param store - Where deployments' files are stored; only read from.
 * @param target - The deployment to serve, from the `Resolver`.
 */
export async function serveDeployment(
  store: ObjectReader,
  target: Target,
  req: Request,
  res: Response,
) {
  const rel = normalise(req.path);
  if (rel === null) return res.status(400).type("text").send("Bad path");
  // Answered with 404, not 400, so their existence isn't revealed.
  if (INTERNAL_FILES.has(rel))
    return res.status(404).type("html").send(NOT_FOUND);
  const prefix = deploymentPrefix(target.deploymentId);

  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

  if (await send(store, res, prefix + rel, req)) return;

  // /docs → /docs/index.html (pretty URLs, e.g. Next/Astro output)
  if (
    !posix.extname(rel) &&
    (await send(store, res, `${prefix}${rel}/index.html`, req))
  )
    return;
  if (
    !posix.extname(rel) &&
    (await send(store, res, `${prefix}${rel}.html`, req))
  )
    return;

  // SPA fallback: client-side routes have no extension
  if (
    target.spaFallback &&
    !posix.extname(rel) &&
    (await send(store, res, prefix + "index.html", req))
  )
    return;

  if (await send(store, res, prefix + "404.html", req, 404)) return;
  res.status(404).type("html").send(NOT_FOUND);
}
