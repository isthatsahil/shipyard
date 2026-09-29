import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError } from "zod";
import { HttpError, type ApiErrorBody } from "../lib/httpError.js";

/**
 * Catch-all for unmatched routes. Mount after every router and before
 * {@link errorHandler}, which writes the 404.
 */
export const notFound: RequestHandler = (_req, _res, next) => {
  next(new HttpError(404, "api.not_found"));
};

/** body-parser errors carry a `type` such as `"entity.parse.failed"`. */
function bodyParserType(err: unknown) {
  return typeof err === "object" && err !== null && "type" in err
    ? String(err.type)
    : undefined;
}

/** Maps the errors we recognise to an {@link HttpError}; `undefined` otherwise. */
function toHttpError(err: unknown): HttpError | undefined {
  if (err instanceof HttpError) return err;
  if (err instanceof ZodError) {
    // Name the first offending field by its dotted path, e.g. "branch".
    const field = err.issues[0]?.path.join(".") || "request";
    return new HttpError(400, "api.validation_failed", { field });
  }
  const type = bodyParserType(err);
  if (type === "entity.parse.failed")
    return new HttpError(400, "api.bad_request");
  if (type === "entity.too.large") return new HttpError(413, "api.bad_request");
  return undefined;
}

/**
 * The only place that writes API error responses. Express 5 forwards
 * thrown errors and async rejections here, so routes need no try/catch.
 * Mount last.
 *
 * Unknown errors are logged and answered with a bare 500: their message is
 * internal detail and never reaches the client.
 */
export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err);

  let httpError = toHttpError(err);
  if (!httpError) {
    req.log.error({ err }, "unhandled error");
    httpError = new HttpError(500, "api.internal");
  }

  const body: ApiErrorBody = {
    error: {
      code: httpError.code,
      params: httpError.params,
      message: httpError.message,
    },
  };
  res.status(httpError.status).json(body);
};
