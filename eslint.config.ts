import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  globalIgnores([
    "**/dist/**",
    "**/node_modules/**",
    "**/.prisma/**",
    "packages/db/generated/**",
    // Sample projects used as build fixtures: third-party code, not ours to lint.
    "fixtures/**",
    // Tooling directories, not project source.
    ".claude/**",
    ".agents/**",
    ".impeccable/**",
  ]),

  // Baseline for every file we own.
  {
    files: ["**/*.{js,mjs,cjs,ts,mts,cts,jsx,tsx}"],
    plugins: { js },
    extends: ["js/recommended", tseslint.configs.recommended],
    languageOptions: {
      parserOptions: {
        // Pinned rather than inferred. typescript-eslint guesses this from the
        // directories holding an ESLint config, and refuses to choose when a
        // workspace package has one too — which fails EVERY file in the repo
        // with "multiple candidate TSConfigRootDirs", not just that package's.
        // Naming it here also makes the editor's ESLint server agree with the
        // CLI no matter which directory it decides to run from.
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "no-console": "off",
    },
  },

  // Node services, shared packages, and the dashboard's own build config.
  {
    files: [
      "apps/{api,worker,router}/**/*.ts",
      "packages/**/*.ts",
      "apps/web/vite.config.ts",
      "*.{js,ts}",
    ],
    languageOptions: { globals: globals.node },
  },

  // Dashboard source: browser globals + the React rules that still matter.
  //
  // Deliberately NOT eslint-plugin-react: its latest release (7.37.5) declares
  // `eslint: "^3 || ... || ^9.7"` and crashes under the ESLint 10 this repo
  // runs. It contributed little here anyway — the two rules it is known for,
  // react-in-jsx-scope and prop-types, are both off under the automatic JSX
  // runtime and TypeScript. react-hooks and react-refresh support ESLint 10 and
  // catch the bugs that actually bite: bad hook deps and HMR-breaking exports.
  {
    files: ["apps/web/src/**/*.{ts,tsx}"],
    extends: [reactHooks.configs.flat.recommended, reactRefresh.configs.vite],
    languageOptions: { globals: globals.browser },
    rules: {
      // shadcn/ui components export their cva variants next to the component
      // (e.g. `buttonVariants`) so other components can reuse the styles.
      // Name each one here rather than turning the rule off.
      "react-refresh/only-export-components": ["error", { allowExportNames: ["buttonVariants"] }],
    },
  },
]);
