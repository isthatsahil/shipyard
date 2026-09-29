import {
  formatEnglish,
  type MessageCode,
  type MessageParams,
  type UserMessage,
} from "./messages";

/**
 * Base class for errors raised while a deployment pipeline runs (clone,
 * build, upload). Each error carries:
 *
 * - `message`: technical description for internal logs.
 * - `code` + `params`: a translatable {@link UserMessage} for the dashboard.
 * - `userMessage`: the same message rendered in English, for build logs and
 *   as a fallback wherever translation is not available.
 *
 * `name` is set to the name of the subclass, so logs show e.g.
 * `BuildFailedError` instead of `Error`.
 */
export class PipelineError extends Error {
  readonly code: MessageCode;
  readonly params?: MessageParams;
  readonly userMessage: string;

  /**
   * @param message - Technical description for internal logs.
   * @param code - Message code the dashboard translates.
   * @param params - Values interpolated into the translated message.
   */
  constructor(message: string, code: MessageCode, params?: MessageParams) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.params = params;
    this.userMessage = formatEnglish(code, params);
  }
}

/** Thrown when the project's git repository cannot be cloned. */
export class CloneError extends PipelineError {
  /**
   * @param message - Technical detail, such as git's stderr. Strip any
   * credentials from it first.
   * @param branch - The branch that was being cloned, shown to the user.
   */
  constructor(message: string, branch: string) {
    super(message, "pipeline.clone_failed", { branch });
  }
}

/** Thrown when the build command exits with a non-zero code. */
export class BuildFailedError extends PipelineError {
  /** @param exitCode - The exit code of the build process. */
  constructor(public exitCode: number) {
    super(`build exited with code ${exitCode}`, "pipeline.build_failed", {
      exitCode,
    });
  }
}

/** Thrown when the build runs longer than the allowed time and is stopped. */
export class BuildTimeoutError extends PipelineError {
  /**
   * @param ms - The time limit that was exceeded, in milliseconds. The user
   * message shows it rounded to whole minutes, and at least 1.
   */
  constructor(ms: number) {
    super(`build timed out after ${ms}ms`, "pipeline.build_timeout", {
      minutes: Math.max(1, Math.round(ms / 60000)),
    });
  }
}

/** Thrown when a build is cancelled before it finishes. */
export class BuildCancelledError extends PipelineError {
  constructor() {
    super("cancelled", "pipeline.cancelled");
  }
}

/**
 * Thrown when none of the expected build output directories exist after
 * the build finishes.
 */
export class OutputNotFoundError extends PipelineError {
  /**
   * @param tried - The directory paths that were checked, in order. They are
   * listed in both messages.
   */
  constructor(tried: string[]) {
    super(
      `no output directory (tried ${tried.join(", ")})`,
      "pipeline.output_not_found",
      { tried: tried.join(", ") },
    );
  }
}

/**
 * Thrown when the project's root directory resolves to a path outside the
 * cloned repository (for example `../other`).
 */
export class RootDirError extends PipelineError {
  /** @param rootDir - The root directory as the user set it. */
  constructor(rootDir: string) {
    super(
      `rootDir "${rootDir}" escapes the repository`,
      "pipeline.root_dir_invalid",
      {
        rootDir,
      },
    );
  }
}

/**
 * Converts any thrown value into a translatable message plus its English
 * text. A {@link PipelineError} keeps its own code; anything else becomes
 * `pipeline.internal`, so unexpected error details never reach the user.
 *
 * @example
 * const { code, params, fallback } = toUserMessage(e);
 * await setStatus(id, "failed", { error: fallback, errorCode: code, errorParams: params });
 */
export function toUserMessage(e: unknown): UserMessage & { fallback: string } {
  if (e instanceof PipelineError) {
    return { code: e.code, params: e.params, fallback: e.userMessage };
  }
  return {
    code: "pipeline.internal",
    fallback: formatEnglish("pipeline.internal"),
  };
}
