/**
 * Write a job's run output back to vault as a new note.
 *
 * Successes and failures both produce a note (design doc decision 5: "audit
 * lives in the same substrate as the work"). The failure path tags `job-run-
 * failed` in addition to `job-run` so vault saved-queries can show "recent
 * failures" without runner-side state.
 *
 * Failure cases per design doc decision 4 + 5:
 *   - non-zero claude exit
 *   - empty stdout (trimmed-empty — whitespace-only counts as empty)
 *   - timeout (timedOut=true, exit code reported as 124 by convention)
 *   - template render error during input rendering
 *
 * All four take the same shape: note tagged `job-run + job-run-failed`,
 * frontmatter carries `run_error`, `run_stderr_tail`, `run_exit_code`,
 * `parent_job_id`, `run_started_at`, `run_duration_ms`.
 */

import type { Job } from "./job-parser.ts";
import type { SpawnResult } from "./spawn.ts";
import type { VaultClient, VaultNote } from "./vault-client.ts";

/** Cap on stderr captured into the failure metadata — keep notes manageable. */
export const STDERR_TAIL_BYTES = 2048;

export type RunMetadata = {
  parent_job_id: string;
  run_started_at: string;
  run_duration_ms: number;
  run_exit_code: number;
  run_id: string;
  model: string;
  /** Present only on failures. */
  run_error?: string;
  /** Present only on failures. Last ~2KB of stderr. */
  run_stderr_tail?: string;
};

export type WriteOutcome = {
  status: "ok" | "failed";
  outputPath: string;
  note: VaultNote;
  metadata: RunMetadata;
};

export type WriteOpts = {
  client: VaultClient;
  job: Job;
  outputPath: string;
  runId: string;
  startedAt: Date;
  result: SpawnResult;
};

/**
 * Decide success vs failure and write the appropriate note. The decision
 * lives here (not in spawn.ts) so the writer is the one place that names
 * the failure-tag convention.
 */
export async function writeRunOutput(opts: WriteOpts): Promise<WriteOutcome> {
  const { client, job, outputPath, runId, startedAt, result } = opts;
  const trimmed = result.stdout.trim();
  const failed = result.exitCode !== 0 || result.timedOut || trimmed.length === 0;

  const baseMetadata: RunMetadata = {
    parent_job_id: job.id,
    run_started_at: startedAt.toISOString(),
    run_duration_ms: result.durationMs,
    run_exit_code: result.timedOut ? 124 : result.exitCode,
    run_id: runId,
    model: job.model,
  };

  if (!failed) {
    const note = await client.createNote({
      path: outputPath,
      content: trimmed,
      tags: job.outputTags,
      metadata: baseMetadata,
    });
    return { status: "ok", outputPath, note, metadata: baseMetadata };
  }

  // Failure path: extra tag, error fields, body is a brief summary + stderr tail.
  const tags = job.outputTags.includes("job-run-failed")
    ? job.outputTags
    : [...job.outputTags, "job-run-failed"];
  const stderrTail = tailBytes(result.stderr, STDERR_TAIL_BYTES);
  const reason = result.timedOut
    ? `claude -p timed out after ${result.durationMs}ms`
    : result.exitCode !== 0
      ? `claude -p exited with code ${result.exitCode}`
      : "claude -p produced empty stdout";
  const metadata: RunMetadata = {
    ...baseMetadata,
    run_error: reason,
    run_stderr_tail: stderrTail,
  };

  const body = renderFailureBody({ reason, stderrTail });
  const note = await client.createNote({
    path: failureOutputPath(outputPath),
    content: body,
    tags,
    metadata,
  });
  return { status: "failed", outputPath: failureOutputPath(outputPath), note, metadata };
}

/**
 * Failure notes land at `<outputPath>.failed` so they don't clobber a later
 * successful run at the same path. Aaron's gitcoin-brain prototype wrote
 * failures at the same path; runner's design doc (decision 5) implies a
 * distinct location via the `job-run-failed` tag — adding a path suffix
 * makes the convention explicit on disk too.
 */
export function failureOutputPath(outputPath: string): string {
  return `${outputPath}.failed`;
}

/**
 * Failure body: human-readable header + the captured stderr tail. Operators
 * triage by reading the note (or by querying tag:job-run-failed).
 */
function renderFailureBody(opts: { reason: string; stderrTail: string }): string {
  return [
    "# job-run failed",
    "",
    `**Reason:** ${opts.reason}`,
    "",
    "## stderr (tail)",
    "",
    "```",
    opts.stderrTail || "(empty)",
    "```",
    "",
  ].join("\n");
}

/**
 * Return the last `n` bytes of a string, UTF-8 aware via TextEncoder. Keeps
 * note bodies bounded so a runaway stderr doesn't bloat the vault.
 */
function tailBytes(s: string, n: number): string {
  if (!s) return "";
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  if (bytes.length <= n) return s;
  const tail = bytes.slice(bytes.length - n);
  return new TextDecoder("utf-8", { fatal: false }).decode(tail);
}
