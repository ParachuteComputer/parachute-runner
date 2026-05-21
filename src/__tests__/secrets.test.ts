/**
 * Tests for `src/secrets.ts` — AES-256-GCM round-trip, master.key generation
 * + permissions, envelope tamper-detection, and plaintext-config migration.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  SECRETS_FILE_VERSION,
  SecretsError,
  SecretsStore,
  loadMasterKey,
  migratePlaintextToken,
  resolveSecretsPaths,
} from "../secrets.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "runner-secrets-"));
}

describe("resolveSecretsPaths", () => {
  it("uses PARACHUTE_HOME when set", () => {
    const p = resolveSecretsPaths({ PARACHUTE_HOME: "/tmp/r" });
    expect(p.masterKeyPath).toBe("/tmp/r/runner/master.key");
    expect(p.secretsPath).toBe("/tmp/r/runner/secrets.json");
  });
  it("falls back to HOME/.parachute when PARACHUTE_HOME is unset", () => {
    const p = resolveSecretsPaths({ HOME: "/Users/x" });
    expect(p.masterKeyPath).toBe("/Users/x/.parachute/runner/master.key");
  });
});

describe("loadMasterKey", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("auto-generates a 32-byte key with mode 0o600 on first read when createIfMissing", () => {
    const paths = {
      dir,
      masterKeyPath: path.join(dir, "master.key"),
      secretsPath: path.join(dir, "secrets.json"),
    };
    const key = loadMasterKey(paths, { createIfMissing: true });
    expect(key.length).toBe(32);
    const stat = fs.statSync(paths.masterKeyPath);
    // owner-read-write only
    expect(stat.mode & 0o777).toBe(0o600);
    // Second call returns the same bytes
    const key2 = loadMasterKey(paths, { createIfMissing: true });
    expect(Buffer.compare(key, key2)).toBe(0);
  });

  it("throws SecretsError when missing and createIfMissing is false", () => {
    const paths = {
      dir,
      masterKeyPath: path.join(dir, "master.key"),
      secretsPath: path.join(dir, "secrets.json"),
    };
    expect(() => loadMasterKey(paths, { createIfMissing: false })).toThrow(SecretsError);
  });

  it("throws SecretsError with master_key_corrupt on wrong-size key", () => {
    const paths = {
      dir,
      masterKeyPath: path.join(dir, "master.key"),
      secretsPath: path.join(dir, "secrets.json"),
    };
    fs.writeFileSync(paths.masterKeyPath, Buffer.from([1, 2, 3, 4]));
    try {
      loadMasterKey(paths);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsError);
      expect((e as SecretsError).code).toBe("master_key_corrupt");
    }
  });
});

describe("SecretsStore — AES-GCM round-trip", () => {
  let dir: string;
  beforeEach(() => {
    dir = tmpDir();
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function newStore(): SecretsStore {
    return new SecretsStore({
      paths: {
        dir,
        masterKeyPath: path.join(dir, "master.key"),
        secretsPath: path.join(dir, "secrets.json"),
      },
    });
  }

  it("encrypts on save, decrypts on load — round trip preserves the plaintext", () => {
    const store = newStore();
    store.save("vault_token", "pvt_abc_super_secret_value");
    expect(store.load("vault_token")).toBe("pvt_abc_super_secret_value");
  });

  it("two writes of the same plaintext produce different ciphertexts (fresh IV)", () => {
    const store = newStore();
    store.save("vault_token", "same-secret");
    const env1 = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")) as {
      entries: Record<string, { ciphertext: string; iv: string }>;
    };
    store.save("vault_token", "same-secret");
    const env2 = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")) as {
      entries: Record<string, { ciphertext: string; iv: string }>;
    };
    expect(env1.entries.vault_token!.iv).not.toBe(env2.entries.vault_token!.iv);
    expect(env1.entries.vault_token!.ciphertext).not.toBe(env2.entries.vault_token!.ciphertext);
  });

  it("envelope file is mode 0o600", () => {
    const store = newStore();
    store.save("vault_token", "v");
    const stat = fs.statSync(path.join(dir, "secrets.json"));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("envelope file has version field matching SECRETS_FILE_VERSION", () => {
    const store = newStore();
    store.save("vault_token", "v");
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, "secrets.json"), "utf8")) as {
      version: number;
    };
    expect(parsed.version).toBe(SECRETS_FILE_VERSION);
  });

  it("load returns null for an absent key — first boot path", () => {
    const store = newStore();
    expect(store.load("vault_token")).toBeNull();
  });

  it("clear removes the entry; load returns null afterwards", () => {
    const store = newStore();
    store.save("vault_token", "v");
    expect(store.load("vault_token")).toBe("v");
    store.clear("vault_token");
    expect(store.load("vault_token")).toBeNull();
  });

  it("clear is idempotent on absent keys", () => {
    const store = newStore();
    expect(() => store.clear("vault_token")).not.toThrow();
    expect(() => store.clear("vault_token")).not.toThrow();
  });

  it("has() reports presence accurately", () => {
    const store = newStore();
    expect(store.has("vault_token")).toBe(false);
    store.save("vault_token", "v");
    expect(store.has("vault_token")).toBe(true);
    store.clear("vault_token");
    expect(store.has("vault_token")).toBe(false);
  });

  it("decrypt throws SecretsError(decrypt_failed) on tampered ciphertext", () => {
    const store = newStore();
    store.save("vault_token", "v");
    const file = path.join(dir, "secrets.json");
    const env = JSON.parse(fs.readFileSync(file, "utf8")) as {
      version: number;
      entries: Record<string, { iv: string; tag: string; ciphertext: string }>;
    };
    // Flip a byte in the ciphertext
    const entry = env.entries.vault_token!;
    const ct = Buffer.from(entry.ciphertext, "base64");
    ct[0] = (ct[0] ?? 0) ^ 0xff;
    entry.ciphertext = ct.toString("base64");
    fs.writeFileSync(file, JSON.stringify(env), { mode: 0o600 });
    try {
      store.load("vault_token");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsError);
      expect((e as SecretsError).code).toBe("decrypt_failed");
    }
  });

  it("decrypt throws SecretsError(decrypt_failed) when the master key changes", () => {
    const store = newStore();
    store.save("vault_token", "v");
    // Rewrite master.key with a different 32-byte value
    fs.writeFileSync(path.join(dir, "master.key"), Buffer.alloc(32, 0xab), { mode: 0o600 });
    const store2 = newStore();
    try {
      store2.load("vault_token");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsError);
      expect((e as SecretsError).code).toBe("decrypt_failed");
    }
  });

  it("envelope read rejects unknown version", () => {
    const file = path.join(dir, "secrets.json");
    // Force the master.key into existence first so constructor doesn't fail.
    new SecretsStore({
      paths: {
        dir,
        masterKeyPath: path.join(dir, "master.key"),
        secretsPath: file,
      },
    });
    fs.writeFileSync(file, JSON.stringify({ version: 999, entries: {} }));
    const store2 = newStore();
    try {
      store2.load("vault_token");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(SecretsError);
      expect((e as SecretsError).code).toBe("envelope_corrupt");
    }
  });
});

describe("migratePlaintextToken", () => {
  let dir: string;
  let configPath: string;
  let store: SecretsStore;

  beforeEach(() => {
    dir = tmpDir();
    configPath = path.join(dir, "config.json");
    store = new SecretsStore({
      paths: {
        dir,
        masterKeyPath: path.join(dir, "master.key"),
        secretsPath: path.join(dir, "secrets.json"),
      },
    });
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("moves plaintext vault_token into the encrypted envelope + rewrites config.json without it", () => {
    fs.writeFileSync(
      configPath,
      JSON.stringify({ vault_url: "http://x", vault_token: "pvt_legacy" }),
    );
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    const migrated = migratePlaintextToken({ configPath, rawConfig: raw, store });
    expect(migrated).toBe(true);
    expect(store.load("vault_token")).toBe("pvt_legacy");
    const after = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(after.vault_token).toBeUndefined();
    expect(after.vault_url).toBe("http://x");
  });

  it("returns false when no plaintext token is present", () => {
    fs.writeFileSync(configPath, JSON.stringify({ vault_url: "http://x" }));
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(migratePlaintextToken({ configPath, rawConfig: raw, store })).toBe(false);
  });

  it("the rewritten config.json is mode 0o600", () => {
    fs.writeFileSync(configPath, JSON.stringify({ vault_url: "http://x", vault_token: "pvt_x" }));
    const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    migratePlaintextToken({ configPath, rawConfig: raw, store });
    const stat = fs.statSync(configPath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it("idempotent — running twice on the post-migration state is a no-op", () => {
    fs.writeFileSync(configPath, JSON.stringify({ vault_url: "http://x", vault_token: "pvt_x" }));
    let raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(migratePlaintextToken({ configPath, rawConfig: raw, store })).toBe(true);
    raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    expect(migratePlaintextToken({ configPath, rawConfig: raw, store })).toBe(false);
  });
});
