import { DEPLOYMENT_ID_RE, RESERVED, SLUG_RE } from "./constants";

/**
 * Checks whether a string can be used as a slug.
 *
 * @param s - The candidate slug.
 * @returns `true` if `s` matches {@link SLUG_RE}, is not a reserved name, and
 * does not look like a deployment id ({@link DEPLOYMENT_ID_RE}).
 *
 * @example
 * isValidSlug("my-app");                    // true
 * isValidSlug("api");                       // false (reserved)
 * isValidSlug("-bad");                      // false (leading hyphen)
 * isValidSlug("cmg2x8k0a0000abcd1234efgh"); // false (deployment id shape)
 */
export function isValidSlug(slug: string) {
  return (
    SLUG_RE.test(slug) && !RESERVED.has(slug) && !DEPLOYMENT_ID_RE.test(slug)
  );
}

/**
 * Turns free-form text into a slug candidate. Lowercases the input, replaces
 * each run of non-alphanumeric characters with a single hyphen, trims
 * leading and trailing hyphens, and truncates to 40 characters.
 *
 * The result is not guaranteed to be valid: it may be too short, reserved,
 * or end in a hyphen after truncation. Check it with {@link isValidSlug}.
 *
 * @param input - Any text, such as a project name.
 * @returns The slugified string, at most 40 characters long.
 *
 * @example
 * slugify("My Cool App!"); // "my-cool-app"
 */
export function slugify(input: string) {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Generates a random string of lowercase letters and digits, for making
 * slugs unique (for example `my-app-x7k2`).
 *
 * Uses `Math.random`, so it is not cryptographically secure.
 *
 * @param n - Number of characters to generate. Defaults to 4.
 * @returns A random string of length `n`.
 */
export function randomSuffix(length = 4) {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(
    { length },
    () => chars[Math.floor(Math.random() * chars.length)],
  ).join("");
}
