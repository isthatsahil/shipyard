import app from "./index.js";
import { env } from "./lib/clients.js";

app.listen(env.PORT, () => console.log(`router listening on ${env.PORT}`));
