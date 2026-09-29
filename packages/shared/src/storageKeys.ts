/**
 * Every object-storage path the platform uses, in one place.
 *
 * Bucket layout:
 *
 *   deployments/<deploymentId>/            ← deploymentPrefix(id), saved on the deployment row
 *     index.html, assets/…                 ← the built site, as uploaded by the worker
 *     _meta.json                           ← metaKey(prefix): build summary (worker, Phase 1)
 *     _logs.txt                            ← logsKey(prefix): archived build log (worker, Phase 2)
 *
 * Per-deployment helpers take the deployment's saved `storagePrefix`, not its id.
 * The prefix is stored on each row so the layout can change later without breaking
 * old deployments; rebuilding it from the id would undo that.
 *
 * Add new paths here rather than writing the string where it's used.
 */

/**
 * Key prefix for all files of one deployment. Only called when a deployment is
 * created; everything afterwards uses the `storagePrefix` saved on the row.
 *
 * The trailing `/` matters: without it, listing or deleting `deployments/abc1`
 * would also match `deployments/abc123/...`.
 *
 * @param deploymentId - The deployment's database id.
 * @returns `deployments/<deploymentId>/`
 */
export const deploymentPrefix = (deploymentId: string) =>
  `deployments/${deploymentId}/`;

/** File name of the build summary the worker writes next to the site. */
export const META_FILE = "_meta.json";

/** File name of the archived build log, read when Redis no longer has the live log. */
export const LOGS_FILE = "_logs.txt";

/**
 * Files the platform stores inside a deployment prefix that are not part of the
 * user's site. The router must never serve these; it answers 404 instead.
 */
export const INTERNAL_FILES: ReadonlySet<string> = new Set([
  META_FILE,
  LOGS_FILE,
]);

/**
 * @param storagePrefix - The deployment's saved `storagePrefix`.
 * @returns Key of the deployment's build summary, e.g. `deployments/abc123/_meta.json`.
 */
export const metaKey = (storagePrefix: string) => storagePrefix + META_FILE;

/**
 * @param storagePrefix - The deployment's saved `storagePrefix`.
 * @returns Key of the deployment's archived build log, e.g. `deployments/abc123/_logs.txt`.
 */
export const logsKey = (storagePrefix: string) => storagePrefix + LOGS_FILE;
