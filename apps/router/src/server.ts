import { createApp } from "./index.js";

import { env, log, storage } from "./lib/clients.js";
import { resolveHost } from "./resolve.js";

createApp({
  store: storage,
  resolve: resolveHost,
  logLevel: env.LOG_LEVEL,
}).listen(env.PORT, () => log.info(`router listening on ${env.PORT}`));
