/**
 * @openparachute/runner — library entry.
 *
 * Phase 1.0 scaffolding: the public API surface is declared so downstream
 * callers (and Phase 1.1+ work) have stable shapes to import. The
 * implementations land later.
 *
 * See the design doc:
 *   https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md
 */

import pkg from "../package.json" with { type: "json" };

/** Package semver. Exposed so callers can verify which runner they linked. */
export const VERSION: string = pkg.version;

/**
 * Options for {@link runOnce}.
 *
 * The shape is provisional — Phase 1.1 fills the fields in and may rename or
 * extend before the first non-rc release.
 */
export type RunOnceOptions = {
  /** Limit maturation to a single job by vault path. */
  only?: string;
  /** Override the `{{date}}` template variable (ISO date, UTC). */
  date?: string;
  /** Enumerate + render but skip the `claude -p` spawn. */
  dryRun?: boolean;
};

/**
 * Options for {@link serve}.
 *
 * Provisional — Phase 1.1 fills it in.
 */
export type ServeOptions = {
  /** Override `poll_interval_seconds` from config for this invocation. */
  pollIntervalSeconds?: number;
};

/**
 * One-shot: query the vault for `tag:job`, mature any due jobs, write outputs, exit.
 *
 * **Phase 1.0 stub — throws.** Wired up in Phase 1.1.
 */
export async function runOnce(_opts: RunOnceOptions = {}): Promise<void> {
  throw new Error("runOnce: not yet implemented (Phase 1.1)");
}

/**
 * Long-running daemon: poll the vault for jobs on a cadence and mature them on schedule.
 *
 * **Phase 1.0 stub — throws.** Wired up in Phase 1.1.
 */
export async function serve(_opts: ServeOptions = {}): Promise<void> {
  throw new Error("serve: not yet implemented (Phase 1.1)");
}
