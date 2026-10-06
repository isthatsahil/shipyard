import type {
  CreateProject,
  CursorPage,
  Deployment,
  DeploymentDetail,
  DetectResult,
  Page,
  Project,
  ProjectDetail,
  ProjectListItem,
  ProjectListParams,
} from "./types";

const BASE = import.meta.env.VITE_API_URL ?? "https://api.localhost";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(BASE + path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json();
  if (!response.ok) throw new ApiError(response.status, body.error);
  return body;
}

/** A failed API call. Render it with `formatUserMessage(i18n, err, err.message)`. */
export class ApiError extends Error {
  status: number;
  code?: string;
  params?: Record<string, string | number>;
  constructor(
    status: number,
    error?: {
      code: string;
      params?: Record<string, string | number>;
      message: string;
    },
  ) {
    super(error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = error?.code;
    this.params = error?.params;
  }
}

const query = (params: Record<string, string | number | undefined>) =>
  new URLSearchParams(
    Object.entries(params).flatMap(([key, value]) =>
      value === undefined ? [] : [[key, String(value)]],
    ),
  ).toString();

export const api = {
  projects: (params: ProjectListParams) =>
    req<Page<ProjectListItem>>(`/projects?${query({ ...params })}`),
  project: (id: string) => req<ProjectDetail>(`/projects/${id}`),
  createProject: (body: CreateProject) =>
    req<{ project: Project; deployment: Deployment | null }>("/projects", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deleteProject: (id: string) =>
    req<void>(`/projects/${id}`, { method: "DELETE" }),
  detect: (body: { repoUrl: string; branch?: string; rootDir?: string }) =>
    req<DetectResult>("/detect", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deploy: (projectId: string) =>
    req<Deployment>(`/projects/${projectId}/deployments`, { method: "POST" }),
  deployments: (projectId: string, cursor?: string) =>
    req<CursorPage<Deployment>>(
      `/projects/${projectId}/deployments?${query({ cursor })}`,
    ),
  deployment: (id: string) => req<DeploymentDetail>(`/deployments/${id}`),
  promote: (id: string) =>
    req<{ ok: true; activeDeploymentId: string }>(
      `/deployments/${id}/promote`,
      { method: "POST" },
    ),
  logsUrl: (id: string) => `${BASE}/deployments/${id}/logs`,
};
