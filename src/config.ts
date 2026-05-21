/**
 * Config loading for parachute-runner.
 *
 * Reads `$PARACHUTE_HOME/runner/config.json` (default `~/.parachute/runner/config.json`)
 * and validates against the shape captured in `.parachute/config/schema`. Required
 * fields are fail-fast — a missing `vault_url` or `vault_token` raises a
 * `ConfigError` rather than silently defaulting.
 *
 * Phase 1.1: PARACHUTE_HOME env-var override is the only env-var precedence we
 * recognize. Other env-var fallbacks (CLAUDE_MODEL, etc.) land in Phase 1.2+
 * if operators ask for them.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type RunnerConfig = {
  vault_url: string;
  vault_name: string;
  vault_token: string;
  poll_interval_seconds: number;
  max_concurrent_jobs: number;
  disabled: boolean;
};

export class ConfigError extends Error {
  override name = "ConfigError" as const;
  readonly path: string;
  constructor(message: string, configPath: string) {
    super(`${message} (config: ${configPath})`);
    this.path = configPath;
  }
}

/**
 * Resolve the canonical config path: `$PARACHUTE_HOME/runner/config.json`,
 * defaulting `PARACHUTE_HOME` to `~/.parachute`.
 *
 * Note: `os.homedir()` is cached at process start on Bun, so changes to
 * `process.env.HOME` after import don't propagate. For test friendliness we
 * prefer the live env var; that matches the same convention vault uses
 * (see `vault/src/mcp-install.ts` resolveInstallTarget).
 */
export function resolveConfigPath(env: Record<string, string | undefined> = process.env): string {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  return path.join(parachuteHome, "runner", "config.json");
}

/**
 * Load + validate runner config from disk. Throws `ConfigError` on any
 * structural problem — missing file, malformed JSON, missing required field,
 * type mismatch. Defaults are applied to optional fields per the schema.
 */
export function loadConfig(configPath: string = resolveConfigPath()): RunnerConfig {
  if (!fs.existsSync(configPath)) {
    throw new ConfigError(
      "config file not found — run `parachute install runner` or write one manually",
      configPath,
    );
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch (e) {
    throw new ConfigError(`failed to parse JSON: ${(e as Error).message}`, configPath);
  }

  return validateConfig(raw, configPath);
}

/**
 * Validate a parsed config object. Exported separately so tests can exercise
 * the shape-validation path without round-tripping through the filesystem.
 */
export function validateConfig(raw: unknown, configPath = "<inline>"): RunnerConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ConfigError("config root must be a JSON object", configPath);
  }
  const o = raw as Record<string, unknown>;

  // Required fields — fail-fast, no defaults.
  if (typeof o.vault_url !== "string" || o.vault_url.length === 0) {
    throw new ConfigError("`vault_url` is required (string)", configPath);
  }
  if (typeof o.vault_token !== "string" || o.vault_token.length === 0) {
    throw new ConfigError("`vault_token` is required (string)", configPath);
  }

  // Optional fields with defaults from the schema.
  const vault_name = o.vault_name === undefined ? "default" : o.vault_name;
  if (typeof vault_name !== "string" || vault_name.length === 0) {
    throw new ConfigError("`vault_name` must be a non-empty string", configPath);
  }

  const poll_interval_seconds =
    o.poll_interval_seconds === undefined ? 60 : o.poll_interval_seconds;
  if (
    typeof poll_interval_seconds !== "number" ||
    !Number.isInteger(poll_interval_seconds) ||
    poll_interval_seconds < 1
  ) {
    throw new ConfigError("`poll_interval_seconds` must be a positive integer", configPath);
  }

  const max_concurrent_jobs = o.max_concurrent_jobs === undefined ? 4 : o.max_concurrent_jobs;
  if (
    typeof max_concurrent_jobs !== "number" ||
    !Number.isInteger(max_concurrent_jobs) ||
    max_concurrent_jobs < 1
  ) {
    throw new ConfigError("`max_concurrent_jobs` must be a positive integer", configPath);
  }

  const disabled = o.disabled === undefined ? false : o.disabled;
  if (typeof disabled !== "boolean") {
    throw new ConfigError("`disabled` must be a boolean", configPath);
  }

  return {
    vault_url: stripTrailingSlash(o.vault_url),
    vault_name,
    vault_token: o.vault_token,
    poll_interval_seconds,
    max_concurrent_jobs,
    disabled,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}
