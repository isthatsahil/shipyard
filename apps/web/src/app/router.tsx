import { createBrowserRouter } from "react-router";

export const router = createBrowserRouter([
  {
    path: "/",
    lazy: async () => ({
      Component: (await import("@/App")).default,
    }),
  },
  {
    path: "projects",
    lazy: async () => ({
      Component: (await import("@/features/projects/ProjectListPage")).default,
    }),
  },
  {
    path: "new",
    lazy: async () => ({
      Component: (await import("@/features/projects/ProjectListPage")).default,
    }),
  },
  {
    path: "projects/:id",
    lazy: async () => ({
      Component: (await import("@/features/projects/ProjectListPage")).default,
    }),
  },
  {
    path: "deployments/:id",
    lazy: async () => ({
      Component: (await import("@/features/deployments/DeploymentPage"))
        .default,
    }),
  },
]);
