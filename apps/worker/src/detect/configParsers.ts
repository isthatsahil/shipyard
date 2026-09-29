/**
 * Reads output-folder settings from framework config files.
 *
 * The files are matched with regexes, never executed: running a repo's
 * config would run untrusted code outside the build sandbox. The cost is that
 * a computed value (`outDir: path.join(...)`) isn't found; the build still
 * works, and `postBuildScan` finds the output afterwards.
 */
import fs from "node:fs";
import path from "node:path";

/** Contents of the first file in `names` that exists under `root`, or `null`. */
function readFirst(root: string, names: string[]) {
  for (const name of names) {
    const filePath = path.join(root, name);
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath, "utf8");
  }
  return null;
}

/**
 * Removes block comments and whole-line `//` comments, so a commented-out
 * setting isn't picked up. Comments after code on the same line are kept.
 */
const stripComments = (src: string) =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Vite's `build.outDir`, or `null` if there's no config or it isn't set. */
export function viteOutDir(root: string): string | null {
  const src = readFirst(root, [
    "vite.config.ts",
    "vite.config.js",
    "vite.config.mjs",
    "vite.config.mts",
  ]);
  if (!src) return null;
  const match = /outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src));
  return match?.[1] ?? null;
}

/**
 * Next.js settings that affect a static build.
 *
 * @returns `isExport`: whether `output: 'export'` is set, which static hosting
 *   requires. `distDir`: a custom build folder, if set. `found`: whether a
 *   config file exists at all.
 */
export function nextConfig(root: string): {
  distDir: string | null;
  isExport: boolean;
  found: boolean;
} {
  const src = readFirst(root, [
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "next.config.cjs",
  ]);
  if (!src) return { distDir: null, isExport: false, found: false };
  const code = stripComments(src);
  const isExport = /output\s*:\s*['"`]export['"`]/.test(code);
  const distDir = /distDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(code)?.[1] ?? null;
  return { distDir, isExport, found: true };
}

/** Vue CLI's `outputDir`, or `null` if there's no config or it isn't set. */
export function vueCliOutputDir(root: string): string | null {
  const src = readFirst(root, ["vue.config.js", "vue.config.cjs"]);
  return src
    ? (/outputDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src))?.[1] ??
        null)
    : null;
}

/**
 * SvelteKit settings that affect a static build.
 *
 * @returns `usesStaticAdapter`: whether `@sveltejs/adapter-static` is used,
 *   which static hosting requires. `pages`: the adapter's output folder, if set.
 */
export function svelteKitConfig(root: string): {
  pages: string | null;
  usesStaticAdapter: boolean;
} {
  const src = readFirst(root, ["svelte.config.js", "svelte.config.mjs"]);
  if (!src) return { pages: null, usesStaticAdapter: false };
  const code = stripComments(src);
  return {
    usesStaticAdapter: /@sveltejs\/adapter-static/.test(code),
    pages: /pages\s*:\s*['"`]([^'"`]+)['"`]/.exec(code)?.[1] ?? null,
  };
}

/** Astro's `outDir`, or `null` if there's no config or it isn't set. */
export function astroOutDir(root: string): string | null {
  const src = readFirst(root, [
    "astro.config.mjs",
    "astro.config.ts",
    "astro.config.js",
  ]);
  return src
    ? (/outDir\s*:\s*['"`]([^'"`]+)['"`]/.exec(stripComments(src))?.[1] ?? null)
    : null;
}
