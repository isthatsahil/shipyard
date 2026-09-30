import { prisma } from "@shipyard/db";
import { keys } from "@shipyard/shared/redis";
import {
  DEPLOYMENT_ID_RE,
  ROUTE_TTL_SECONDS,
} from "@shipyard/shared/constants";
import { isValidSlug } from "@shipyard/shared/slug";
import { redis, env, log } from "./lib/clients.js";

/** What the router serves for a hostname: one deployment's files. */
export interface Target {
  /** Deployment whose files are served, from `deployments/<id>/` in storage. */
  deploymentId: string;
  /** Serve `index.html` for extensionless paths with no matching file (client-side routes). */
  spaFallback: boolean;
}

/**
 * Maps a hostname to what it serves, or `null` if nothing is deployed there.
 * {@link resolveHost} in production; tests pass a stub.
 */
export type Resolver = (hostname: string) => Promise<Target | null>;

/**
 * Reads a cached route. Any failure (Redis down, a corrupted value) is logged
 * and treated as a miss, so the caller falls back to Postgres: the cache can
 * make routing faster, but never make it fail.
 */
async function readCachedRoute(slug: string): Promise<Target | null> {
  try {
    const cached = await redis.get(keys.route(slug));
    // Trusted as-is: see "Cached values aren't validated" on resolveHost.
    return cached ? (JSON.parse(cached) as Target) : null;
  } catch (err) {
    log.warn({ err, slug }, "route cache read failed; using Postgres");
    return null;
  }
}

/**
 * Caches a route for `ROUTE_TTL_SECONDS`. A failure is logged and ignored:
 * the route was already found in Postgres, and it will simply be looked up
 * there again next time.
 */
async function cacheRoute(slug: string, target: Target): Promise<void> {
  try {
    await redis.set(
      keys.route(slug),
      JSON.stringify(target),
      "EX",
      ROUTE_TTL_SECONDS,
    );
  } catch (err) {
    log.warn({ err, slug }, "route cache write failed");
  }
}

/**
 * Works out which deployment a request's hostname should serve. Accepts
 * exactly one label in front of `BASE_DOMAIN`:
 *
 * - `<deploymentId>.<BASE_DOMAIN>`: a preview of that deployment, served only
 *   once it's `ready`. Read from Postgres on every request, not cached:
 *   previews are rare, and a cached entry would outlive a deleted deployment.
 * - `<slug>.<BASE_DOMAIN>`: the project's live deployment. Cached in Redis
 *   for `ROUTE_TTL_SECONDS`; promoting or deleting a deployment deletes the
 *   cache entry, so a switch takes effect at once.
 *
 * Returns `null` for anything else: other domains (custom domains arrive in
 * Phase 5), the bare base domain, nested subdomains, labels that aren't a
 * valid slug, and projects with no live deployment.
 *
 * Trade-offs:
 * - **A `null` is not cached.** A project's first deployment is served as
 *   soon as it goes live, instead of after a cached "nothing here" expires.
 *   The cost: every request for a well-formed slug that doesn't exist (a bot
 *   trying random subdomains, say) reaches Postgres. It's one indexed lookup,
 *   but if that traffic ever matters, cache misses for a few seconds.
 * - **Cached values aren't validated.** A cache hit is returned as parsed,
 *   trusting that it has the current `Target` shape. If `Target` changes,
 *   entries written by the old code keep the old shape until they expire (at
 *   most `ROUTE_TTL_SECONDS`) or are deleted. When changing `Target`, either
 *   make the new fields optional or change the key name in `keys.route` so
 *   old entries are ignored.
 *
 * Errors: Redis is only a cache, so its failures never fail a request (see
 * {@link readCachedRoute} and {@link cacheRoute}); if Redis is down, every
 * lookup goes to Postgres instead. Postgres errors do propagate: without the
 * database there's no way to know what to serve, so the caller answers 500.
 *
 * @param hostname - The request's hostname, without the port. Must already be
 *   lower case: hostnames are case-insensitive, but slugs are matched exactly.
 */
export async function resolveHost(hostname: string): Promise<Target | null> {
  const suffix = "." + env.BASE_DOMAIN;
  if (!hostname.endsWith(suffix)) return null; // custom domains: Phase 5
  const label = hostname.slice(0, -suffix.length);
  if (label.includes(".")) return null; // no nested subdomains

  // Preview mode: <deploymentId>.<base>. isValidSlug rejects id-shaped labels, so this can't shadow a slug.
  if (DEPLOYMENT_ID_RE.test(label)) {
    const deployment = await prisma.deployment.findUnique({
      where: { id: label },
      select: { status: true, project: { select: { spaFallback: true } } },
    });
    return deployment?.status === "ready"
      ? { deploymentId: label, spaFallback: deployment.project.spaFallback }
      : null;
  }

  if (!isValidSlug(label)) return null;
  const cached = await readCachedRoute(label);
  if (cached) return cached;

  const project = await prisma.project.findUnique({
    where: { slug: label },
    select: { activeDeploymentId: true, spaFallback: true },
  });
  // Not cached: see "A `null` is not cached" above.
  if (!project?.activeDeploymentId) return null;
  const target: Target = {
    deploymentId: project.activeDeploymentId,
    spaFallback: project.spaFallback,
  };
  await cacheRoute(label, target);
  return target;
}
