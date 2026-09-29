import type { RequestHandler } from "express";
import type { z } from "zod";

/** The part of the request a schema checks. */
type Source = "body" | "query" | "params";

/**
 * Parses `req[source]` with `schema`, replacing it with the parsed
 * (defaulted, coerced) value. A failure is passed to `errorHandler` as the
 * `ZodError`, which answers 400 `api.validation_failed`.
 *
 * Use one schema per source, so field names in errors stay unprefixed
 * (`"cursor"`, not `"query.cursor"`).
 *
 * @example
 * projects.post("/", validate(CreateProject), handler);
 * projects.get("/:id/deployments", validate(Page, "query"), handler);
 */
export const validate =
  (schema: z.ZodType, source: Source = "body"): RequestHandler =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(result.error);
    // Express 5 makes req.query a getter, so plain assignment is ignored.
    Object.defineProperty(req, source, {
      value: result.data,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    next();
  };
