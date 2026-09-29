import { describe, it, expect } from "vitest";
import { PassThrough, Readable } from "node:stream";
import type { Request, Response } from "express";
import type { ObjectReader } from "@shipyard/shared/storage";
import { deploymentPrefix } from "@shipyard/shared/storageKeys";
import { serveDeployment } from "../serve";

const PREFIX = deploymentPrefix("d1");

/** A store holding `files` (key relative to the deployment → body), each with ETag `"<key>"`. */
function storeWith(files: Record<string, string>) {
  const bodies: Readable[] = [];
  const store: ObjectReader = {
    async get(key) {
      const rel = key.slice(PREFIX.length);
      const content = files[rel];
      if (content === undefined) return null;
      const body = Readable.from([content]);
      bodies.push(body);
      return { body, contentType: "text/html", etag: `"${rel}"` };
    },
  };
  return { store, bodies };
}

/** Enough of an Express response for serveDeployment: records status, headers and body. */
function fakeResponse() {
  const stream = new PassThrough();
  const headers: Record<string, unknown> = {};
  let body = "";
  stream.on("data", (chunk) => (body += chunk));
  const res = Object.assign(stream, {
    statusCode: 200,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    setHeader(name: string, value: unknown) {
      headers[name.toLowerCase()] = value;
      return res;
    },
    type: () => res,
    send(text: string) {
      body = text;
      stream.end();
      return res;
    },
  });
  const finished = new Promise((resolve) => stream.on("finish", resolve));
  return {
    res: res as unknown as Response,
    headers,
    finished,
    get status() {
      return res.statusCode;
    },
    get body() {
      return body;
    },
  };
}

const request = (path: string, headers: Record<string, string> = {}) =>
  ({ path, headers }) as unknown as Request;

const target = { deploymentId: "d1", spaFallback: false };

describe("serveDeployment revalidation", () => {
  it("answers 304 when If-None-Match matches, and releases the storage stream", async () => {
    const { store, bodies } = storeWith({ "about.html": "about" });
    const out = fakeResponse();
    await serveDeployment(
      store,
      target,
      request("/about.html", { "if-none-match": '"about.html"' }),
      out.res,
    );
    await out.finished;
    expect(out.status).toBe(304);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.destroyed).toBe(true);
  });

  it("sends the file with its ETag when there is no match", async () => {
    const { store } = storeWith({ "about.html": "about" });
    const out = fakeResponse();
    await serveDeployment(store, target, request("/about.html"), out.res);
    await out.finished;
    expect(out.status).toBe(200);
    expect(out.body).toBe("about");
    expect(out.headers["etag"]).toBe('"about.html"');
  });

  it("never answers 304 for a custom 404.html, and sends it without an ETag", async () => {
    const { store } = storeWith({ "404.html": "custom 404" });
    const out = fakeResponse();
    await serveDeployment(
      store,
      target,
      request("/missing", { "if-none-match": '"404.html"' }),
      out.res,
    );
    await out.finished;
    expect(out.status).toBe(404);
    expect(out.body).toBe("custom 404");
    expect(out.headers["etag"]).toBeUndefined();
  });
});
