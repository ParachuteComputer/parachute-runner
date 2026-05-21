/**
 * Render `{{date}}`, `{{job_name}}`, `{{run_id}}` template variables.
 *
 * Per design doc decision 4: **unknown variables are a fail-fast error**.
 * A typo like `{{Date}}` should not silently render to an empty string and
 * write an output note to `jobs/runs/job/.md` — surface the typo loudly so
 * the operator can fix the source job.
 */

export type TemplateVars = {
  date: string;
  job_name: string;
  run_id: string;
};

export class TemplateError extends Error {
  override name = "TemplateError" as const;
  readonly unknownVars: string[];
  constructor(unknownVars: string[]) {
    super(
      `unknown template variable(s): ${unknownVars
        .map((v) => `{{${v}}}`)
        .join(", ")} — supported: {{date}}, {{job_name}}, {{run_id}}`,
    );
    this.unknownVars = unknownVars;
  }
}

/**
 * Replace `{{var}}` references in `text` against `vars`. Unknown variables
 * across all matches are collected and reported in a single
 * `TemplateError`, so the operator sees every typo at once.
 */
export function render(text: string, vars: TemplateVars): string {
  const unknown = new Set<string>();
  const out = text.replace(/\{\{([^}]+)\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim();
    if (key in vars) return (vars as Record<string, string>)[key] ?? "";
    unknown.add(key);
    return "";
  });
  if (unknown.size > 0) throw new TemplateError([...unknown]);
  return out;
}

/**
 * ISO `YYYY-MM-DD` for the supplied `Date`, evaluated in UTC. Default
 * argument is "now", so callers usually pass nothing.
 */
export function isoDate(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  const d = String(now.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Generate a fresh UUIDv4. `crypto.randomUUID()` is available on Bun/Node ≥19.
 * Wrapped so tests can override deterministically when they care.
 */
export function randomRunId(): string {
  return crypto.randomUUID();
}
