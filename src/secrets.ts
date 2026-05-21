/**
 * Encrypted secret storage for parachute-runner.
 *
 * The `vault_token` is `pvt_*` material with `vault:<name>:write` scope — its
 * compromise is equivalent to whole-vault takeover for whoever holds the
 * token. Plaintext in `~/.parachute/runner/config.json` was acceptable for
 * Phase 1.1 (we shipped one commit; no operator instance yet), but the
 * design doc (decision 8) commits us to encrypted-at-rest before runner is
 * promoted to anyone else.
 *
 * Crypto shape (settled, simple, no novel cryptography):
 *   - **Cipher**: AES-256-GCM. Node's `crypto.createCipheriv` with a 12-byte
 *     IV — the standard shape for AEAD. A fresh random IV per write means
 *     identical plaintext encrypts to different ciphertext (no nonce-reuse
 *     class breaks even if the same secret is rewritten).
 *   - **Key**: 32 random bytes at `$PARACHUTE_HOME/runner/master.key`, chmod
 *     0o600, generated on first boot via `crypto.randomBytes(32)`. Backing
 *     up `master.key` is required for backup-restore — without it the
 *     `secrets.json` envelope is opaque.
 *   - **Envelope**: JSON file at `$PARACHUTE_HOME/runner/secrets.json` with
 *     `{ version: 1, entries: { <key>: { iv, tag, ciphertext } } }`. iv +
 *     tag + ciphertext are base64. The `version` field lets us migrate
 *     the on-disk shape later without re-keying every operator. Same atomic
 *     write pattern (tmp + rename + chmod 0o600) every other module uses.
 *
 * Plaintext migration. If a legacy `config.json` carries `vault_token`,
 * `migratePlaintextToken` moves it into `secrets.json` and rewrites
 * `config.json` without that field. Log line on success so the operator
 * sees the one-time transition. Failure to migrate is a hard error — better
 * to refuse boot than leave the plaintext in place.
 *
 * Failure modes (per the brief):
 *   - master.key missing on boot when secrets.json IS present → fail-fast
 *     with a clear restore-or-regenerate message. Without the key, the
 *     envelope is unrecoverable; surface that loudly rather than crash later
 *     in a vault-client call.
 *   - master.key corrupted (wrong size, unreadable) → same fail-fast.
 *   - Decrypt failure (tampered envelope, wrong key) → throw a typed error
 *     so the operator gets a single line, not a stack trace.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Known secret keys. v0.7 stores just the vault bearer; more land later. */
export type SecretKey = "vault_token";

/** Envelope version on disk. Increment on shape changes. */
export const SECRETS_FILE_VERSION = 1;

/** AES-256-GCM IV size in bytes (NIST-recommended, the only size jose/openssl honor in practice). */
const IV_BYTES = 12;
/** AES-256 key size in bytes. */
const KEY_BYTES = 32;
/** GCM auth tag size in bytes. */
const TAG_BYTES = 16;

export class SecretsError extends Error {
  override name = "SecretsError" as const;
  readonly code:
    | "master_key_missing"
    | "master_key_corrupt"
    | "envelope_corrupt"
    | "decrypt_failed"
    | "key_unknown";
  constructor(code: SecretsError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

export type SecretsPaths = {
  /** Directory holding master.key + secrets.json. */
  dir: string;
  masterKeyPath: string;
  secretsPath: string;
};

/**
 * Resolve `$PARACHUTE_HOME/runner/{master.key,secrets.json}`. Mirrors
 * `resolveConfigPath` in config.ts so all on-disk runner artifacts land in
 * one predictable directory.
 */
export function resolveSecretsPaths(
  env: Record<string, string | undefined> = process.env,
): SecretsPaths {
  const parachuteHome = env.PARACHUTE_HOME ?? path.join(env.HOME ?? os.homedir(), ".parachute");
  const dir = path.join(parachuteHome, "runner");
  return {
    dir,
    masterKeyPath: path.join(dir, "master.key"),
    secretsPath: path.join(dir, "secrets.json"),
  };
}

/**
 * Read the 32-byte master key. Auto-generates on first boot IF
 * `createIfMissing` is true (the daemon path). Throws `SecretsError` with
 * an actionable code if the key is present-but-corrupt — that's never
 * something we want to silently regenerate, since it would also invalidate
 * any envelope on disk.
 *
 * Permissions are enforced (0o600) every time we write the file.
 */
export function loadMasterKey(
  paths: SecretsPaths,
  opts: { createIfMissing?: boolean } = {},
): Buffer {
  if (!existsSync(paths.masterKeyPath)) {
    if (opts.createIfMissing) {
      mkdirSync(paths.dir, { recursive: true });
      const key = randomBytes(KEY_BYTES);
      // Write through tmp + rename + chmod so a crash mid-write doesn't leave
      // a partial file with the wrong mode. Same atomic shape as scribe's
      // config-write atomic writer.
      const tmp = `${paths.masterKeyPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, key, { mode: 0o600 });
      renameSync(tmp, paths.masterKeyPath);
      chmodSync(paths.masterKeyPath, 0o600);
      return key;
    }
    throw new SecretsError(
      "master_key_missing",
      `Master key not found at ${paths.masterKeyPath}. Run \`parachute-runner serve\` once to generate (or restore from backup). Without the master key, encrypted secrets cannot be read.`,
    );
  }
  let raw: Buffer;
  try {
    raw = readFileSync(paths.masterKeyPath);
  } catch (e) {
    throw new SecretsError(
      "master_key_corrupt",
      `Failed to read master key at ${paths.masterKeyPath}: ${(e as Error).message}`,
    );
  }
  if (raw.length !== KEY_BYTES) {
    throw new SecretsError(
      "master_key_corrupt",
      `Master key at ${paths.masterKeyPath} is ${raw.length} bytes; expected ${KEY_BYTES}. Restore from backup or delete the file and re-enter all secrets to regenerate.`,
    );
  }
  return raw;
}

/** Internal on-disk shape for `secrets.json`. */
type SecretsFile = {
  version: number;
  entries: Record<string, { iv: string; tag: string; ciphertext: string }>;
};

/**
 * Read + parse `secrets.json`. Returns an empty envelope if the file doesn't
 * exist yet — first-boot path with no secrets stored. Throws on a present-
 * but-malformed file (operator notices via the boot log, not a silent reset).
 */
function readEnvelope(paths: SecretsPaths): SecretsFile {
  if (!existsSync(paths.secretsPath)) {
    return { version: SECRETS_FILE_VERSION, entries: {} };
  }
  let raw: string;
  try {
    raw = readFileSync(paths.secretsPath, "utf8");
  } catch (e) {
    throw new SecretsError(
      "envelope_corrupt",
      `Failed to read ${paths.secretsPath}: ${(e as Error).message}`,
    );
  }
  if (raw.trim().length === 0) {
    return { version: SECRETS_FILE_VERSION, entries: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new SecretsError(
      "envelope_corrupt",
      `Failed to parse ${paths.secretsPath}: ${(e as Error).message}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new SecretsError("envelope_corrupt", `${paths.secretsPath}: root must be an object`);
  }
  const o = parsed as Record<string, unknown>;
  if (typeof o.version !== "number") {
    throw new SecretsError("envelope_corrupt", `${paths.secretsPath}: missing version`);
  }
  if (o.version !== SECRETS_FILE_VERSION) {
    throw new SecretsError(
      "envelope_corrupt",
      `${paths.secretsPath}: unsupported version ${o.version} (expected ${SECRETS_FILE_VERSION})`,
    );
  }
  const entries = o.entries;
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
    throw new SecretsError("envelope_corrupt", `${paths.secretsPath}: missing entries object`);
  }
  return { version: SECRETS_FILE_VERSION, entries: entries as SecretsFile["entries"] };
}

/**
 * Atomic write of `secrets.json`. tmp + rename + chmod 0o600, same shape as
 * the master-key writer.
 */
function writeEnvelope(paths: SecretsPaths, env: SecretsFile): void {
  mkdirSync(paths.dir, { recursive: true });
  const tmp = `${paths.secretsPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(env, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, paths.secretsPath);
  chmodSync(paths.secretsPath, 0o600);
}

/**
 * Encrypt a plaintext string with AES-256-GCM. Returns the IV, auth tag, and
 * ciphertext as a base64 trio. Fresh random IV per call — never reused for
 * a given key/plaintext pair.
 */
function encryptValue(
  key: Buffer,
  plaintext: string,
): { iv: string; tag: string; ciphertext: string } {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  if (tag.length !== TAG_BYTES) {
    // Defensive — Node's GCM always returns 16 bytes. If this ever fails the
    // module is broken; we want to know in the test, not after a write.
    throw new SecretsError("decrypt_failed", `unexpected GCM tag length: ${tag.length}`);
  }
  return {
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ct.toString("base64"),
  };
}

/**
 * Decrypt an envelope entry. Throws `SecretsError` with `decrypt_failed`
 * when the tag check fails (tampered ciphertext or wrong key) — that's the
 * AEAD guarantee. Operators chasing a boot failure get the typed error,
 * not a Node `Error: Unsupported state or unable to authenticate data`.
 */
function decryptValue(key: Buffer, entry: { iv: string; tag: string; ciphertext: string }): string {
  let iv: Buffer;
  let tag: Buffer;
  let ct: Buffer;
  try {
    iv = Buffer.from(entry.iv, "base64");
    tag = Buffer.from(entry.tag, "base64");
    ct = Buffer.from(entry.ciphertext, "base64");
  } catch (e) {
    throw new SecretsError(
      "envelope_corrupt",
      `failed to decode envelope fields: ${(e as Error).message}`,
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new SecretsError("envelope_corrupt", `iv length is ${iv.length}; expected ${IV_BYTES}`);
  }
  if (tag.length !== TAG_BYTES) {
    throw new SecretsError(
      "envelope_corrupt",
      `tag length is ${tag.length}; expected ${TAG_BYTES}`,
    );
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
    return pt.toString("utf8");
  } catch (e) {
    throw new SecretsError(
      "decrypt_failed",
      `decrypt failed (wrong key or tampered envelope): ${(e as Error).message}`,
    );
  }
}

export type SecretsStoreOpts = {
  paths?: SecretsPaths;
  /** When true (default for daemon path), auto-generate master.key on first boot. */
  createIfMissing?: boolean;
};

/**
 * In-process accessor over the encrypted envelope. Constructed once per
 * boot; read + write methods read the file fresh on each call (dynamic-state
 * pattern — see MEMORY.md feedback_static_vs_dynamic_state). Hot-reload of
 * `vault_token` after a PUT to `.parachute/config` Just Works because the
 * scheduler re-reads via `loadSecret` rather than caching a stale value.
 */
export class SecretsStore {
  readonly paths: SecretsPaths;
  private key: Buffer;

  constructor(opts: SecretsStoreOpts = {}) {
    this.paths = opts.paths ?? resolveSecretsPaths();
    this.key = loadMasterKey(this.paths, { createIfMissing: opts.createIfMissing ?? true });
  }

  /**
   * Read + decrypt one secret. Returns null when the key isn't present in
   * the envelope (cleared, never written). Throws on decrypt failure — never
   * silently substitutes an empty value, since that would mask a tampered
   * envelope as a missing one.
   */
  load(key: SecretKey): string | null {
    const env = readEnvelope(this.paths);
    const entry = env.entries[key];
    if (!entry) return null;
    return decryptValue(this.key, entry);
  }

  /**
   * Encrypt + write one secret. Read-modify-write the envelope so unrelated
   * entries survive. Atomic on rename.
   */
  save(key: SecretKey, value: string): void {
    const env = readEnvelope(this.paths);
    env.entries[key] = encryptValue(this.key, value);
    writeEnvelope(this.paths, env);
  }

  /**
   * Drop a secret entirely (admin "clear credential" path per Q2 from
   * site#52). Idempotent — clearing an absent key is a no-op.
   */
  clear(key: SecretKey): void {
    const env = readEnvelope(this.paths);
    if (!(key in env.entries)) return;
    delete env.entries[key];
    writeEnvelope(this.paths, env);
  }

  /**
   * True when the envelope holds an entry for this key. Lets the config
   * loader distinguish "no secret yet, fail-fast" from "secret present but
   * undecryptable" (the second wraps the underlying SecretsError).
   */
  has(key: SecretKey): boolean {
    const env = readEnvelope(this.paths);
    return Boolean(env.entries[key]);
  }
}

/**
 * One-time migration of a plaintext `vault_token` from `config.json` into
 * the encrypted envelope. Returns true when a migration actually happened
 * (caller logs the one-line notice); false on no-op (nothing to migrate or
 * already migrated).
 *
 * The caller passes in the parsed config object and the path it came from.
 * We rewrite the config without the `vault_token` field after a successful
 * envelope write. Order matters: write envelope first, then rewrite config
 * — a crash between the two leaves the plaintext intact and migration
 * re-runs on next boot (idempotent).
 */
export function migratePlaintextToken(opts: {
  configPath: string;
  rawConfig: Record<string, unknown>;
  store: SecretsStore;
}): boolean {
  const { configPath, rawConfig, store } = opts;
  const plaintext = rawConfig.vault_token;
  if (typeof plaintext !== "string" || plaintext.length === 0) return false;

  // Write encrypted first so the source of truth flips before we rewrite the
  // plaintext file. If the rewrite crashes mid-flight, next boot re-encrypts
  // the same value (idempotent) and tries the rewrite again.
  store.save("vault_token", plaintext);

  // Rewrite config.json without the plaintext field. Atomic + 0o600.
  const next: Record<string, unknown> = { ...rawConfig };
  next.vault_token = undefined;
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, configPath);
  chmodSync(configPath, 0o600);
  return true;
}
