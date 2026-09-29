import { EN_MESSAGES } from "@shipyard/shared/messages";

import enCommon from "./locales/en/common.json";

/**
 * Locales the dashboard ships. To add one, add `locales/<lng>/common.json`
 * and `locales/<lng>/errors.json`, register them in `resources`, and list the
 * code here. Keys a locale is missing fall back to English.
 */
export const SUPPORTED_LANGUAGES = ["en"] as const;

/**
 * Catalogs per locale. The English `errors` namespace is the shared
 * `EN_MESSAGES`, the same text the API and worker use as their fallback, so
 * server and dashboard wording can never drift apart.
 */
export const resources = {
  en: { common: enCommon, errors: EN_MESSAGES },
} as const;
