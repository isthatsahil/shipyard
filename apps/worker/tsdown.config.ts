import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  target: "node22",
  // Emit .js, not tsdown's default .mjs. This package is `"type": "module"`, so
  // .js is already ESM, and the Dockerfile's CMD and `pnpm start` both name it.
  outExtensions: () => ({ js: ".js" }),
  deps: {
    // Inline the workspace packages so the production tree needs no @shipyard/*.
    // This app's own `dependencies` stay external and are installed by `pnpm deploy`.
    alwaysBundle: [/^@shipyard\//],
    // Bundling the workspace packages' own dependencies is the intent here, not an
    // accident, so silence the hint that offers to guard against it.
    onlyBundle: false,
  },
});
