/**
 * Constants used only by the worker. Values shared with other services belong
 * in `@shipyard/shared/constants` instead.
 */

/** Prefix of every GitHub HTTPS clone URL. */
export const GITHUB_URL = "https://github.com/";

/**
 * GitHub HTTPS clone URL prefix with an access token in it, for cloning
 * private repos. `x-access-token` is the username GitHub expects for app and
 * OAuth tokens.
 *
 * The result contains a secret: never log it or put it in an error message.
 */
export const githubAuthUrl = (token: string) =>
  `https://x-access-token:${token}@github.com/`;

/**
 * Matches the credentials part of a URL built with {@link githubAuthUrl}, so
 * it can be removed from git's error output before that is shown to users.
 */
export const GITHUB_TOKEN_RE = /x-access-token:[^@]+@/g;
