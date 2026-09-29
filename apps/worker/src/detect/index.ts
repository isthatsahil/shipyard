import fs from "node:fs";
import path from "node:path";
import type { DetectResult, ProjectOverrides } from "./types.js";
import {
  readPackageJson,
  detectPackageManager,
  frameworkFromDeps,
  DEFAULT_OUTPUT,
  installCommandFor,
  buildCommandFor,
  nodeVersionFromEngines,
} from "./packageJson.js";
import {
  viteOutDir,
  nextConfig,
  vueCliOutputDir,
  svelteKitConfig,
  astroOutDir,
} from "./configParsers.js";

export * from "./types.js";
export { postBuildScan, snapshotDirs } from "./postBuildScan.js";

type NodeVersion = DetectResult["nodeVersion"];
const NODE_VERSIONS: readonly NodeVersion[] = ["20", "22", "24"];

function isNodeVersion(v: string | null | undefined): v is NodeVersion {
  return NODE_VERSIONS.includes(v as NodeVersion);
}

function nodeVersionOverride(overrides: ProjectOverrides): NodeVersion | null {
  return isNodeVersion(overrides.nodeVersion) ? overrides.nodeVersion : null;
}

/**
 * Works out how to build a repo: framework, package manager, install and
 * build commands, output folder and Node version.
 *
 * Reads `package.json`, lockfiles and framework config files; it never runs
 * anything from the repo. A repo with no `package.json`, or no `build`
 * script, is treated as a plain static site with nothing to build.
 *
 * @param root - The repo root (after applying the project's `rootDir`).
 * @param overrides - The project's build settings; each non-null value wins
 *   over detection.
 * @returns The build plan. `warnings` lists problems to show the user, e.g. a
 *   Next.js app without static export; they don't stop the build.
 */
export function detectFramework(
  root: string,
  overrides: ProjectOverrides = {},
): DetectResult {
  const warnings: string[] = [];
  const pkg = readPackageJson(root);

  // Plain static site: no package.json, or no build script.
  if (!pkg.exists || !pkg.scripts.build) {
    if (pkg.exists)
      warnings.push(
        'package.json has no "build" script — treating as a static site.',
      );
    if (
      !fs.existsSync(path.join(root, overrides.outputDir ?? ".", "index.html"))
    ) {
      warnings.push("No index.html found at the site root.");
    }
    return {
      framework: "static",
      packageManager: "npm",
      installCmd: overrides.installCmd ?? null,
      buildCmd: overrides.buildCmd ?? null,
      outputDir: overrides.outputDir ?? ".",
      nodeVersion: nodeVersionOverride(overrides) ?? "22",
      warnings,
    };
  }

  const packageManager = detectPackageManager(root);
  const framework = frameworkFromDeps(pkg.deps);
  let outputDir: string | null = DEFAULT_OUTPUT[framework];

  switch (framework) {
    case "vite":
      outputDir = viteOutDir(root) ?? outputDir;
      break;
    case "next": {
      const config = nextConfig(root);
      if (!config.isExport)
        warnings.push(
          "Next.js: `output: 'export'` not found in next.config — only static export is supported. The build may succeed but produce no `out/` directory.",
        );
      if (config.distDir)
        warnings.push(
          `Next.js: custom distDir "${config.distDir}" ignored; static export always writes to out/.`,
        );
      break;
    }
    case "vue-cli":
      outputDir = vueCliOutputDir(root) ?? outputDir;
      break;
    case "sveltekit": {
      const config = svelteKitConfig(root);
      if (!config.usesStaticAdapter)
        warnings.push(
          "SvelteKit: @sveltejs/adapter-static not detected — a static build requires it.",
        );
      outputDir = config.pages ?? outputDir;
      break;
    }
    case "astro":
      outputDir = astroOutDir(root) ?? outputDir;
      break;
    case "unknown":
      warnings.push(
        "Framework not recognised; will run `npm run build` and look for an output directory afterwards.",
      );
      break;
  }

  return {
    framework,
    packageManager,
    installCmd: overrides.installCmd ?? installCommandFor(packageManager, root),
    buildCmd: overrides.buildCmd ?? buildCommandFor(packageManager),
    outputDir: overrides.outputDir ?? outputDir,
    nodeVersion:
      nodeVersionOverride(overrides) ??
      nodeVersionFromEngines(pkg.engines) ??
      "22",
    warnings,
  };
}
