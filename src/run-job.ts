/**
 * Mature one job: render templates, build MCP config, spawn claude -p, write
 * the output back to vault. The scheduler and the `once` CLI both call
 * `runJob` per job they decide to mature.
 *
 * Failures during render, spawn, or write all funnel through
 * `writeRunOutput`'s failure path so an operator can always find the
 * `job-run-failed` note in vault, even when the runner itself hit an error.
 */

import { type Job, parseJob } from "./job-parser.ts";
import { buildMcpConfigJson } from "./mcp-config.ts";
import { type WriteOutcome, writeRunOutput } from "./output-writer.ts";
import { type SpawnResult, spawnClaude } from "./spawn.ts";
import { TemplateError, isoDate, randomRunId, render } from "./template.ts";
import type { VaultClient } from "./vault-client.ts";

export type RunJobOpts = {
  client: VaultClient;
  job: Job;
  /** Override `{{date}}` template (ISO date). Defaults to today (UTC). */
  date?: string;
  /** Override the run-id (tests use this for deterministic comparisons). */
  runId?: string;
  /**
   * Inject a spawnFn for tests that want to stub out claude -p entirely.
   * Returns the SpawnResult that would otherwise come back from the
   * subprocess.
   */
  spawnFn?: (args: {
    prompt: string;
    mcpConfigJson: string;
    allowedTools: string[];
    model: string;
    timeoutMs: number;
  }) => Promise<SpawnResult>;
};

export type RunJobResult = {
  job: Job;
  outcome: WriteOutcome;
  startedAt: Date;
  /** The argv the child was actually invoked with (bearer redacted). */
  command: string[];
};

/**
 * Render the prompt + output_path, build the inline MCP config, spawn claude,
 * write the output note. Returns the WriteOutcome (status: ok | failed).
 */
export async function runJob(opts: RunJobOpts): Promise<RunJobResult> {
  const { client, job } = opts;
  const startedAt = new Date();
  const runId = opts.runId ?? randomRunId();
  const date = opts.date ?? isoDate(startedAt);
  const vars = { date, job_name: job.name, run_id: runId };

  // Template render — failure here produces a failure note before we ever
  // touch claude. The runner's job is to make the failure visible in vault.
  let renderedPrompt: string;
  let renderedOutputPath: string;
  try {
    renderedPrompt = render(job.prompt, vars);
    renderedOutputPath = render(job.outputPath, vars);
  } catch (e) {
    if (e instanceof TemplateError) {
      return await writeRenderFailure({ client, job, runId, startedAt, error: e });
    }
    throw e;
  }

  const mcpConfigJson = buildMcpConfigJson({
    vaultName: client.vaultName,
    vaultUrl: client.vaultUrl,
    vaultToken: client.vaultToken,
  });

  const spawnArgs = {
    prompt: renderedPrompt,
    mcpConfigJson,
    allowedTools: job.allowedTools,
    model: job.model,
    timeoutMs: job.timeoutMs,
  };
  const result = opts.spawnFn ? await opts.spawnFn(spawnArgs) : await spawnClaude(spawnArgs);

  const outcome = await writeRunOutput({
    client,
    job,
    outputPath: renderedOutputPath,
    runId,
    startedAt,
    result,
  });
  return { job, outcome, startedAt, command: result.command };
}

/**
 * Render-time failure produces a synthetic SpawnResult (exit=2, "render
 * error: ...") and routes through the failure path so the operator gets
 * a `job-run-failed` note with the typo'd variable names.
 */
async function writeRenderFailure(opts: {
  client: VaultClient;
  job: Job;
  runId: string;
  startedAt: Date;
  error: TemplateError;
}): Promise<RunJobResult> {
  const { client, job, runId, startedAt, error } = opts;
  const synthetic: SpawnResult = {
    stdout: "",
    stderr: error.message,
    exitCode: 2,
    timedOut: false,
    durationMs: Date.now() - startedAt.getTime(),
    command: ["<render-error>"],
  };
  // Output path also depended on `{{vars}}` we couldn't render — fall back to a
  // safe known-good location so the failure note actually lands.
  const fallbackPath = `jobs/runs/${job.name}/render-error-${runId}`;
  const outcome = await writeRunOutput({
    client,
    job,
    outputPath: fallbackPath,
    runId,
    startedAt,
    result: synthetic,
  });
  return { job, outcome, startedAt, command: synthetic.command };
}

/**
 * Helper for callers (CLI + scheduler) that have a raw vault note + want to
 * either run it or capture the parse error. Returns `null` if the note is
 * not a valid job (with the reason logged); the caller can decide whether
 * to surface that as a partial failure.
 */
export function tryParseJob(note: import("./vault-client.ts").VaultNote): Job | null {
  try {
    return parseJob(note);
  } catch {
    return null;
  }
}
