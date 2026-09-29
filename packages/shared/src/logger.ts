import { pino, type Logger } from "pino";

/**
 * Creates a service's logger. Every service makes exactly one, in its
 * `lib/clients.ts`, and passes it to anything that logs (including `pino-http`).
 *
 * Logs are JSON lines on stdout. The process never writes log files: Docker
 * captures stdout (`docker compose logs <service>`) and a shipper forwards it
 * from there (Phase 6). When stdout is a terminal (`pnpm dev`), lines are
 * pretty-printed instead.
 *
 * Every line carries `service` and an ISO `time`. Credentials and user secrets
 * are replaced with `[Redacted]`, so objects that contain them can be logged whole.
 *
 * For per-job or per-request context, use `log.child({ deploymentId })`
 * instead of repeating the field on every call.
 *
 * @param service - Name added to every line, e.g. `"api"`.
 * @param level - Minimum level to output, normally `env.LOG_LEVEL`.
 *
 * @example
 * export const log = createLogger("api", env.LOG_LEVEL);
 */
export function createLogger(service: string, level: string): Logger {
  return pino({
    level,
    base: { service },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: [
      "req.headers.authorization",
      "req.headers.cookie",
      "*.accessToken",
      "*.envVars",
      "*.gitToken",
    ],
    transport: process.stdout.isTTY ? { target: "pino-pretty" } : undefined,
  });
}
