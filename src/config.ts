/**
 * Config loading + writing for parachute-runner.
 *
 * Reads `$PARACHUTE_HOME/runner/config.json` (default `~/.parachute/runner/config.json`)
 * and validates against the shape captured in `.parachute/config/schema`. Required
 * fields are fail-fast — a missing `vault_url` or `vault_token` raises a
 * `ConfigError` rather than silently defaulting.
 *
 * Phase 1.2: the `vault_token` lives encrypted in `secrets.json` (see
 * `src/secrets.ts`), not in `config.json`. On boot we transparently merge the
 * two sources before validation. Plaintext `vault_token` in a legacy
 * `config.json` is auto-migrated to the encrypted envelope and stripped from
 * the file on first read.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { dirname } from "node:path";
import {
  SecretsError,
  type SecretsPaths,
  SecretsStore,
  migratePlaintextToken,
  resolveSecretsPaths,
} from "./secrets.ts";

export type RunnerConfig = {
  vault_url: string;
  vault_name: string;
  vault_token: string;
  poll_interval_seconds: number;
  max_concurrent_jobs: number;
  disabled: boolean;
};

/**
 * Wire shape — what GET /.parachute/config returns and PUT accepts. Identical
 * to `RunnerConfig` except `vault_token` is `writeOnly` per the schema and
 * is omitted from GET responses. Optional on PUT so a partial update can
 * change just one field.
 */
export type RunnerConfigWire = {
  vault_url?: string;
  vault_name?: string;
  vault_token?: string;
  poll_interval_seconds?: number;
  max_concurrent_jobs?: number;
  disabled?: boolean;
};

/** Fields that GET /.parachute/config returns to the SPA. `vault_token` is omitted. */
export type RunnerConfigPublic = Omit<RunnerConfig, "vault_token">;

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

export type LoadConfigOpts = {
  configPath?: string;
  /** Override the secrets store (tests). */
  secrets?: SecretsStore;
  /** Override the boot logger (tests). */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

/**
 * Load + validate runner config from disk. Throws `ConfigError` on any
 * structural problem — missing file, malformed JSON, missing required field,
 * type mismatch. Defaults are applied to optional fields per the schema.
 *
 * Phase 1.2 lift: the `vault_token` may live in `secrets.json` rather than
 * the file. We merge before validation; legacy plaintext in `config.json`
 * is migrated into the envelope and the file is rewritten without it.
 */
export function loadConfig(opts: LoadConfigOpts | string = {}): RunnerConfig {
  // Back-compat: the prior signature was `loadConfig(configPath?: string)`.
  // Callers in run-once.test.ts + scheduler.test.ts pass a string. Honor it.
  const normalized: LoadConfigOpts = typeof opts === "string" ? { configPath: opts } : opts;
  const configPath = normalized.configPath ?? resolveConfigPath();
  const logger = normalized.logger ?? console;

  if (!existsSync(configPath)) {
    throw new ConfigError(
      "config file not found — run `parachute install runner` or write one manually",
      configPath,
    );
  }

  let raw: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ConfigError("config root must be a JSON object", configPath);
    }
    raw = parsed as Record<string, unknown>;
  } catch (e) {
    if (e instanceof ConfigError) throw e;
    throw new ConfigError(`failed to parse JSON: ${(e as Error).message}`, configPath);
  }

  // Resolve the secrets store. Tests inject one rooted at a tmpdir; production
  // path uses the default `$PARACHUTE_HOME/runner/`. When a non-canonical
  // configPath is passed (i.e. a test tmpdir), derive the secrets-dir from
  // the config-file's directory so tests don't accidentally read/write the
  // operator's real `~/.parachute/runner/master.key`.
  const store = normalized.secrets ?? new SecretsStore({ paths: deriveSecretsPaths(configPath) });

  // One-time plaintext migration. Run BEFORE we read the encrypted store so
  // the move-and-rewrite happens before validation.
  let migrated = false;
  try {
    migrated = migratePlaintextToken({ configPath, rawConfig: raw, store });
  } catch (e) {
    if (e instanceof SecretsError) {
      throw new ConfigError(
        `failed to migrate plaintext vault_token into encrypted storage: ${e.message}`,
        configPath,
      );
    }
    throw e;
  }
  if (migrated) {
    logger.log(
      `[runner] migrated plaintext vault_token from ${configPath} into encrypted ${store.paths.secretsPath}`,
    );
    // The migration writer stripped `vault_token` from the on-disk file —
    // reflect that in the in-memory copy too so validation sees the post-
    // migration shape.
    raw.vault_token = undefined;
  }

  // Pull the (now-encrypted) token from the store and re-merge for
  // validation. If the operator deliberately cleared the credential (POST
  // /clear-credential/vault-token, or first install without writing one),
  // `loaded` is null and validateConfig fails with the required-field error
  // — same UX as Phase 1.1's missing-vault-token.
  let loaded: string | null;
  try {
    loaded = store.load("vault_token");
  } catch (e) {
    if (e instanceof SecretsError) {
      throw new ConfigError(`failed to read encrypted vault_token: ${e.message}`, configPath);
    }
    throw e;
  }
  const merged: Record<string, unknown> = { ...raw };
  if (loaded !== null) merged.vault_token = loaded;

  return validateConfig(merged, configPath);
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

/**
 * When a non-default configPath is in play (test tmpdir, custom layout),
 * place `master.key` + `secrets.json` alongside it. Production callers
 * pass the canonical path and we fall through to the env-driven default.
 */
function deriveSecretsPaths(configPath: string): SecretsPaths {
  const canonical = resolveConfigPath();
  if (configPath === canonical) return resolveSecretsPaths();
  const dir = dirname(configPath);
  return {
    dir,
    masterKeyPath: path.join(dir, "master.key"),
    secretsPath: path.join(dir, "secrets.json"),
  };
}

/** Strip `vault_token` from a config so it can be returned by GET /.parachute/config. */
export function toPublicConfig(cfg: RunnerConfig): RunnerConfigPublic {
  const { vault_token: _omit, ...publicCfg } = cfg;
  return publicCfg;
}

export type ValidationError = { path: string; message: string };

export type WireValidationResult =
  | { ok: true; value: RunnerConfigWire }
  | { ok: false; errors: ValidationError[] };

/** Whitelist of wire-shape fields we accept on PUT. */
const WIRE_FIELDS = new Set<keyof RunnerConfigWire>([
  "vault_url",
  "vault_name",
  "vault_token",
  "poll_interval_seconds",
  "max_concurrent_jobs",
  "disabled",
]);

/**
 * Validate a PUT body. Partial — only field types are checked; missing
 * fields mean "leave unchanged" not "use default". Unknown top-level keys
 * are rejected (additionalProperties:false) so a typo on the wire fails
 * loud rather than silently no-opping.
 */
export function validatePutBody(body: unknown): WireValidationResult {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, errors: [{ path: "", message: "body must be a JSON object" }] };
  }
  const o = body as Record<string, unknown>;
  const errors: ValidationError[] = [];
  const out: RunnerConfigWire = {};
  for (const key of Object.keys(o)) {
    if (!WIRE_FIELDS.has(key as keyof RunnerConfigWire)) {
      errors.push({ path: key, message: `unknown field "${key}"` });
    }
  }
  const checkString = (k: keyof RunnerConfigWire) => {
    if (!(k in o)) return;
    const v = o[k];
    if (typeof v !== "string" || v.length === 0) {
      errors.push({ path: k as string, message: `${String(k)} must be a non-empty string` });
      return;
    }
    (out as Record<string, unknown>)[k] = v;
  };
  const checkInt = (k: keyof RunnerConfigWire, min: number) => {
    if (!(k in o)) return;
    const v = o[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < min) {
      errors.push({
        path: k as string,
        message: `${String(k)} must be an integer >= ${min}`,
      });
      return;
    }
    (out as Record<string, unknown>)[k] = v;
  };
  const checkBool = (k: keyof RunnerConfigWire) => {
    if (!(k in o)) return;
    const v = o[k];
    if (typeof v !== "boolean") {
      errors.push({ path: k as string, message: `${String(k)} must be a boolean` });
      return;
    }
    (out as Record<string, unknown>)[k] = v;
  };
  checkString("vault_url");
  checkString("vault_name");
  checkString("vault_token");
  checkInt("poll_interval_seconds", 1);
  checkInt("max_concurrent_jobs", 1);
  checkBool("disabled");
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: out };
}

/**
 * Read the existing on-disk config file (without merging in the encrypted
 * `vault_token`). Returns `{}` when the file is missing or empty. Used by
 * the PUT path: we read-modify-write the persisted shape, not the merged
 * one, so the secret stays out of `config.json`.
 */
export function readPersistedConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  if (raw.trim().length === 0) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError("config root must be a JSON object", configPath);
  }
  // Strip vault_token defensively — it should NEVER live here post-migration,
  // but if a future operator hand-edits the file we don't echo it back.
  const copy: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  copy.vault_token = undefined;
  return copy;
}

/** Atomic write of the non-secret config fields. tmp + rename + chmod 0o600. */
export function writeConfigFileAtomic(configPath: string, fields: Record<string, unknown>): void {
  mkdirSync(dirname(configPath), { recursive: true });
  // Strip vault_token defensively before any write — secrets never live here.
  const safe: Record<string, unknown> = { ...fields };
  safe.vault_token = undefined;
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(safe, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  chmodSync(configPath, 0o600);
}

/**
 * Apply a wire-shape PUT to the on-disk config + secret store, returning
 * the merged `RunnerConfig` so the caller can hot-reload the scheduler.
 *
 * Read-modify-write: missing fields on the wire mean "keep the existing
 * value", not "reset to default". This matches scribe's PUT semantics
 * (see scribe#45 must-fix 1).
 */
export function applyConfigPatch(opts: {
  configPath: string;
  patch: RunnerConfigWire;
  store: SecretsStore;
}): RunnerConfig {
  const { configPath, patch, store } = opts;
  const persisted = readPersistedConfig(configPath);

  // Merge non-secret fields: patch wins on present keys; absent keys carry
  // forward from disk.
  const next: Record<string, unknown> = { ...persisted };
  for (const k of [
    "vault_url",
    "vault_name",
    "poll_interval_seconds",
    "max_concurrent_jobs",
    "disabled",
  ] as const) {
    if (patch[k] !== undefined) next[k] = patch[k];
  }
  writeConfigFileAtomic(configPath, next);

  // Secret fields go to the envelope.
  if (typeof patch.vault_token === "string" && patch.vault_token.length > 0) {
    store.save("vault_token", patch.vault_token);
  }

  // Re-load through the canonical path so the returned config has all
  // defaults applied + secret merged + validation passed.
  return loadConfig({ configPath, secrets: store });
}
