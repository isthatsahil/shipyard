import { log } from "./lib/clients.js";

// No BullMQ consumer and no HTTP server yet — both arrive in Phase 1, and the
// worker's /health lands on a separate metrics port in Phase 6. This stub
// exists so the image, Compose wiring and env validation are proven now.
log.info("worker up (no consumer yet)");

// Keep the event loop alive; without a queue subscription there is nothing
// else holding the process open.
setInterval(() => {}, 1 << 30);
