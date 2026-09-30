import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Non-default output folder: detection must read this instead of assuming dist/.
  build: { outDir: "public_html" },
});
