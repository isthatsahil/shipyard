import type { Deployment, Project } from "@shipyard/db";
import type { ObjectWriter } from "@shipyard/shared/storage";
import type { DetectResult } from "../detect/index.js";
import type { BuildLogger } from "../lib/logs.js";

/**
 * State for one build, passed to every pipeline step. Created by
 * `runPipeline`; the optional fields are filled in by earlier steps for later
 * ones.
 */
export interface BuildContext {
  deployment: Deployment;
  project: Project;
  store: ObjectWriter; // injected; upload only needs put()
  workDir: string; // inside worker container: /builds/<id>
  hostWorkDir: string; // same dir as the Docker daemon sees it
  repoRoot: string; // workDir + project.rootDir
  gitToken?: string; // Phase 3
  envVars: string[]; // Phase 3 ("KEY=value")
  /** Set by the detect step. */
  detect?: DetectResult;
  /** Top-level folders before the build; set by the detect step. */
  dirsBefore?: Set<string>;
  /** Absolute path of the output folder; set by the resolveOutput step. */
  outputPath?: string;
  /** Build log shown to the user. */
  logger: BuildLogger;
  signal: AbortSignal; // Phase 4 cancellation
}
