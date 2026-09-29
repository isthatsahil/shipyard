import { createInstance } from "i18next";
import { describe, expect, it } from "vitest";
import { MESSAGE_CODES } from "@shipyard/shared/messages";

import { formatUserMessage } from "./formatMessage";
import { resources } from "./resources";

describe("catalogs", () => {
  const en = resources.en;

  it.each(Object.keys(resources))("%s translates every message code", (lng) => {
    const errors = resources[lng as keyof typeof resources].errors;
    expect(MESSAGE_CODES.filter((code) => !(code in errors))).toEqual([]);
  });

  it.each(Object.keys(resources))("%s has every common key", (lng) => {
    const common = resources[lng as keyof typeof resources].common;
    expect(Object.keys(en.common).filter((key) => !(key in common))).toEqual(
      [],
    );
  });
});

describe("formatUserMessage", () => {
  async function setup(lng = "en") {
    const i18n = createInstance();
    await i18n.init({
      lng,
      fallbackLng: "en",
      keySeparator: false,
      interpolation: { escapeValue: false },
      resources: {
        ...resources,
        // A partial stub locale, to prove missing keys fall back to English.
        xx: { errors: { "pipeline.cancelled": "xx-cancelled" } },
      },
    });
    return i18n;
  }

  it("translates a known code with params", async () => {
    const i18n = await setup();
    expect(
      formatUserMessage(i18n, {
        code: "pipeline.build_failed",
        params: { exitCode: 137 },
      }),
    ).toBe("Build failed with exit code 137. Check the logs above.");
  });

  it("uses the active locale, falling back to English per key", async () => {
    const i18n = await setup("xx");
    expect(formatUserMessage(i18n, { code: "pipeline.cancelled" })).toBe(
      "xx-cancelled",
    );
    expect(formatUserMessage(i18n, { code: "api.not_found" })).toBe(
      "Not found.",
    );
  });

  it("uses the server fallback for an unknown code", async () => {
    const i18n = await setup();
    expect(
      formatUserMessage(
        i18n,
        { code: "pipeline.from_the_future" },
        "Server text.",
      ),
    ).toBe("Server text.");
  });

  it("uses a generic message when there is nothing to go on", async () => {
    const i18n = await setup();
    expect(formatUserMessage(i18n, { code: null })).toBe(
      "Internal error during build.",
    );
  });
});
