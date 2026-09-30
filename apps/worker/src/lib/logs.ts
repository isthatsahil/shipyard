import { keys } from "@shipyard/shared/redis";
import { LOG_TTL_SECONDS } from "@shipyard/shared/constants";
import { redis } from "./clients.js";

/**
 * Collects one deployment's build output and writes it to Redis.
 *
 * Each line is written twice, under `keys.logs(deploymentId)`:
 * - appended to a Redis list, so someone who opens the log halfway through can
 *   read it from the start (expires after `LOG_TTL_SECONDS`);
 * - published on the pub/sub channel of the same name, so the dashboard can
 *   follow the build live.
 *
 * Lines are buffered and flushed at most every 50 ms, so a burst of output
 * (an `npm install`, say) costs one Redis round trip instead of one per line.
 *
 * Create one per build job.
 *
 * @example
 * const logger = new BuildLogger(deployment.id);
 * logger.line("clone", `Cloning ${repoUrl}`);
 * logger.pipe("build", containerStream);
 * // ...once the container has exited:
 * await logger.flush();
 */
export class BuildLogger {
  /** Lines added since the last flush. */
  private buffer: string[] = [];
  /** Pending flush, if one is scheduled. */
  private timer?: NodeJS.Timeout;

  /** @param deploymentId - The deployment whose log this writes to. */
  constructor(private deploymentId: string) {}

  /**
   * Adds one log line, stored as `[step] text`. Schedules a flush if none is
   * pending, so the line reaches Redis within about 50 ms.
   *
   * @param step - Build stage the line belongs to, e.g. `clone`, `install`, `build`.
   * @param text - The line itself, without a trailing newline.
   */
  line(step: string, text: string) {
    const entry = `[${step}] ${text}`;
    this.buffer.push(entry);
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 50); // batch bursts of output
  }

  /**
   * Writes all buffered lines to Redis now: appends them to the log list,
   * refreshes its expiry, and publishes each one, in a single `MULTI`.
   * Does nothing if the buffer is empty.
   *
   * Call it before the job finishes so the last lines aren't lost.
   */
  async flush() {
    this.timer = undefined;
    if (!this.buffer.length) return;
    const lines = this.buffer.splice(0);
    const key = keys.logs(this.deploymentId);
    const tx = redis
      .multi()
      .rpush(key, ...lines)
      .expire(key, LOG_TTL_SECONDS);
    for (const entry of lines) tx.publish(key, entry);
    await tx.exec();
  }

  /**
   * Attach a container stream and split it into lines.
   *
   * Chunks can end mid-line, so the unfinished tail is kept until the next
   * chunk completes it, or until the stream ends. Blank lines are dropped.
   * Chunks are decoded as UTF-8 text as-is, so the stream must carry plain
   * output (any framing, such as Docker's stdout/stderr headers, must already
   * be removed).
   *
   * @param step - Build stage every line from this stream is tagged with.
   * @param stream - The output stream, e.g. from `container.attach()` or `container.logs()`.
   */
  pipe(step: string, stream: NodeJS.ReadableStream) {
    let rest = "";
    stream.on("data", (chunk: Buffer) => {
      rest += chunk.toString("utf8");
      const parts = rest.split(/\r?\n/);
      rest = parts.pop() ?? "";
      for (const part of parts) if (part.length) this.line(step, part);
    });
    stream.on("end", () => {
      if (rest) this.line(step, rest);
    });
  }

  /**
   * Flushes, then returns the deployment's whole log from Redis, oldest line
   * first, e.g. to archive it to object storage once the build ends.
   */
  async all(): Promise<string[]> {
    await this.flush();
    return redis.lrange(keys.logs(this.deploymentId), 0, -1);
  }
}
