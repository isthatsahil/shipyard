import mime from "mime-types";

/**
 * Looks up the MIME type for a file from its extension.
 *
 * @param path - A file path or name, such as `"assets/logo.svg"`.
 * @returns The MIME type, or `"application/octet-stream"` if the extension
 * is missing or unknown.
 *
 * @example
 * contentTypeFor("index.html"); // "text/html"
 * contentTypeFor("data.bin");   // "application/octet-stream"
 */
export function contentTypeFor(path: string) {
  return mime.lookup(path) || "application/octet-stream";
}

/**
 * Matches static assets whose filename has a content hash of 8 or more hex
 * characters just before the extension, which means their contents never change.
 *
 * e.g. index-3f2a9c1b.js, chunk.a1b2c3d4e5.css, _app-8f7e6d5c4b3a2.js
 */
const HASHED_RE =
  /[.-][a-f0-9]{8,}\.(?:js|mjs|css|woff2?|ttf|png|jpe?g|webp|avif|svg|gif|ico)$/i;

/**
 * Chooses a `Cache-Control` header value for a file path:
 *
 * - HTML: `max-age=0, must-revalidate`, so browsers always check for a new deploy.
 * - Content-hashed files and anything under `_next/static/` or `assets/`:
 *   cached for one year and marked `immutable`.
 * - Everything else: cached for one hour.
 *
 * @param path - The file path relative to the site root, with no leading slash
 * (the prefix checks depend on this).
 * @returns The `Cache-Control` header value.
 *
 * @example
 * cacheControlFor("index.html");        // "public, max-age=0, must-revalidate"
 * cacheControlFor("assets/app.js");     // "public, max-age=31536000, immutable"
 * cacheControlFor("robots.txt");        // "public, max-age=3600"
 */
export function cacheControlFor(path: string) {
  if (/\.html?$/i.test(path)) return "public, max-age=0, must-revalidate";
  if (
    HASHED_RE.test(path) ||
    path.startsWith("_next/static/") ||
    path.startsWith("assets/")
  ) {
    return "public, max-age=31536000, immutable";
  }
  return "public, max-age=3600";
}

/**
 * Matches text-based file types that are worth compressing (gzip/brotli).
 * Images, fonts and other already-compressed formats are left out.
 */
export const COMPRESSIBLE =
  /\.(?:html?|css|js|mjs|json|svg|txt|xml|map|webmanifest|wasm)$/i;
