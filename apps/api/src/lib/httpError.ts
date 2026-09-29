import {
  formatEnglish,
  type MessageCode,
  type MessageParams,
  type UserMessage,
} from "@shipyard/shared/messages";

/**
 * Body of every API error response. The dashboard translates `code` and
 * `params`; `message` is the English text, for curl, logs and fallback.
 */
export interface ApiErrorBody {
  error: UserMessage & { message: string };
}

/**
 * A client-facing failure. Routes and services throw it; middleware passes
 * it to `next`. `errorHandler` turns it into an {@link ApiErrorBody} with
 * this status. Anything else that reaches the handler is answered as a 500.
 *
 * Inside a callback that runs outside the handler's promise (a timer, a
 * stream event), a throw crashes the process: call `next(err)` there.
 *
 * @example
 * if (!d) throw new HttpError(404, "api.not_found");
 * // 404 { "error": { "code": "api.not_found", "message": "Not found." } }
 */
export class HttpError extends Error {
  readonly status: number;
  readonly code: MessageCode;
  readonly params?: MessageParams;

  constructor(status: number, code: MessageCode, params?: MessageParams) {
    super(formatEnglish(code, params));
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.params = params;
  }
}
