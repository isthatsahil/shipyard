import fs from "node:fs";
import path from "node:path";
import type { Framework, PackageManager } from "./types.js";
import { readRepoFile } from "./readRepoFile.js";

/** The parts of `package.json` detection needs. */
export interface PkgInfo {
  /** False when the repo root has no `package.json`: a plain static site. */
  exists: boolean;
  /** `dependencies` and `devDependencies` merged, name → version range. */
  deps: Record<string, string>;
  scripts: Record<string, string>;
  engines?: { node?: string };
}

/**
 * Reads `<root>/package.json`. A missing file is not an error: it returns
 * `exists: false` with empty fields.
 *
 * @throws {SyntaxError} If the file exists but isn't valid JSON.
 */
export function readPackageJson(root: string): PkgInfo {
  const src = readRepoFile(root, "package.json");
  if (src === null) return { exists: false, deps: {}, scripts: {} };
  const json = JSON.parse(src);
  return {
    exists: true,
    deps: { ...(json.dependencies ?? {}), ...(json.devDependencies ?? {}) },
    scripts: json.scripts ?? {},
    engines: json.engines,
  };
}

/** Picks the package manager from the lockfile in `root`; `npm` if there is none. */
export function detectPackageManager(root: string): PackageManager {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

/**
 * Picks the framework from the dependency list.
 *
 * Order matters: SvelteKit, Astro and others also depend on `vite`, so the
 * specific frameworks are checked first and plain Vite last.
 */
export function frameworkFromDeps(deps: Record<string, string>): Framework {
  if ("next" in deps) return "next";
  if ("@sveltejs/kit" in deps) return "sveltekit";
  if ("astro" in deps) return "astro";
  if ("react-scripts" in deps) return "cra";
  if ("@vue/cli-service" in deps) return "vue-cli";
  if ("vite" in deps) return "vite";
  return "unknown";
}

/**
 * Where each framework writes its build output by default. Config parsing
 * may override it; `null` means "find it after the build" (`postBuildScan`).
 */
export const DEFAULT_OUTPUT: Record<Framework, string | null> = {
  next: "out",
  sveltekit: "build",
  astro: "dist",
  cra: "build",
  "vue-cli": "dist",
  vite: "dist",
  static: ".",
  unknown: null,
};

/**
 * Install command for a package manager. Uses the lockfile-respecting form
 * where there is a lockfile, so builds install exactly what was committed.
 *
 * The yarn command tries Berry's `--immutable` first and falls back to
 * Yarn 1's `--frozen-lockfile`.
 */
export function installCommandFor(
  packageManager: PackageManager,
  root: string,
) {
  switch (packageManager) {
    case "pnpm":
      return "pnpm install --frozen-lockfile";
    case "yarn":
      return "yarn install --immutable || yarn install --frozen-lockfile";
    default:
      return fs.existsSync(path.join(root, "package-lock.json"))
        ? "npm ci"
        : "npm install";
  }
}

/** Command that runs the repo's `build` script with its package manager. */
export function buildCommandFor(packageManager: PackageManager) {
  return packageManager === "npm"
    ? "npm run build"
    : `${packageManager} run build`;
}

/**
 * Takes the Node major version from `engines.node`, if it names one we have
 * a builder image for. Reads the first `20`, `22` or `24` in the range, so
 * `">=20"` gives `"20"`, and `">=18"` gives `null` (the caller's default).
 */
export function nodeVersionFromEngines(engines?: {
  node?: string;
}): "20" | "22" | "24" | null {
  const match = engines?.node?.match(/(20|22|24)/);
  return match ? (match[1] as "20" | "22" | "24") : null;
}
