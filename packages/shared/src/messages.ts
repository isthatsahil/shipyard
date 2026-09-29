/**
 * User-facing message codes, shared by every service and the dashboard.
 *
 * Servers never send finished UI text. They send a {@link UserMessage}, a
 * stable code plus parameters, and the dashboard translates it with i18next.
 * The English text in {@link EN_MESSAGES} is the source catalog for the
 * dashboard's `en` locale and the fallback for logs, curl and older rows.
 *
 * This file is imported by the browser bundle, so it must stay free of Node
 * imports and of TypeScript-only runtime syntax (enums, parameter properties).
 */

/** Values interpolated into a message template, e.g. `{ exitCode: 1 }`. */
export type MessageParams = Record<string, string | number>;

/**
 * English templates for every message code, in i18next syntax
 * (`{{name}}` placeholders). Keys are dot-namespaced by area but stored flat,
 * so the dashboard runs i18next with `keySeparator: false`.
 *
 * Adding a code here makes it available everywhere. Other locales that lack
 * it fall back to this English text.
 */
export const EN_MESSAGES = {
  "pipeline.clone_failed":
    'Could not clone branch "{{branch}}". Check the repository URL and branch name.',
  "pipeline.build_failed":
    "Build failed with exit code {{exitCode}}. Check the logs above.",
  "pipeline.build_timeout":
    "Build exceeded the {{minutes}} minute limit and was stopped.",
  "pipeline.cancelled": "Build was cancelled.",
  "pipeline.output_not_found":
    'Could not find a build output directory (tried: {{tried}}). Set "Output directory" on the project.',
  "pipeline.root_dir_invalid":
    'Root directory "{{rootDir}}" is outside the repository. Set "Root directory" on the project to a folder inside it.',
  "pipeline.internal": "Internal error during build.",
  "api.bad_request": "The request could not be processed.",
  "api.not_found": "Not found.",
  "api.internal": "Something went wrong on our side.",
  "api.validation_failed": "Invalid value for {{field}}.",
  "api.repo_unsupported": "Only GitHub repositories are supported.",
  "api.invalid_root_dir": "The root directory must be inside the repository.",
  "api.promote_not_ready": "Only ready deployments can be promoted.",
  "api.delete_active": "The active deployment cannot be deleted.",
  "api.deployment_in_progress": "This deployment is still in progress.",
  "api.enqueue_failed": "Could not queue the build. Try deploying again.",
  "api.slug_invalid":
    "Use 3–40 lowercase letters, digits or hyphens, starting and ending with a letter or digit.",
  "api.slug_taken": "That subdomain is already taken.",
  "api.cancel_not_allowed": "A {{status}} deployment cannot be cancelled.",
  "api.domain_is_subdomain":
    "Use the project's own subdomain instead of adding it as a custom domain.",
  "api.unauthenticated": "Sign in to continue.",
  "api.bad_origin": "This request came from an origin that is not allowed.",
  "api.oauth_state_invalid":
    "GitHub sign-in expired or was tampered with. Try again.",
  "api.oauth_token_failed": "GitHub sign-in failed. Try again.",
  "api.webhook_signature_invalid": "Webhook signature does not match.",
} as const satisfies Record<string, string>;

/** A stable identifier for a user-facing message, e.g. `"pipeline.build_failed"`. */
export type MessageCode = keyof typeof EN_MESSAGES;

/** Every message code, for iterating (e.g. catalog completeness tests). */
export const MESSAGE_CODES = Object.keys(EN_MESSAGES) as MessageCode[];

/** A translatable message as it crosses a service boundary. */
export interface UserMessage {
  code: MessageCode;
  params?: MessageParams;
}

/**
 * Renders a message in English, for logs and API fallback text.
 * Placeholders with no matching param are left as-is.
 *
 * @example
 * formatEnglish("pipeline.build_failed", { exitCode: 1 });
 * // "Build failed with exit code 1. Check the logs above."
 */
export function formatEnglish(code: MessageCode, params?: MessageParams) {
  return EN_MESSAGES[code].replace(/\{\{\s*(\w+)\s*\}\}/g, (m, name: string) =>
    params && name in params ? String(params[name]) : m,
  );
}
