/**
 * HTTP surface for `parachute-runner serve`.
 *
 * Endpoints (per design doc table 6):
 *   - `GET  /healthz`                              — liveness, unauthenticated
 *   - `GET  /runner/healthz`                       — same, hub-supervisor mount path
 *   - `GET  /runner/jobs`                          — list scheduled jobs (runner:admin)
 *   - `GET  /runner/runs?since=<iso>&limit=<n>`    — recent run history (runner:admin)
 *   - `POST /runner/jobs/<path>/run-now`           — force one job (runner:admin)
 *   - `GET  /.parachute/info`                      — module identity (open)
 *   - `GET  /.parachute/config`                    — current resolved config, writeOnly omitted (runner:admin)
 *   - `PUT  /.parachute/config`                    — partial update (runner:admin)
 *   - `GET  /.parachute/config/schema`             — Draft-07 JSON Schema (open)
 *   - `POST /.parachute/clear-credential/vault-token` — clear stored bearer (runner:admin)
 *
 * The `/healthz` and `/.parachute/info` + `/.parachute/config/schema` endpoints
 * stay open — they're the discovery + liveness probes hub and operators hit
 * before they've minted a per-resource bearer. Everything else requires a
 * hub-issued JWT with `runner:admin` scope (per the canonical
 * "<service>:admin gates /.parachute/config*" rule).
 *
 * Auth + scope enforcement lives in `src/auth.ts`; this file is the router
 * + per-route glue. Hot-reload on PUT-config goes through
 * `Scheduler.setPollIntervalSeconds` / `setDisabled` / `replaceClient` so
 * the design doc's "changes take effect immediately, no process restart"
 * promise actually holds.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import { SCOPE_ADMIN, enforceAdmin } from "./auth.ts";
import {
  type RunnerConfig,
  type RunnerConfigPublic,
  applyConfigPatch,
  toPublicConfig,
  validatePutBody,
} from "./config.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SecretsStore } from "./secrets.ts";
import { VaultClient } from "./vault-client.ts";

export type RunnerState = {
  /** The currently-resolved config. Replaced wholesale after a PUT. */
  config: RunnerConfig;
  /** Where this runner instance persists its config.json. */
  configPath: string;
  /** Encrypted-secrets accessor. */
  secrets: SecretsStore;
  /** Active scheduler. The same instance survives PUTs — we hot-reload it. */
  scheduler: Scheduler;
  /** Active vault client. Replaced when vault_url/name/token change. */
  client: VaultClient;
};

export type HttpServerOpts = {
  /** Mutable state — exported so PUT-config can hot-reload it. */
  state: RunnerState;
  /** Bind port. Use 0 in tests to let the OS pick. */
  port: number;
  /** Process start time, for /healthz uptime calc. */
  startedAt: Date;
  /**
   * Bind address. Defaults to `127.0.0.1` — loopback-only because the admin
   * endpoints leak job state. v0.6 single-container deploys reach this via
   * hub's reverse proxy on the same localhost; cloud / multi-host setups
   * should keep the default until a deliberate config field opens it up.
   */
  hostname?: string;
  /** Override for tests — defaults to Bun.serve. */
  serveFn?: typeof Bun.serve;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
  /**
   * Override the .parachute manifest dir. Defaults to the repo's
   * `.parachute/` next to `package.json`. Tests inject a tmpdir.
   */
  parachuteDir?: string;
};

/**
 * Spin up the runner HTTP server. Returns the running Bun.Server so the CLI
 * can `server.stop()` during graceful shutdown. The handler closes over
 * `opts.state`; PUT-config mutates the fields of that object in place so
 * subsequent reads see the new values (dynamic-state pattern).
 */
export function startHttpServer(opts: HttpServerOpts): ReturnType<typeof Bun.serve> {
  const { port, startedAt } = opts;
  const hostname = opts.hostname ?? "127.0.0.1";
  const serve = opts.serveFn ?? Bun.serve;
  const parachuteDir = opts.parachuteDir ?? defaultParachuteDir();
  const logger = opts.logger ?? console;

  return serve({
    port,
    hostname,
    fetch: (req) => handle(req, opts.state, { startedAt, parachuteDir, logger }),
  });
}

type HandleCtx = {
  startedAt: Date;
  parachuteDir: string;
  logger: Pick<Console, "log" | "warn" | "error">;
};

async function handle(req: Request, state: RunnerState, ctx: HandleCtx): Promise<Response> {
  const url = new URL(req.url);
  const pathname = url.pathname;
  const method = req.method;

  // /healthz: open, both with and without the /runner mount prefix so
  // hub-as-supervisor (which forwards via /runner) and direct localhost
  // probes both work.
  if (method === "GET" && (pathname === "/healthz" || pathname === "/runner/healthz")) {
    return Response.json({
      status: "ok" as const,
      scheduledJobs: state.scheduler.scheduledJobs,
      lastTickAt: state.scheduler.lastTickAtIso,
      uptime_seconds: Math.floor((Date.now() - ctx.startedAt.getTime()) / 1000),
    });
  }

  // /.parachute/info: open, static.
  if (method === "GET" && pathname === "/.parachute/info") {
    return serveStaticFile(path.join(ctx.parachuteDir, "info"), "application/json");
  }

  // /.parachute/config/schema: open, static.
  if (method === "GET" && pathname === "/.parachute/config/schema") {
    return serveStaticFile(path.join(ctx.parachuteDir, "config", "schema"), "application/json");
  }

  // Everything below requires runner:admin.
  const adminPaths = [
    pathname === "/runner/jobs",
    pathname.startsWith("/runner/jobs/") && pathname.endsWith("/run-now"),
    pathname === "/runner/runs",
    pathname === "/.parachute/config",
    pathname.startsWith("/.parachute/clear-credential/"),
  ];
  if (adminPaths.some(Boolean)) {
    const auth = await enforceAdmin(req, SCOPE_ADMIN);
    if (auth instanceof Response) return auth;

    if (pathname === "/runner/jobs" && method === "GET") return handleJobs(state);
    if (pathname === "/runner/runs" && method === "GET") return handleRuns(req, state);
    if (
      pathname.startsWith("/runner/jobs/") &&
      pathname.endsWith("/run-now") &&
      method === "POST"
    ) {
      return handleRunNow(pathname, state);
    }
    if (pathname === "/.parachute/config") {
      if (method === "GET") return handleConfigGet(state);
      if (method === "PUT") return handleConfigPut(req, state, ctx);
      return methodNotAllowed("use GET or PUT");
    }
    if (pathname === "/.parachute/clear-credential/vault-token" && method === "POST") {
      return handleClearCredential(state, ctx);
    }
    return methodNotAllowed();
  }

  return new Response("Not Found", { status: 404 });
}

function handleJobs(state: RunnerState): Response {
  const snap = state.scheduler.snapshot();
  // Stable ordering for deterministic admin UI rendering.
  snap.sort((a, b) => a.jobPath.localeCompare(b.jobPath));
  return Response.json({ jobs: snap });
}

async function handleRuns(req: Request, state: RunnerState): Promise<Response> {
  const url = new URL(req.url);
  const sinceRaw = url.searchParams.get("since");
  const limitRaw = url.searchParams.get("limit");

  // Validate `since` if provided — must parse as a Date. Bad input is a 400
  // so the operator sees the typo loud rather than silently getting "all runs."
  let sinceMs: number | null = null;
  if (sinceRaw) {
    const parsed = Date.parse(sinceRaw);
    if (Number.isNaN(parsed)) {
      return Response.json(
        { error: "bad_request", message: "`since` must be an ISO-8601 timestamp" },
        { status: 400 },
      );
    }
    sinceMs = parsed;
  }
  let limit = 100;
  if (limitRaw !== null) {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n < 1 || n > 1000) {
      return Response.json(
        { error: "bad_request", message: "`limit` must be an integer in 1..1000" },
        { status: 400 },
      );
    }
    limit = n;
  }

  // Source of truth for runs is vault (`tag:job-run`) — matches design doc
  // decision 5 "audit lives in the same substrate as the work." We avoid a
  // parallel SQLite of runs.
  let notes: Awaited<ReturnType<typeof state.client.queryJobs>>;
  try {
    notes = await state.client.queryRuns({ limit });
  } catch (e) {
    return Response.json(
      {
        error: "upstream_unreachable",
        message: `failed to query vault for runs: ${(e as Error).message}`,
      },
      { status: 502 },
    );
  }
  // Apply `since` filter client-side. Vault returns notes ordered newest-first.
  const runs = notes
    .filter((n) => {
      if (sinceMs === null) return true;
      const ts = (n.metadata as Record<string, unknown> | undefined)?.run_started_at;
      if (typeof ts !== "string") return true;
      const t = Date.parse(ts);
      if (Number.isNaN(t)) return true;
      return t >= sinceMs;
    })
    .map((n) => ({
      id: n.id,
      path: n.path,
      tags: n.tags ?? [],
      metadata: n.metadata ?? {},
      created_at: n.created_at,
    }));
  return Response.json({ runs });
}

async function handleRunNow(pathname: string, state: RunnerState): Promise<Response> {
  // /runner/jobs/<path>/run-now — the <path> segment is percent-encoded and
  // may itself contain slashes (job paths in vault are slash-delimited).
  const prefix = "/runner/jobs/";
  const suffix = "/run-now";
  const middle = pathname.slice(prefix.length, pathname.length - suffix.length);
  if (middle.length === 0) {
    return Response.json(
      { error: "bad_request", message: "missing job path in URL" },
      { status: 400 },
    );
  }
  const jobPath = safeDecode(middle);
  if (jobPath === null) {
    return Response.json(
      { error: "bad_request", message: "job path is not valid URL encoding" },
      { status: 400 },
    );
  }
  let outcome: Awaited<ReturnType<typeof state.scheduler.forceRun>>;
  try {
    outcome = await state.scheduler.forceRun(jobPath);
  } catch (e) {
    return Response.json({ error: "run_failed", message: (e as Error).message }, { status: 500 });
  }
  if (!outcome.found) {
    return Response.json({ error: "not_found", message: `no job at ${jobPath}` }, { status: 404 });
  }
  return Response.json({
    ok: true,
    runId: outcome.runId,
    status: outcome.status,
    outputPath: outcome.outputPath,
  });
}

function handleConfigGet(state: RunnerState): Response {
  const publicCfg: RunnerConfigPublic = toPublicConfig(state.config);
  return Response.json(publicCfg);
}

async function handleConfigPut(
  req: Request,
  state: RunnerState,
  ctx: HandleCtx,
): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch (e) {
    return Response.json(
      {
        error: "invalid_json",
        message: e instanceof Error ? e.message : "request body was not valid JSON",
      },
      { status: 400 },
    );
  }
  const result = validatePutBody(body);
  if (!result.ok) {
    return Response.json(
      {
        error: "validation_failed",
        message: result.errors.map((e) => `${e.path}: ${e.message}`).join("; "),
        errors: result.errors,
      },
      { status: 400 },
    );
  }
  const patch = result.value;

  let nextConfig: RunnerConfig;
  try {
    nextConfig = applyConfigPatch({
      configPath: state.configPath,
      patch,
      store: state.secrets,
    });
  } catch (e) {
    return Response.json({ error: "apply_failed", message: (e as Error).message }, { status: 500 });
  }

  // Hot-reload the live scheduler + client.
  const prev = state.config;
  state.config = nextConfig;

  // Track which fields actually changed so we can surface deferred ones in
  // the response (operators shouldn't be surprised when e.g.
  // `max_concurrent_jobs` persists silently but won't take effect until the
  // next restart).
  const changedFields: string[] = [];

  // Vault client: replace when url/name/token changed; otherwise reuse.
  const clientChanged =
    nextConfig.vault_url !== prev.vault_url ||
    nextConfig.vault_name !== prev.vault_name ||
    nextConfig.vault_token !== prev.vault_token;
  if (clientChanged) {
    if (nextConfig.vault_url !== prev.vault_url) changedFields.push("vault_url");
    if (nextConfig.vault_name !== prev.vault_name) changedFields.push("vault_name");
    if (nextConfig.vault_token !== prev.vault_token) changedFields.push("vault_token");
    state.client = new VaultClient({
      vaultUrl: nextConfig.vault_url,
      vaultName: nextConfig.vault_name,
      vaultToken: nextConfig.vault_token,
    });
    try {
      await state.scheduler.replaceClient(state.client);
      ctx.logger.log(
        `[runner] hot-reload: vault client replaced (url=${nextConfig.vault_url} name=${nextConfig.vault_name})`,
      );
    } catch (e) {
      ctx.logger.warn(`[runner] hot-reload poll failed: ${(e as Error).message}`);
    }
  }
  if (nextConfig.poll_interval_seconds !== prev.poll_interval_seconds) {
    changedFields.push("poll_interval_seconds");
    state.scheduler.setPollIntervalSeconds(nextConfig.poll_interval_seconds);
    ctx.logger.log(
      `[runner] hot-reload: poll_interval_seconds=${nextConfig.poll_interval_seconds}`,
    );
  }
  if (nextConfig.disabled !== prev.disabled) {
    changedFields.push("disabled");
    state.scheduler.setDisabled(nextConfig.disabled);
    ctx.logger.log(`[runner] hot-reload: disabled=${nextConfig.disabled}`);
  }
  if (nextConfig.max_concurrent_jobs !== prev.max_concurrent_jobs) {
    // Persisted to disk but the live semaphore depth doesn't change
    // mid-life — see Phase 1.2 design note. Surface in the response so
    // operators know to restart.
    changedFields.push("max_concurrent_jobs");
  }

  const deferred = changedFields.filter((f) => DEFERRED_FIELDS.has(f));
  if (deferred.length > 0) {
    ctx.logger.log(
      `[config] PUT applied ${changedFields.length} field${changedFields.length === 1 ? "" : "s"}; ${deferred.length} deferred until restart: ${deferred.join(", ")}`,
    );
  }

  return Response.json({ ok: true, deferred });
}

/**
 * Config fields that are accepted + persisted to disk by PUT
 * /.parachute/config but don't take effect until the runner process restarts.
 * Surfaced in the PUT response `deferred` array so operators aren't surprised
 * when a setting persists silently with no live effect.
 */
const DEFERRED_FIELDS = new Set<string>(["max_concurrent_jobs"]);

async function handleClearCredential(state: RunnerState, ctx: HandleCtx): Promise<Response> {
  state.secrets.clear("vault_token");
  ctx.logger.warn(
    "[runner] vault_token cleared — scheduler will halt until a new token is written via PUT /.parachute/config",
  );
  // The in-process scheduler keeps running but its next vault poll will 401
  // with the now-deleted secret. We stop the scheduler explicitly so the
  // operator sees a clean halt rather than a stream of 401s in the log.
  state.scheduler.setDisabled(true);
  return Response.json({ ok: true });
}

function methodNotAllowed(message = "method not allowed"): Response {
  return Response.json({ error: "method_not_allowed", message }, { status: 405 });
}

function serveStaticFile(filePath: string, contentType: string): Response {
  try {
    const body = readFileSync(filePath, "utf8");
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  } catch (e) {
    return Response.json(
      { error: "not_found", message: `${filePath} not found: ${(e as Error).message}` },
      { status: 404 },
    );
  }
}

/**
 * Default location of `.parachute/` relative to the installed package. The
 * files we serve (info, config/schema) are checked into the npm package via
 * `package.json#files`.
 */
function defaultParachuteDir(): string {
  // import.meta.dir points at the directory containing this file. Walk up
  // one level (src/ → repo root) and then into `.parachute/`.
  return path.resolve(import.meta.dir, "..", ".parachute");
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}
