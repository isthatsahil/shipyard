import app from "./index.js";
import { env, log } from "./lib/clients.js";

app.listen(env.PORT, () => log.info({ port: env.PORT }, "listening"));
