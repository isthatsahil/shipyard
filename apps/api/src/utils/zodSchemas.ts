import { z } from "zod";

export const CreateProject = z.object({
  repoUrl: z.string().min(1),
  branch: z.string().default("main"),
  slug: z.string().optional(),
  name: z.string().optional(),
  rootDir: z.string().default("."),
  installCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  outputDir: z.string().optional(),
  spaFallback: z.boolean().default(true),
  deploy: z.boolean().default(true),
});
