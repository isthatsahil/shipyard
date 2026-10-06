/**
 * Frameworks `detectFramework` recognises. `static` is a site with no build
 * step; `unknown` has a build script but no dependency we recognise, so the
 * output folder is found after the build instead.
 */
export type Framework =
  | "next"
  | "vite"
  | "cra"
  | "vue-cli"
  | "sveltekit"
  | "astro"
  | "static"
  | "unknown";
/** Chosen from the lockfile in the repo; `npm` when there is none. */
export type PackageManager = "npm" | "pnpm" | "yarn";

/**
 * Build settings the user set on the project. A value here wins over what
 * detection finds; `null` or missing means "detect it".
 */
export interface ProjectOverrides {
  installCmd?: string | null;
  buildCmd?: string | null;
  /** Relative to the repo root, e.g. `dist`. */
  outputDir?: string | null;
  /** Node major version; ignored unless it's one we have a builder image for. */
  nodeVersion?: string | null;
}

/** How to build a repo: detected values, with the project's overrides applied. */
export interface DetectResult {
  framework: Framework;
  packageManager: PackageManager;
  installCmd: string | null; // null → skip install
  buildCmd: string | null; // null → skip build
  outputDir: string | null; // null → resolve after build via postBuildScan
  /** Node major version; selects the `shipyard/builder:node<version>` image. */
  nodeVersion: "20" | "22" | "24";
  /** Problems worth showing the user, e.g. a Next.js app without static export. */
  warnings: string[];
}
