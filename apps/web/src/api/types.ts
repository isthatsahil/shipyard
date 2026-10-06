export type DeploymentStatus =
  | "queued"
  | "cloning"
  | "detecting"
  | "building"
  | "uploading"
  | "ready"
  | "failed"
  | "cancelled"
  | "archived";

/** Statuses a deployment never leaves; the log stream ends with one of these. */
export const TERMINAL_STATUSES: readonly DeploymentStatus[] = [
  "ready",
  "failed",
  "cancelled",
  "archived",
];
export const isTerminal = (status: DeploymentStatus) =>
  TERMINAL_STATUSES.includes(status);

export interface Deployment {
  id: string;
  projectId: string;
  status: DeploymentStatus;
  commitSha: string | null;
  commitMsg: string | null;
  framework: string | null;
  error: string | null;
  errorCode: string | null;
  errorParams: Record<string, string | number> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  fileCount: number | null;
  sizeBytes: string | null;
}
export type DeploymentDetail = Deployment & { project: { slug: string } };
export type ActiveDeployment = Pick<
  Deployment,
  "id" | "status" | "commitSha" | "framework" | "createdAt" | "finishedAt"
>;
export type LatestDeployment = Pick<
  Deployment,
  "id" | "status" | "commitSha" | "commitMsg" | "createdAt"
>;

export interface Project {
  id: string;
  name: string;
  slug: string;
  repoUrl: string;
  branch: string;
  rootDir: string;
  activeDeploymentId: string | null;
  activeDeployment: ActiveDeployment | null;
  createdAt: string;
  updatedAt: string;
}
export type ProjectListItem = Project & { deployments: LatestDeployment[] };
export type ProjectDetail = Project & {
  deploymentCount: number;
  deployments: Deployment[];
};

export type ProjectSort = "updated" | "name" | "created";
export interface ProjectListParams {
  page: number;
  pageSize: number;
  q?: string;
  sort: ProjectSort;
}

/** A numbered page (`GET /projects`). */
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
/** A cursor page (`GET /projects/:id/deployments`); `next` is null on the last page. */
export interface CursorPage<T> {
  items: T[];
  next: string | null;
}

export interface DetectResult {
  framework: string;
  packageManager: string;
  installCmd: string | null;
  buildCmd: string | null;
  outputDir: string | null;
  nodeVersion: string;
  warnings: string[];
}
export interface CreateProject {
  repoUrl: string;
  branch?: string;
  slug?: string;
  name?: string;
  rootDir?: string;
  installCmd?: string;
  buildCmd?: string;
  outputDir?: string;
  spaFallback?: boolean;
}
