/**
 * Parse a vault note into a typed `Job` shape, validating frontmatter at
 * maturation time per the design doc (decision 4: "fail loud, fail late"
 * for v0.7; vault tag-schema enforcement at write-time lands in Phase 2).
 *
 * The note's body is the prompt. The frontmatter declares:
 *   - schedule       — cron-string or named preset (`daily`/`hourly`/`manual`)
 *   - model          — passed verbatim to `claude -p --model`
 *   - allowed_tools  — comma-joined for `claude -p --allowedTools`
 *   - output_path?   — defaults to `jobs/runs/<job-name>/<run-id>`
 *   - output_tags?   — defaults to `[job-run]`; `job-run` always added
 *   - timeout?       — defaults to `600s`; parsed to milliseconds
 *   - disabled?      — pause without deleting the note
 */

import matter from "gray-matter";
import type { VaultNote } from "./vault-client.ts";

export const NAMED_SCHEDULES: Record<string, string> = {
  daily: "0 0 * * *",
  hourly: "0 * * * *",
  weekly: "0 0 * * 0",
};

export const MANUAL_SCHEDULE = "manual";

export type Job = {
  /** Vault note ID. */
  id: string;
  /** Vault note path. */
  path: string;
  /** The basename of the path (no extension) — used as `{{job_name}}`. */
  name: string;
  /** Original schedule string. `manual` means never auto-fire. */
  schedule: string;
  /** Cron string the scheduler understands. `null` for `manual`. */
  cronString: string | null;
  /** Model id (claude-opus-4-7, etc.). */
  model: string;
  /** Default `jobs/runs/{{job_name}}/{{run_id}}` if absent in frontmatter. */
  outputPath: string;
  /** `job-run` is always present. */
  outputTags: string[];
  /** Comma-joined list, passed verbatim to claude -p --allowedTools. */
  allowedTools: string[];
  /** Milliseconds. Default 600_000 (10min). */
  timeoutMs: number;
  /** Skip but keep the note around. */
  disabled: boolean;
  /** The prompt body (frontmatter stripped). */
  prompt: string;
};

export class InvalidJobError extends Error {
  override name = "InvalidJobError" as const;
  readonly notePath: string;
  readonly reasons: string[];
  constructor(notePath: string, reasons: string[]) {
    super(`invalid job at ${notePath}: ${reasons.join("; ")}`);
    this.notePath = notePath;
    this.reasons = reasons;
  }
}

/**
 * Parse a vault note into a `Job`. Throws `InvalidJobError` listing every
 * problem so an operator gets the full picture instead of fixing-one-then-
 * surfacing-the-next.
 */
export function parseJob(note: VaultNote): Job {
  const notePath = note.path ?? note.id;
  const reasons: string[] = [];

  if (!note.id) reasons.push("note is missing an id");
  if (!note.path) reasons.push("note is missing a path");
  if (typeof note.content !== "string") {
    // Body is required to render a prompt.
    reasons.push("note has no content");
  }

  // gray-matter is robust against malformed YAML — it throws on truly broken
  // frontmatter (e.g. unterminated key). Wrap so we surface as InvalidJobError.
  let fm: Record<string, unknown> = {};
  let body = "";
  if (typeof note.content === "string") {
    try {
      const parsed = matter(note.content);
      fm = (parsed.data ?? {}) as Record<string, unknown>;
      body = parsed.content ?? "";
    } catch (e) {
      reasons.push(`frontmatter parse error: ${(e as Error).message}`);
    }
  }

  // Required: schedule
  const scheduleRaw = fm.schedule;
  let schedule = "";
  let cronString: string | null = null;
  if (typeof scheduleRaw !== "string" || scheduleRaw.trim().length === 0) {
    reasons.push("`schedule` is required (cron string or one of: daily, hourly, weekly, manual)");
  } else {
    schedule = scheduleRaw.trim();
    if (schedule === MANUAL_SCHEDULE) {
      cronString = null;
    } else if (schedule in NAMED_SCHEDULES) {
      cronString = NAMED_SCHEDULES[schedule] ?? null;
    } else if (looksLikeCron(schedule)) {
      cronString = schedule;
    } else {
      reasons.push(
        `\`schedule\` must be a 5-field cron string or one of: daily, hourly, weekly, manual (got: ${schedule})`,
      );
    }
  }

  // Required: model
  const modelRaw = fm.model;
  let model = "";
  if (typeof modelRaw !== "string" || modelRaw.trim().length === 0) {
    reasons.push("`model` is required (e.g. claude-opus-4-7)");
  } else {
    model = modelRaw.trim();
  }

  // Required: allowed_tools (array of strings, or a single comma-joined string)
  let allowedTools: string[] = [];
  const allowedRaw = fm.allowed_tools;
  if (allowedRaw === undefined || allowedRaw === null) {
    reasons.push(
      "`allowed_tools` is required (array of mcp__... tool names, or comma-separated string)",
    );
  } else if (Array.isArray(allowedRaw)) {
    if (allowedRaw.length === 0) {
      reasons.push("`allowed_tools` must be a non-empty array");
    } else if (!allowedRaw.every((t) => typeof t === "string" && t.length > 0)) {
      reasons.push("`allowed_tools` entries must all be non-empty strings");
    } else {
      allowedTools = allowedRaw as string[];
    }
  } else if (typeof allowedRaw === "string") {
    allowedTools = allowedRaw
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (allowedTools.length === 0) {
      reasons.push("`allowed_tools` string is empty after parsing");
    }
  } else {
    reasons.push("`allowed_tools` must be an array or comma-separated string");
  }

  // Optional: output_path
  const outputPathRaw = fm.output_path;
  if (outputPathRaw !== undefined && typeof outputPathRaw !== "string") {
    reasons.push("`output_path` must be a string if present");
  }

  // Optional: output_tags
  let outputTags: string[] = [];
  const outputTagsRaw = fm.output_tags;
  if (outputTagsRaw === undefined) {
    outputTags = ["job-run"];
  } else if (Array.isArray(outputTagsRaw)) {
    if (!outputTagsRaw.every((t) => typeof t === "string" && t.length > 0)) {
      reasons.push("`output_tags` entries must all be non-empty strings");
    } else {
      outputTags = outputTagsRaw as string[];
    }
  } else if (typeof outputTagsRaw === "string") {
    outputTags = [outputTagsRaw];
  } else {
    reasons.push("`output_tags` must be an array or single string");
  }
  // `job-run` is always present.
  if (!outputTags.includes("job-run")) outputTags = ["job-run", ...outputTags];

  // Optional: timeout
  const timeoutRaw = fm.timeout;
  let timeoutMs = 600_000;
  if (timeoutRaw !== undefined) {
    const parsed = parseTimeout(timeoutRaw);
    if (parsed === null) {
      reasons.push(
        `\`timeout\` must be a number (seconds) or duration string like "10m", "600s" (got: ${JSON.stringify(timeoutRaw)})`,
      );
    } else {
      timeoutMs = parsed;
    }
  }

  // Optional: disabled
  const disabledRaw = fm.disabled;
  let disabled = false;
  if (disabledRaw !== undefined) {
    if (typeof disabledRaw !== "boolean") {
      reasons.push("`disabled` must be a boolean");
    } else {
      disabled = disabledRaw;
    }
  }

  if (reasons.length > 0) throw new InvalidJobError(notePath, reasons);

  const path = note.path!;
  const name = basenameNoExt(path);

  return {
    id: note.id,
    path,
    name,
    schedule,
    cronString,
    model,
    outputPath:
      typeof outputPathRaw === "string" && outputPathRaw.length > 0
        ? outputPathRaw
        : "jobs/runs/{{job_name}}/{{run_id}}",
    outputTags,
    allowedTools,
    timeoutMs,
    disabled,
    prompt: body,
  };
}

/**
 * 5-field cron is the only shape we accept (matches `croner` defaults).
 * Permissive — only catches "obviously not cron" inputs so the cron library
 * doesn't surprise us by accepting `daily-and-then-some` literally.
 */
function looksLikeCron(s: string): boolean {
  const fields = s.trim().split(/\s+/);
  return fields.length === 5 || fields.length === 6;
}

/**
 * Parse a timeout value into milliseconds. Accepts:
 *   - number          → treated as seconds
 *   - "600", "600s"   → seconds
 *   - "10m"           → minutes
 *   - "1h"            → hours
 * Returns null on parse failure so the caller can wrap into the right
 * `InvalidJobError` shape with the surrounding context.
 */
export function parseTimeout(value: unknown): number | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return null;
    return Math.round(value * 1000);
  }
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (s.length === 0) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)([smh]?)$/i);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const unit = (m[2] ?? "").toLowerCase();
  const mult = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 1_000;
  return Math.round(n * mult);
}

function basenameNoExt(p: string): string {
  const last = p.split("/").pop() ?? p;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(0, dot) : last;
}
