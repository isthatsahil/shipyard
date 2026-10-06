import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { THEME_CONFIG } from "./src/theme/config.ts";
import { themeScript } from "./src/theme/script.ts";

/** Adds the theme script to <head>: it runs before the body renders, so the first paint already has the right theme. */
const themeScriptPlugin = (): Plugin => ({
  name: "shipyard-theme-script",
  transformIndexHtml: () => [
    {
      tag: "script",
      children: themeScript(THEME_CONFIG),
      injectTo: "head",
    },
  ],
});

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), themeScriptPlugin()],
  resolve: {
    alias: {
      // Must mirror `paths` in tsconfig.app.json: tsconfig only teaches the
      // type checker, so without this the build resolves nothing and dev
      // fails at request time. fileURLToPath keeps it correct on Windows,
      // where a bare import.meta.url path starts with a leading slash.
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: { host: true, port: 5173, allowedHosts: ["app.localhost"] },
});
