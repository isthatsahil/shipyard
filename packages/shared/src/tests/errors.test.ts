import { describe, expect, it } from "vitest";
import {
  BuildCancelledError,
  BuildFailedError,
  BuildTimeoutError,
  CloneError,
  OutputNotFoundError,
  RootDirError,
  toUserMessage,
} from "../errors";
import { EN_MESSAGES, formatEnglish } from "../messages";

describe("pipeline errors", () => {
  it.each([
    [
      new CloneError("fatal: repo not found", "main"),
      "pipeline.clone_failed",
      { branch: "main" },
    ],
    [new BuildFailedError(2), "pipeline.build_failed", { exitCode: 2 }],
    [
      new BuildTimeoutError(15 * 60_000),
      "pipeline.build_timeout",
      { minutes: 15 },
    ],
    [new BuildCancelledError(), "pipeline.cancelled", undefined],
    [
      new OutputNotFoundError(["dist", "build"]),
      "pipeline.output_not_found",
      { tried: "dist, build" },
    ],
    [
      new RootDirError("../x"),
      "pipeline.root_dir_invalid",
      { rootDir: "../x" },
    ],
  ])("%s carries code and params", (err, code, params) => {
    expect(err.code).toBe(code);
    expect(err.params).toEqual(params);
    expect(err.userMessage).not.toMatch(/\{\{/);
  });

  it("sets name to the subclass", () => {
    expect(new BuildFailedError(1).name).toBe("BuildFailedError");
  });

  it("never reports a 0 minute timeout", () => {
    expect(new BuildTimeoutError(10_000).params).toEqual({ minutes: 1 });
  });
});

describe("toUserMessage", () => {
  it("keeps a pipeline error's code", () => {
    expect(toUserMessage(new BuildFailedError(1))).toEqual({
      code: "pipeline.build_failed",
      params: { exitCode: 1 },
      fallback: "Build failed with exit code 1. Check the logs above.",
    });
  });

  it("hides unexpected errors behind pipeline.internal", () => {
    expect(toUserMessage(new Error("ECONNREFUSED 10.0.0.3"))).toEqual({
      code: "pipeline.internal",
      fallback: EN_MESSAGES["pipeline.internal"],
    });
  });
});

describe("formatEnglish", () => {
  it("leaves unknown placeholders in place", () => {
    expect(formatEnglish("pipeline.build_failed")).toContain("{{exitCode}}");
  });
});
