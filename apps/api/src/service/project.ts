import { prisma } from "@shipyard/db";
import { isValidSlug, slugify, randomSuffix } from "@shipyard/shared/slug";
import { HttpError } from "../lib/httpError.js";
import { GITHUB_RE } from "../utils/consts.js";

export function normaliseRepoUrl(input: string) {
  // Both groups are required by the regex, but noUncheckedIndexedAccess
  // types them `string | undefined`; checking narrows them to `string`.
  const [, owner, repo] = GITHUB_RE.exec(input.trim()) ?? [];
  if (!owner || !repo) throw new HttpError(400, "api.repo_unsupported");
  return { owner, repo, url: `https://github.com/${owner}/${repo}.git` };
}

export async function uniqueSlug(preferred?: string, fallback?: string) {
  if (preferred) {
    if (!isValidSlug(preferred)) throw new HttpError(400, "api.slug_invalid");
    if (await prisma.project.findUnique({ where: { slug: preferred } }))
      throw new HttpError(409, "api.slug_taken");
    return preferred;
  }
  const base = slugify(fallback ?? "site") || "site";
  for (let i = 0; i < 5; i++) {
    const candidate = i === 0 ? base : `${base}-${randomSuffix()}`;
    if (
      isValidSlug(candidate) &&
      !(await prisma.project.findUnique({ where: { slug: candidate } }))
    )
      return candidate;
  }
  return `${base}-${randomSuffix(8)}`;
}
