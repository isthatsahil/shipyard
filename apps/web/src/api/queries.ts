import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { api } from "./client";
import { isTerminal, type ProjectListParams } from "./types";

export const queryKeys = {
  projects: (params: ProjectListParams) => ["projects", params] as const,
  project: (id: string) => ["project", id] as const,
  deployments: (projectId: string) => ["deployments", projectId] as const,
  deployment: (id: string) => ["deployment", id] as const,
};

export const useProjects = (params: ProjectListParams) => {
  return useQuery({
    queryKey: queryKeys.projects(params),
    queryFn: () => api.projects(params),
    placeholderData: keepPreviousData,
  });
};

export const useProject = (id: string) =>
  useQuery({ queryKey: queryKeys.project(id), queryFn: () => api.project(id) });

export const useDeployments = (projectId: string) =>
  useInfiniteQuery({
    queryKey: queryKeys.deployments(projectId),
    queryFn: ({ pageParam }) => api.deployments(projectId, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.next ?? undefined,
    // Fast while a build is running, slow otherwise (a push can still start one).
    refetchInterval: (query) =>
      query.state.data?.pages[0]?.items.some((row) => !isTerminal(row.status))
        ? 5_000
        : 30_000,
  });

export const useDeployment = (id: string) =>
  useQuery({
    queryKey: queryKeys.deployment(id),
    queryFn: () => api.deployment(id),
    // Polls for fields SSE doesn't carry (commit SHA and message); stops once the build is over.
    refetchInterval: (query) =>
      query.state.data && isTerminal(query.state.data.status) ? false : 3_000,
  });

// `silent`: the form shows these errors inline, so the global toast skips them.
export const useDetect = () =>
  useMutation({ mutationFn: api.detect, meta: { silent: true } });
export const useCreateProject = () =>
  useMutation({ mutationFn: api.createProject, meta: { silent: true } });

export function useDeploy(projectId: string) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: () => api.deploy(projectId),
    onSuccess: (deployment) => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.deployments(projectId),
      });
      navigate(`/deployments/${deployment.id}`);
    },
  });
}

export function usePromote(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: api.promote,
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.project(projectId),
      });
      void queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
