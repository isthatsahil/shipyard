import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import { resources, SUPPORTED_LANGUAGES } from "./resources";

void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: SUPPORTED_LANGUAGES,
    fallbackLng: "en",
    // "en-US" → "en", so regional browser settings match a shipped catalog.
    load: "languageOnly",
    ns: ["common", "errors"],
    defaultNS: "common",
    // Message codes are dotted ("pipeline.build_failed") but stored flat.
    keySeparator: false,
    // React already escapes rendered strings.
    interpolation: { escapeValue: false },
    detection: {
      order: ["querystring", "localStorage", "navigator"],
      lookupQuerystring: "lng",
      caches: ["localStorage"],
    },
  });

// Keep <html lang> in sync for screen readers, hyphenation and spellcheck.
const syncHtmlLang = (lng: string) => {
  document.documentElement.lang = lng;
};
i18n.on("languageChanged", syncHtmlLang);
if (i18n.resolvedLanguage) syncHtmlLang(i18n.resolvedLanguage);

export default i18n;
