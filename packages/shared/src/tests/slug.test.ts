import { describe, expect, it } from "vitest";
import { DEPLOYMENT_ID_RE } from "../constants";
import { isValidSlug } from "../slug";

describe("isValidSlug", () => {
  it.each([
    ["my-app", true],
    ["abc", true],
    ["ab", false], // too short
    ["-bad", false], // leading hyphen
    ["api", false], // reserved
    ["cmg2x8k0a0000abcd1234efgh", false], // deployment id shape
    ["cmg2x8k0a-0000abcd1234efgh", true], // a hyphen can't appear in an id
  ])("%s → %s", (s, expected) => expect(isValidSlug(s)).toBe(expected));
});

describe("DEPLOYMENT_ID_RE", () => {
  it("matches a Prisma cuid", () => {
    expect(DEPLOYMENT_ID_RE.test("cmg2x8k0a0000abcd1234efgh")).toBe(true);
  });
});
