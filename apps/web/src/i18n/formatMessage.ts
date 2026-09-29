import type { i18n as I18n, TOptions } from "i18next";
import type { MessageCode, MessageParams } from "@shipyard/shared/messages";

/**
 * A message code as it arrives from the server: an API error body, or a
 * deployment's `errorCode`/`errorParams` columns. Both may be null on rows
 * written before codes existed.
 */
export interface ServerMessage {
  code?: string | null;
  params?: unknown;
}

/**
 * Translates a server message into the current locale.
 *
 * Falls back to `fallback` (the server's English text) when the code is
 * missing or unknown to this build of the dashboard, for example a row
 * written by a newer worker, and to a generic error when there is neither.
 *
 * @example
 * const { i18n } = useTranslation();
 * formatUserMessage(
 *   i18n,
 *   { code: deployment.errorCode, params: deployment.errorParams },
 *   deployment.error,
 * );
 */
export function formatUserMessage(
  i18n: I18n,
  msg: ServerMessage,
  fallback?: string | null,
): string {
  const { code, params } = msg;
  if (code && i18n.exists(code, { ns: "errors" })) {
    // The code is only known at runtime, so the per-key interpolation types
    // cannot apply; `exists` above is the real check.
    const t = i18n.getFixedT(null, "errors") as unknown as (
      key: MessageCode,
      options: TOptions,
    ) => string;
    // Values go in `replace`, not spread into the options, so a param can
    // never collide with an i18next option such as `lng` or `ns`.
    return t(code as MessageCode, { replace: (params ?? {}) as MessageParams });
  }
  return fallback ?? i18n.t("pipeline.internal", { ns: "errors" });
}
