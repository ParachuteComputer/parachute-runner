/**
 * Tests for `src/http-server.ts` — Phase 1.2 admin endpoints.
 *
 * Coverage:
 *   - `/healthz` open, returns 200 + scheduler state
 *   - `/.parachute/info` and `/.parachute/config/schema` open
 *   - `/.parachute/config` GET omits writeOnly `vault_token`
 *   - 401 missing/empty bearer; 401 invalid JWT; 403 wrong scope
 *   - 200 happy path on each admin route with a hub-signed JWT bearing `runner:admin`
 *   - `/runner/jobs/<id>/run-now` 404 unknown job
 *   - `/runner/runs` 400 on bad `since` / `limit`; happy path returns vault `tag:job-run` notes
 *   - PUT `/.parachute/config` partial update preserves unchanged fields
 *   - PUT validation: bad type → 400, unknown field → 400
 *   - Hot-reload: poll_interval / disabled / vault_token / vault_url all take effect immediately
 *   - POST clear-credential clears the secret + halts the scheduler
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

import { resetGuard } from "../auth.ts";
import { type RunnerConfig, applyConfigPatch, loadConfig } from "../config.ts";
import { type RunnerState, startHttpServer } from "../http-server.ts";
import { Scheduler } from "../scheduler.ts";
import { SecretsStore } from "../secrets.ts";
import { VaultClient, type VaultNote } from "../vault-client.ts";

// ---------------------------------------------------------------------------
// Test scaffolding — fake hub (JWKS + revocation list) + fake vault.
// ---------------------------------------------------------------------------

interface Keypair {
  privateKey: CryptoKey;
  publicJwk: Record<string, unknown>;
  kid: string;
}

async function makeKeypair(kid: string): Promise<Keypair> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  return {
    privateKey,
    publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" },
    kid,
  };
}

function startHubFixture(keys: Keypair[]): { origin: string; stop: () => void } {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/jwks.json") {
        return Response.json({ keys: keys.map((k) => k.publicJwk) });
      }
      if (url.pathname === "/.well-known/parachute-revocation.json") {
        return Response.json({ generated_at: new Date().toISOString(), jtis: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
  };
}

interface SignOpts {
  iss: string;
  aud?: string;
  scope?: string;
  sub?: string;
  ttlSeconds?: number;
}

async function signJwt(kp: Keypair, opts: SignOpts): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (opts.ttlSeconds ?? 60);
  return new SignJWT({ scope: opts.scope ?? "" })
    .setProtectedHeader({ alg: "RS256", kid: kp.kid })
    .setIssuer(opts.iss)
    .setSubject(opts.sub ?? "operator-test")
    .setAudience(opts.aud ?? "runner")
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .setJti(`jti-${Math.random().toString(36).slice(2)}`)
    .sign(kp.privateKey);
}

type FakeVault = {
  origin: string;
  stop: () => void;
  setJobs: (notes: VaultNote[]) => void;
  setRuns: (notes: VaultNote[]) => void;
  jobNotes: () => VaultNote[];
  recordedAuthHeaders: () => string[];
};

function startVaultFixture(): FakeVault {
  let jobs: VaultNote[] = [];
  let runs: VaultNote[] = [];
  const authHeaders: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      authHeaders.push(req.headers.get("authorization") ?? "");
      // GET /vault/<name>/api/notes?tag=...
      if (req.method === "GET" && url.pathname.endsWith("/api/notes")) {
        const tag = url.searchParams.get("tag");
        if (tag === "job") return Response.json(jobs);
        if (tag === "job-run") return Response.json(runs);
        return Response.json([]);
      }
      // GET /vault/<name>/api/notes/<id-or-path>
      if (req.method === "GET" && url.pathname.includes("/api/notes/")) {
        const idx = url.pathname.indexOf("/api/notes/");
        const idOrPath = decodeURIComponent(url.pathname.slice(idx + "/api/notes/".length));
        const found = jobs.find((j) => j.id === idOrPath || j.path === idOrPath);
        if (found) return Response.json(found);
        return new Response("not found", { status: 404 });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop: () => server.stop(true),
    setJobs: (next) => {
      jobs = next;
    },
    setRuns: (next) => {
      runs = next;
    },
    jobNotes: () => jobs,
    recordedAuthHeaders: () => authHeaders,
  };
}

// ---------------------------------------------------------------------------
// Shared test setup: a tmpdir holding config.json + master.key + secrets.json,
// a fake vault, a fake hub, a Scheduler wired against the fake vault, and the
// runner HTTP server bound to ephemeral port.
// ---------------------------------------------------------------------------

let tmpDir: string;
let configPath: string;
let secretsStore: SecretsStore;
let runnerConfig: RunnerConfig;
let scheduler: Scheduler;
let vaultClient: VaultClient;
let state: RunnerState;
let server: ReturnType<typeof startHttpServer> | null = null;
let hub: ReturnType<typeof startHubFixture>;
let vault: FakeVault;
let kp: Keypair;
let prevHubOrigin: string | undefined;
let prevHomeOverride: string | undefined;

async function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-http-"));
  configPath = path.join(tmpDir, "config.json");

  // Stand up the fake hub + fake vault.
  kp = await makeKeypair("k-test");
  hub = startHubFixture([kp]);
  vault = startVaultFixture();

  // Seed config.json with a plaintext token; loadConfig migrates it.
  fs.writeFileSync(
    configPath,
    JSON.stringify({
      vault_url: vault.origin,
      vault_name: "default",
      vault_token: "pvt_initial",
      poll_interval_seconds: 60,
    }),
  );

  // Point auth.ts's hub-origin resolver at our fake hub.
  prevHubOrigin = process.env.PARACHUTE_HUB_ORIGIN;
  process.env.PARACHUTE_HUB_ORIGIN = hub.origin;
  // Sandbox $PARACHUTE_HOME for any tests/paths that derive from the env.
  prevHomeOverride = process.env.PARACHUTE_HOME;
  process.env.PARACHUTE_HOME = path.join(tmpDir, "home");
  resetGuard();

  // Build a secrets store sandboxed in tmpDir (config.ts auto-derives this
  // from configPath, but we keep an explicit reference to drive PUTs +
  // clear-credential).
  secretsStore = new SecretsStore({
    paths: {
      dir: tmpDir,
      masterKeyPath: path.join(tmpDir, "master.key"),
      secretsPath: path.join(tmpDir, "secrets.json"),
    },
  });
  // Silent logger so test output isn't noisy
  const silent = { log() {}, warn() {}, error() {} } as Pick<Console, "log" | "warn" | "error">;
  runnerConfig = loadConfig({ configPath, secrets: secretsStore, logger: silent });

  vaultClient = new VaultClient({
    vaultUrl: runnerConfig.vault_url,
    vaultName: runnerConfig.vault_name,
    vaultToken: runnerConfig.vault_token,
  });
  scheduler = new Scheduler({
    client: vaultClient,
    pollIntervalSeconds: runnerConfig.poll_interval_seconds,
    maxConcurrentJobs: runnerConfig.max_concurrent_jobs,
    disabled: runnerConfig.disabled,
    logger: silent,
  });
  await scheduler.poll(); // load initial empty job set
  state = {
    config: runnerConfig,
    configPath,
    secrets: secretsStore,
    scheduler,
    client: vaultClient,
  };

  // Use a `.parachute/` from the actual repo (the file paths are checked-in).
  server = startHttpServer({
    state,
    port: 0,
    startedAt: new Date(),
    logger: silent,
  });
}

async function teardown(): Promise<void> {
  if (server) {
    server.stop();
    server = null;
  }
  await scheduler.stop(100);
  vault.stop();
  hub.stop();
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  if (prevHubOrigin === undefined) delete process.env.PARACHUTE_HUB_ORIGIN;
  else process.env.PARACHUTE_HUB_ORIGIN = prevHubOrigin;
  // biome-ignore lint/performance/noDelete: env vars must be removed, not set to "undefined"
  if (prevHomeOverride === undefined) delete process.env.PARACHUTE_HOME;
  else process.env.PARACHUTE_HOME = prevHomeOverride;
  resetGuard();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function url(p: string): string {
  return `http://127.0.0.1:${server!.port}${p}`;
}

beforeEach(setup);
afterEach(teardown);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /healthz — open, unauthenticated", () => {
  test("returns 200 with scheduler stats", async () => {
    const res = await fetch(url("/healthz"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.status).toBe("ok");
    expect(body.scheduledJobs).toBe(0);
    expect(typeof body.uptime_seconds).toBe("number");
  });
  test("GET /runner/healthz also resolves (hub mount path)", async () => {
    const res = await fetch(url("/runner/healthz"));
    expect(res.status).toBe(200);
  });
});

describe("GET /.parachute/info — open", () => {
  test("returns the static info file", async () => {
    const res = await fetch(url("/.parachute/info"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("parachute-runner");
  });
});

describe("GET /.parachute/config/schema — open", () => {
  test("returns the Draft-07 schema with writeOnly on vault_token", async () => {
    const res = await fetch(url("/.parachute/config/schema"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      $schema: string;
      properties: Record<string, { writeOnly?: boolean; type: string }>;
    };
    expect(body.$schema).toContain("draft-07");
    expect(body.properties.vault_token?.writeOnly).toBe(true);
  });
});

describe("Bearer enforcement", () => {
  test("401 when Authorization header is missing", async () => {
    const res = await fetch(url("/runner/jobs"));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("unauthorized");
  });

  test("401 when Authorization header is empty Bearer", async () => {
    const res = await fetch(url("/runner/jobs"), { headers: { authorization: "Bearer " } });
    expect(res.status).toBe(401);
  });

  test("401 when JWT is malformed garbage", async () => {
    const res = await fetch(url("/runner/jobs"), {
      headers: { authorization: "Bearer not-a-real-jwt" },
    });
    expect(res.status).toBe(401);
  });

  test("403 when JWT is valid but lacks runner:admin scope", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:read", // wrong scope
    });
    const res = await fetch(url("/runner/jobs"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error_type: string };
    expect(body.error_type).toBe("insufficient_scope");
  });

  test("401 when JWT audience is for a different module", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "scribe", // wrong audience
      scope: "runner:admin",
    });
    const res = await fetch(url("/runner/jobs"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });

  test("401 when JWT issuer doesn't match our hub origin", async () => {
    const token = await signJwt(kp, {
      iss: "http://some-other-hub.example.com",
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/runner/jobs"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(401);
  });
});

describe("GET /runner/jobs — happy path", () => {
  test("returns the scheduler snapshot under a valid runner:admin bearer", async () => {
    vault.setJobs([
      {
        id: "n1",
        path: "jobs/daily-task",
        content: "---\nschedule: daily\nmodel: m\nallowed_tools: [mcp__x]\n---\nbody",
      },
    ]);
    await scheduler.poll();
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/runner/jobs"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jobs: Array<{ jobPath: string; schedule: string; disabled: boolean }>;
    };
    expect(body.jobs).toHaveLength(1);
    expect(body.jobs[0]!.jobPath).toBe("jobs/daily-task");
    expect(body.jobs[0]!.schedule).toBe("daily");
    expect(body.jobs[0]!.disabled).toBe(false);
  });
});

describe("GET /.parachute/config — writeOnly omission", () => {
  test("returns the resolved config without vault_token", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/.parachute/config"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.vault_token).toBeUndefined();
    expect(body.vault_url).toBe(vault.origin);
    expect(body.vault_name).toBe("default");
    expect(body.poll_interval_seconds).toBe(60);
    expect(body.disabled).toBe(false);
  });
});

describe("PUT /.parachute/config", () => {
  async function withToken(): Promise<string> {
    return signJwt(kp, { iss: hub.origin, aud: "runner", scope: "runner:admin" });
  }

  test("partial update preserves unchanged values", async () => {
    const token = await withToken();
    const put = await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ poll_interval_seconds: 30 }),
    });
    expect(put.status).toBe(200);
    // vault_url + vault_name + token survive; only poll_interval changed.
    const get = await fetch(url("/.parachute/config"), {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.poll_interval_seconds).toBe(30);
    expect(body.vault_url).toBe(vault.origin);
    expect(body.vault_name).toBe("default");
  });

  test("400 on body that isn't a JSON object", async () => {
    const token = await withToken();
    const res = await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "[]",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("validation_failed");
  });

  test("400 on unknown field", async () => {
    const token = await withToken();
    const res = await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ totally_made_up_field: "x" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 on bad type", async () => {
    const token = await withToken();
    const res = await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ poll_interval_seconds: "not a number" }),
    });
    expect(res.status).toBe(400);
  });

  test("400 on invalid JSON body", async () => {
    const token = await withToken();
    const res = await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: "not-json{",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("invalid_json");
  });

  test("hot-reload — poll_interval_seconds takes effect immediately", async () => {
    const token = await withToken();
    expect(state.scheduler.opts.pollIntervalSeconds).toBe(60);
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ poll_interval_seconds: 7 }),
    });
    expect(state.scheduler.opts.pollIntervalSeconds).toBe(7);
  });

  test("hot-reload — disabled flag takes effect immediately", async () => {
    const token = await withToken();
    expect(state.scheduler.opts.disabled).toBeFalsy();
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(state.scheduler.opts.disabled).toBe(true);
  });

  test("hot-reload — vault_token change reaches the next vault call (no restart)", async () => {
    const token = await withToken();
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ vault_token: "pvt_rotated" }),
    });
    // The bearer the scheduler's vault client now carries should be the new one.
    expect(state.client.vaultToken).toBe("pvt_rotated");
    // The encrypted secret-store reflects the new token too.
    expect(state.secrets.load("vault_token")).toBe("pvt_rotated");
  });

  test("hot-reload — vault_url change rebuilds the client", async () => {
    const token = await withToken();
    const newOrigin = "http://127.0.0.1:9";
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ vault_url: newOrigin }),
    });
    expect(state.client.vaultUrl).toBe(newOrigin);
  });

  test("PUT does not leak vault_token to GET /.parachute/config after writing one", async () => {
    const token = await withToken();
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ vault_token: "pvt_newly_set" }),
    });
    const get = await fetch(url("/.parachute/config"), {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await get.json()) as Record<string, unknown>;
    expect(body.vault_token).toBeUndefined();
  });

  test("PUT-written vault_token never lands in config.json on disk", async () => {
    const token = await withToken();
    await fetch(url("/.parachute/config"), {
      method: "PUT",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ vault_token: "pvt_must_be_encrypted" }),
    });
    const persisted = fs.readFileSync(configPath, "utf8");
    expect(persisted).not.toContain("pvt_must_be_encrypted");
  });
});

describe("POST /runner/jobs/<path>/run-now", () => {
  test("404 when the job does not exist in vault", async () => {
    vault.setJobs([]);
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/runner/jobs/jobs%2Fnope/run-now"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(404);
  });

  test("400 on missing job path segment", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/runner/jobs//run-now"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /runner/runs", () => {
  async function withToken(): Promise<string> {
    return signJwt(kp, { iss: hub.origin, aud: "runner", scope: "runner:admin" });
  }

  test("returns runs from vault tag:job-run query", async () => {
    vault.setRuns([
      {
        id: "r1",
        path: "jobs/runs/a/2026-05-21",
        tags: ["job-run"],
        metadata: { parent_job_id: "n1", run_started_at: "2026-05-21T08:00:00Z" },
      },
      {
        id: "r2",
        path: "jobs/runs/b/2026-05-21",
        tags: ["job-run", "job-run-failed"],
        metadata: { parent_job_id: "n2", run_started_at: "2026-05-21T07:00:00Z" },
      },
    ]);
    const token = await withToken();
    const res = await fetch(url("/runner/runs"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runs: Array<{ id: string }> };
    expect(body.runs).toHaveLength(2);
  });

  test("filters by `since` timestamp", async () => {
    vault.setRuns([
      {
        id: "r1",
        path: "p1",
        tags: ["job-run"],
        metadata: { run_started_at: "2026-05-21T08:00:00Z" },
      },
      {
        id: "r2",
        path: "p2",
        tags: ["job-run"],
        metadata: { run_started_at: "2026-05-20T08:00:00Z" },
      },
    ]);
    const token = await withToken();
    const res = await fetch(url("/runner/runs?since=2026-05-21T00:00:00Z"), {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { runs: Array<{ id: string }> };
    expect(body.runs.map((r) => r.id)).toEqual(["r1"]);
  });

  test("400 on bad `since` value", async () => {
    const token = await withToken();
    const res = await fetch(url("/runner/runs?since=not-a-date"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });

  test("400 on out-of-range `limit`", async () => {
    const token = await withToken();
    const res = await fetch(url("/runner/runs?limit=99999"), {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(400);
  });
});

describe("POST /.parachute/clear-credential/vault-token", () => {
  test("clears the secret and disables the scheduler", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    expect(state.secrets.load("vault_token")).toBe("pvt_initial");
    const res = await fetch(url("/.parachute/clear-credential/vault-token"), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    expect(state.secrets.load("vault_token")).toBeNull();
    expect(state.scheduler.opts.disabled).toBe(true);
  });
});

describe("405 method-not-allowed on supported paths", () => {
  test("DELETE on /.parachute/config", async () => {
    const token = await signJwt(kp, {
      iss: hub.origin,
      aud: "runner",
      scope: "runner:admin",
    });
    const res = await fetch(url("/.parachute/config"), {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(405);
  });
});

describe("404 on unknown paths", () => {
  test("unknown root", async () => {
    const res = await fetch(url("/somewhere-else"));
    expect(res.status).toBe(404);
  });
});

describe("applyConfigPatch — read-modify-write", () => {
  // Lower-level unit test for the function HTTP PUT calls into. Validates the
  // patch-preserves-unchanged invariant against the on-disk file directly.
  test("missing wire fields keep the on-disk value", () => {
    applyConfigPatch({
      configPath,
      patch: { poll_interval_seconds: 12 },
      store: secretsStore,
    });
    const file = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(file.vault_url).toBe(vault.origin);
    expect(file.poll_interval_seconds).toBe(12);
    // vault_token never lives in config.json post-migration.
    expect(file.vault_token).toBeUndefined();
  });
});
