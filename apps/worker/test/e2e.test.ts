import { describe, it, expect } from "vitest";

// Caddy's local CA must be trusted by Node through NODE_EXTRA_CA_CERTS (see
// Phase 0, "Trusting the Caddy CA"). Node reads it once at startup, so it can't
// be set from this file. Run `pnpm test:e2e` from the repo root: it points the
// variable at an absolute path to caddy-root.crt, since this suite runs from
// apps/worker, where a relative path wouldn't resolve.
const API = process.env.API_URL ?? "https://api.localhost";
const BASE = process.env.BASE_DOMAIN ?? "localhost";
const OWNER = process.env.FIXTURES_OWNER ?? "isthatsahil"; // see Step 6
const fixture = (name: string) =>
  `https://github.com/${OWNER}/shipyard-fixture-${name}`;

// Only the fields this test reads. It talks to the stack over HTTP like a user,
// so it describes the JSON it gets back rather than importing the API's types.
interface ProjectBody {
  slug: string;
}
interface DeploymentBody {
  id: string;
  status: string;
  error?: string | null;
  errorCode?: string | null;
}

// How long to poll for each kind of case. Each wait is one minute short of that
// test's vitest timeout, so running out of time fails with the deployment's own
// state rather than vitest's generic timeout. The hang wait must outlast the
// worker's BUILD_TIMEOUT_MS (15 min in docker/compose.yaml).
const BUILD_WAIT_MS = 11 * 60_000;
const HANG_WAIT_MS = 19 * 60_000;

async function deploy(
  repoUrl: string,
  waitMs: number,
  extra: Record<string, unknown> = {},
) {
  const response = await fetch(`${API}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repoUrl, ...extra }),
  });
  expect(response.status).toBe(201);
  const { project, deployment } = (await response.json()) as {
    project: ProjectBody;
    deployment: DeploymentBody;
  };
  const deadline = Date.now() + waitMs;
  let latest = deployment;
  while (Date.now() < deadline) {
    latest = (await (
      await fetch(`${API}/deployments/${deployment.id}`)
    ).json()) as DeploymentBody;
    if (["ready", "failed", "cancelled"].includes(latest.status))
      return { project, deployment: latest };
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(
    `timed out waiting for deployment ${deployment.id} (still ${latest.status})`,
  );
}

const cases: [string, string, string][] = [
  ["plain-html", fixture("plain-html"), "plain-html"],
  ["vite-react", fixture("vite-react"), "vite-react"],
  ["vite-custom-outdir", fixture("vite-custom-outdir"), "vite-custom-outdir"],
  ["vue-vite", fixture("vue-vite"), "vue-vite"],
  ["sveltekit-static", fixture("sveltekit-static"), "sveltekit-static"],
  ["next-export", fixture("next-export"), "next-export"],
  ["cra", fixture("cra"), "cra"],
];

describe("end-to-end", () => {
  for (const [name, url, title] of cases) {
    it(
      name,
      async () => {
        const { project, deployment } = await deploy(url, BUILD_WAIT_MS);
        expect(deployment.status, deployment.error ?? undefined).toBe("ready");
        const html = await (
          await fetch(`https://${project.slug}.${BASE}/`)
        ).text();
        expect(html).toContain(`<title>${title}</title>`);
      },
      BUILD_WAIT_MS + 60_000,
    );
  }

  it(
    "kills a hanging build",
    async () => {
      const { deployment } = await deploy(fixture("hang"), HANG_WAIT_MS);
      expect(deployment.status).toBe("failed");
      expect(deployment.error).toMatch(/exceeded/);
      // The code proves it was the timeout, not some other failure that happens to say "exceeded".
      expect(deployment.errorCode).toBe("pipeline.build_timeout");
    },
    HANG_WAIT_MS + 60_000,
  );
});
