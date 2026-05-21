/**
 * @openparachute/runner — library entry.
 *
 * Phase 1.1 wires the public surface: `runOnce` enumerates jobs and matures
 * each one; `serve` starts the long-running daemon (poll + cron schedule +
 * healthz HTTP). The shapes below are also re-exported as named modules for
 * callers that need to drop down to a specific layer (vault client, parser,
 * etc.).
 *
 * See the design doc:
 *   https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md
 */

import * as nodePath from "node:path";

import pkg from "../package.json" with { type: "json" };

import { type RunnerConfig, loadConfig, resolveConfigPath } from "./config.ts";
import { type RunnerState, startHttpServer } from "./http-server.ts";
import { parseJob } from "./job-parser.ts";
import { runJob } from "./run-job.ts";
import { Scheduler } from "./scheduler.ts";
import { SecretsStore } from "./secrets.ts";
import { VaultClient, type VaultNote } from "./vault-client.ts";

export * from "./config.ts";
export * from "./job-parser.ts";
export * from "./template.ts";
export * from "./mcp-config.ts";
export * from "./spawn.ts";
export * from "./output-writer.ts";
export * from "./vault-client.ts";
export * from "./run-job.ts";
export * from "./secrets.ts";
export * from "./auth.ts";
export { Scheduler } from "./scheduler.ts";
export type { SchedulerEvent, SchedulerOpts, SchedulerJobSnapshot } from "./scheduler.ts";
export { startHttpServer } from "./http-server.ts";
export type { RunnerState, HttpServerOpts } from "./http-server.ts";

/** Package semver. */
export const VERSION: string = pkg.version;

/** Default healthz port (per design doc decision 6, runner claims 1945). */
export const DEFAULT_PORT = 1945;

export type RunOnceOptions = {
  /** Limit maturation to a single job by vault path. */
  only?: string;
  /** Override the `{{date}}` template variable (ISO date, UTC). */
  date?: string;
  /** Enumerate + render but skip the `claude -p` spawn. */
  dryRun?: boolean;
  /** Override config path (tests use a tempdir). */
  configPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type RunOnceResult = {
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

/**
 * One-shot: query the vault for `tag:job`, mature any due jobs, write
 * outputs, exit. `--only <path>` narrows to a single job (including
 * `schedule: manual` jobs, which are otherwise skipped).
 */
export async function runOnce(opts: RunOnceOptions = {}): Promise<RunOnceResult> {
  const config = loadConfig(opts.configPath);
  const logger = opts.logger ?? console;
  if (config.disabled) {
    logger.warn("[runner] config.disabled=true — exiting without running any jobs");
    return { total: 0, succeeded: 0, failed: 0, skipped: 0 };
  }
  const client = new VaultClient({
    vaultUrl: config.vault_url,
    vaultName: config.vault_name,
    vaultToken: config.vault_token,
  });

  let notes: VaultNote[];
  if (opts.only) {
    const note = await client.getNote(opts.only);
    if (!note) {
      logger.error(`[runner] no note found at ${opts.only}`);
      return { total: 0, succeeded: 0, failed: 0, skipped: 0 };
    }
    notes = [note];
  } else {
    notes = await client.queryJobs();
    notes = notes.filter((n) => !(n.path ?? "").startsWith("jobs/runs/"));
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const note of notes) {
    let job: ReturnType<typeof parseJob>;
    try {
      job = parseJob(note);
    } catch (e) {
      logger.error(`[runner] invalid job at ${note.path ?? note.id}: ${(e as Error).message}`);
      failed++;
      continue;
    }
    // `manual` jobs and `disabled` jobs are skipped unless --only targets them.
    if (!opts.only && (job.disabled || job.cronString === null)) {
      logger.log(`[runner] skip ${job.path} (${job.disabled ? "disabled" : "manual"})`);
      skipped++;
      continue;
    }
    if (opts.dryRun) {
      logger.log(`[runner] dry-run ${job.path} (model=${job.model}, schedule=${job.schedule})`);
      skipped++;
      continue;
    }
    try {
      const result = await runJob({ client, job, date: opts.date });
      logger.log(
        `[runner] ${result.outcome.status === "ok" ? "ok" : "FAILED"} ${job.path} → ${result.outcome.outputPath}`,
      );
      if (result.outcome.status === "ok") succeeded++;
      else failed++;
    } catch (e) {
      logger.error(`[runner] error running ${job.path}: ${(e as Error).message}`);
      failed++;
    }
  }
  return { total: notes.length, succeeded, failed, skipped };
}

export type ServeOptions = {
  /** Override `poll_interval_seconds` from config. */
  pollIntervalSeconds?: number;
  /** Override the healthz port. Defaults to DEFAULT_PORT. */
  port?: number;
  /** Override config path (tests use a tempdir). */
  configPath?: string;
  /** Graceful shutdown deadline. */
  shutdownTimeoutMs?: number;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type ServeHandle = {
  scheduler: Scheduler;
  server: ReturnType<typeof Bun.serve>;
  config: RunnerConfig;
  stop: () => Promise<void>;
};

/**
 * Long-running daemon: poll the vault for jobs on a cadence and mature them
 * on schedule. Returns a handle the CLI uses to wire SIGINT/SIGTERM into
 * graceful shutdown.
 *
 * Phase 1.2 lift: the HTTP server now hosts admin endpoints on the same
 * port (`/runner/jobs`, `/runner/runs`, etc.) — see `http-server.ts`. The
 * scheduler + client are shared with the HTTP handler via the `state`
 * object so PUT-config can hot-reload them.
 */
export async function serve(opts: ServeOptions = {}): Promise<ServeHandle> {
  const { configPath: optConfigPath } = opts;
  const logger = opts.logger ?? console;
  const port = opts.port ?? DEFAULT_PORT;

  // Resolve the config path first so we can pass an aligned secrets store.
  const configPath = optConfigPath ?? undefined;
  const config = loadConfig({ configPath, logger });

  const client = new VaultClient({
    vaultUrl: config.vault_url,
    vaultName: config.vault_name,
    vaultToken: config.vault_token,
  });
  const scheduler = new Scheduler({
    client,
    pollIntervalSeconds: opts.pollIntervalSeconds ?? config.poll_interval_seconds,
    maxConcurrentJobs: config.max_concurrent_jobs,
    disabled: config.disabled,
    logger,
    onJobRun: (event) => {
      if (event.type === "job-loaded") {
        logger.log(`[scheduler] +${event.jobPath} (${event.schedule})`);
      } else if (event.type === "job-removed") {
        logger.log(`[scheduler] -${event.jobPath}`);
      } else if (event.type === "job-parse-error") {
        logger.warn(`[scheduler] invalid ${event.jobPath}: ${event.reasons.join("; ")}`);
      } else if (event.type === "job-fired") {
        logger.log(`[scheduler] fired ${event.jobPath} (${event.status})`);
      } else if (event.type === "job-error") {
        logger.error(`[scheduler] error ${event.jobPath}: ${event.error}`);
      }
    },
  });
  await scheduler.start();
  const startedAt = new Date();
  // Resolve a SecretsStore aligned with the configPath the daemon is using
  // so the HTTP PUT-config + clear-credential endpoints write to the same
  // envelope `loadConfig` will read on reload. Without an explicit path we
  // fall through to `resolveSecretsPaths()` (canonical $PARACHUTE_HOME).
  const resolvedConfigPath = configPath ?? resolveConfigPath();
  const secrets = optConfigPath
    ? new SecretsStore({
        paths: {
          dir: nodePath.dirname(resolvedConfigPath),
          masterKeyPath: nodePath.join(nodePath.dirname(resolvedConfigPath), "master.key"),
          secretsPath: nodePath.join(nodePath.dirname(resolvedConfigPath), "secrets.json"),
        },
        createIfMissing: false,
      })
    : new SecretsStore({ createIfMissing: false });
  const state: RunnerState = {
    config,
    configPath: resolvedConfigPath,
    secrets,
    scheduler,
    client,
  };
  const server = startHttpServer({ state, port, startedAt, logger });
  logger.log(
    `[runner] serve: vault=${config.vault_url} vault_name=${config.vault_name} port=${port} jobs=${scheduler.scheduledJobs}`,
  );

  const stop = async () => {
    logger.log("[runner] shutting down — draining in-flight jobs");
    await scheduler.stop(opts.shutdownTimeoutMs ?? 30_000);
    server.stop();
    logger.log("[runner] stopped");
  };

  return { scheduler, server, config, stop };
}
