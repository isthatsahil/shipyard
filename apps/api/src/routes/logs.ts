import { randomUUID } from "node:crypto";
import { Router } from "express";
import { prisma } from "@shipyard/db";
import { createRedis, keys } from "@shipyard/shared/redis";
import { logsKey } from "@shipyard/shared/storageKeys";
import { env, log, redis, storage } from "../lib/clients.js";
import { HttpError } from "../lib/httpError.js";
import { TERMINAL } from "../utils/consts.js";

/** Server-Sent Events stream of a deployment's build log. Mounted at `/deployments`. */
export const logs = Router();

/** Marker message on a stream's `logSync` channel: the replay snapshot has been taken. */
const SNAPSHOT = "snapshot";

/** Reads a finished deployment's archived log (`_logs.txt`) as lines, or `[]` if there is none. */
async function readArchivedLog(storagePrefix: string): Promise<string[]> {
  const archived = await storage.get(logsKey(storagePrefix));
  if (!archived) return [];
  const text = await new Promise<string>((resolve, reject) => {
    let collected = "";
    archived.body
      .on("data", (chunk) => (collected += chunk))
      .on("end", () => resolve(collected))
      .on("error", reject);
  });
  return text.split("\n").filter(Boolean);
}

/**
 * GET /deployments/:id/logs — streams a deployment's build log as Server-Sent Events.
 *
 * Replays the log so far (Redis list `logs:<id>`, or the archived `_logs.txt` once Redis
 * has expired it), then, for a build still running, follows new lines live via pub/sub.
 *
 * Events:
 * - unnamed (`message`): one log line; `id` is its index in the Redis list.
 * - `status`: a non-final status change (e.g. `building`).
 * - `done`: the final status; the stream ends and the client must close its EventSource,
 *   or it would reconnect forever.
 *
 * No line is lost or sent twice between the replay and the live tail: the stream
 * subscribes first, then takes the replay snapshot and publishes a marker on its own
 * channel in one `MULTI`. Lines that arrive before the marker are already in the
 * snapshot and are dropped; lines after it are new.
 *
 * On reconnect the browser sends `Last-Event-ID: n`; replay resumes at `n + 1`, so no
 * per-client cursor is stored. A `: ping` comment every 15 s keeps idle proxies from
 * closing the connection.
 *
 * @throws {HttpError} 404 `api.not_found` if the deployment doesn't exist (checked before
 *   any headers are sent, so it can still become a JSON error).
 */
logs.get("/:id/logs", async (req, res) => {
  const deployment = await prisma.deployment.findUnique({
    where: { id: req.params.id },
    select: { id: true, status: true, storagePrefix: true },
  });

  if (!deployment) throw new HttpError(404, "api.not_found");

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no", // disable proxy buffering (nginx); Caddy streams by default
  });

  res.flushHeaders();

  /**
   * Writes one SSE event. Does nothing once the response has ended.
   * @param event - Event name, or `null` for an unnamed event (delivered to `onmessage`).
   * @param data - Payload; must not contain a newline.
   * @param id - Line index, echoed back by the browser as `Last-Event-ID` on reconnect.
   */
  const send = (event: string | null, data: string, id?: number) => {
    if (res.writableEnded) return;
    if (id !== undefined) res.write(`id: ${id}\n`);
    if (event) res.write(`event: ${event}\n`);
    res.write(`data: ${data}\n\n`);
  };

  // Resume from Last-Event-ID (index into the list) after a reconnect.
  const from = Number(req.headers["last-event-id"] ?? -1) + 1;
  const key = keys.logs(deployment.id);
  const statusChannel = keys.status(deployment.id);
  let index = from;

  // 1. Finished build: nothing more will be published, so replay and end.
  if (TERMINAL.has(deployment.status)) {
    let lines = await redis.lrange(key, from, -1);
    // Redis expired the list: fall back to the archived log in storage.
    if (lines.length === 0 && from === 0)
      lines = await readArchivedLog(deployment.storagePrefix);
    for (const line of lines) send(null, line, index++);
    send("done", deployment.status);
    return res.end();
  }

  // 2. Running build: subscribe, take the replay snapshot, then follow live.
  // Dedicated subscriber connection; pub/sub connections cannot run other commands.
  const sub = createRedis(env.REDIS_URL, { subscriber: true });
  sub.on("error", (err) => log.warn({ err }, "log stream subscriber error"));
  const syncChannel = keys.logSync(randomUUID());
  /** The snapshot marker has arrived: later log lines aren't in the replay. */
  let synced = false;
  /** The replay has been sent: live events can go straight to the client. */
  let replayed = false;
  /** Live events that arrived before the replay was sent, in arrival order. */
  const queued: [channel: string, message: string][] = [];
  let finished = false;

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
  /** Stops the heartbeat, closes the Redis subscriber and ends the response. Runs once. */
  const cleanup = () => {
    if (finished) return;
    finished = true;
    clearInterval(heartbeat);
    sub.quit().catch(() => {});
    res.end();
  };
  req.on("close", cleanup);

  /** Sends one live event: a log line, a status change, or the final status. */
  const forward = (channel: string, message: string) => {
    if (finished) return;
    if (channel === key) send(null, message, index++);
    else if (TERMINAL.has(message)) {
      send("done", message);
      cleanup();
    } else send("status", message);
  };

  sub.on("message", (channel, message) => {
    if (channel === syncChannel && message === SNAPSHOT) {
      synced = true;
      return;
    }
    // Published before the snapshot was taken, so the replay already has it.
    if (channel === key && !synced) return;
    // Any other message on syncChannel is a final status found by the re-check below.
    const event: [string, string] =
      channel === syncChannel ? [statusChannel, message] : [channel, message];
    if (replayed) forward(...event);
    else queued.push(event);
  });

  try {
    await sub.subscribe(key, statusChannel, syncChannel);

    // Atomic: no worker write can land between the snapshot and the marker, and the
    // subscriber receives messages in publish order, so the marker splits them exactly.
    const results = await redis
      .multi()
      .lrange(key, from, -1)
      .publish(syncChannel, SNAPSHOT)
      .exec();
    const [err, lines] = results?.[0] ?? [new Error("snapshot aborted"), null];
    if (err) throw err;
    for (const line of lines as string[]) send(null, line, index++);

    replayed = true;
    for (const event of queued.splice(0)) forward(...event);

    // The build may have finished before we subscribed, in which case its final status
    // was published to nobody. If Postgres says it's over, publish that status on our
    // own channel: it arrives after every line the worker flushed before finishing,
    // so the stream ends only once those have been sent.
    const current = await prisma.deployment.findUnique({
      where: { id: deployment.id },
      select: { status: true },
    });
    if (!finished && current && TERMINAL.has(current.status))
      await redis.publish(syncChannel, current.status);
  } catch (err) {
    // Headers are already sent, so this can't become an error response. Ending the
    // stream makes the browser reconnect with Last-Event-ID and resume.
    if (!finished)
      log.warn({ err, deploymentId: deployment.id }, "log stream failed");
    cleanup();
  }
});
