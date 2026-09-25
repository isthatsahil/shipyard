import { z } from "zod";

const base = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  LOG_LEVEL: z
    .enum(["trace", "debug", "info", "warn", "error"])
    .default("info"),
  BASE_DOMAIN: z.string().default("localhost"),
  DATABASE_URL: z.url(),
  REDIS_URL: z.url(),
  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().default("auto"),
  S3_BUCKET: z.string().default("deployments"),
  S3_ACCESS_KEY: z.string(),
  S3_SECRET_KEY: z.string(),
  // NOT z.coerce.boolean(): that is Boolean(input), so the string "false" parses as true.
  S3_FORCE_PATH_STYLE: z
    .enum(["true", "false"])
    .default("true")
    .transform((v) => v === "true"),
});

export type BaseEnv = z.infer<typeof base>;

/** Parse process.env against the base schema plus any service-specific extension. */
export function loadEnv<T extends z.ZodRawShape = Record<string, never>>(
  extra?: T,
) {
  // Always extend, even with an empty shape: a ternary here would make `schema`
  // a union type and z.infer would collapse back to the base, so `env.PORT`
  // would be a type error at every call site.
  const schema = base.extend(extra ?? ({} as T));
  const result = schema.safeParse(process.env);
  if (!result.success) {
    console.error(
      "Invalid environment:\n" +
        result.error.issues
          .map((i) => `  ${i.path.join(".")}: ${i.message}`)
          .join("\n"),
    );
    process.exit(1);
  }
  return result.data;
}
