import "i18next";

import type { resources } from "./resources";

// Types every t() call against the English catalogs, so a misspelled or
// removed key is a type error rather than a raw key shown to the user.
declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "common";
    keySeparator: false;
    resources: (typeof resources)["en"];
  }
}
