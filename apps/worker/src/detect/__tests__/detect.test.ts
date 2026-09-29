import { describe, it, expect } from "vitest";
import path from "node:path";
import { detectFramework } from "../index";

const fixture = (name: string) =>
  path.resolve(__dirname, "../../../../../fixtures", name);

describe("detectFramework", () => {
  it("vite react", () => {
    const result = detectFramework(fixture("vite-react"));
    expect(result).toMatchObject({
      framework: "vite",
      outputDir: "dist",
      buildCmd: "npm run build",
    });
  });
  it("vite custom outDir", () =>
    expect(detectFramework(fixture("vite-custom-outdir")).outputDir).toBe(
      "public_html",
    ));
  it("next export", () => {
    const result = detectFramework(fixture("next-export"));
    expect(result.framework).toBe("next");
    expect(result.outputDir).toBe("out");
    expect(result.warnings).toHaveLength(0);
  });
  it("cra", () =>
    expect(detectFramework(fixture("cra")).outputDir).toBe("build"));
  it("sveltekit static", () =>
    expect(detectFramework(fixture("sveltekit-static")).outputDir).toBe(
      "build",
    ));
  it("plain html", () => {
    const result = detectFramework(fixture("plain-html"));
    expect(result).toMatchObject({
      framework: "static",
      installCmd: null,
      buildCmd: null,
      outputDir: ".",
    });
  });
  it("overrides win", () =>
    expect(
      detectFramework(fixture("vite-react"), { outputDir: "custom" }).outputDir,
    ).toBe("custom"));
});
