/**
 * Tests for `src/config.ts` — JSON validation + path resolution.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ConfigError, loadConfig, resolveConfigPath, validateConfig } from "../config.ts";

describe("resolveConfigPath", () => {
  it("uses PARACHUTE_HOME when set", () => {
    const p = resolveConfigPath({ PARACHUTE_HOME: "/tmp/runner-test", HOME: "/Users/x" });
    expect(p).toBe("/tmp/runner-test/runner/config.json");
  });

  it("falls back to HOME/.parachute when PARACHUTE_HOME is unset", () => {
    const p = resolveConfigPath({ HOME: "/Users/x" });
    expect(p).toBe("/Users/x/.parachute/runner/config.json");
  });
});

describe("validateConfig", () => {
  it("accepts a minimal valid config", () => {
    const cfg = validateConfig({
      vault_url: "http://127.0.0.1:1940",
      vault_token: "pvt_abc",
    });
    expect(cfg.vault_url).toBe("http://127.0.0.1:1940");
    expect(cfg.vault_name).toBe("default");
    expect(cfg.vault_token).toBe("pvt_abc");
    expect(cfg.poll_interval_seconds).toBe(60);
    expect(cfg.max_concurrent_jobs).toBe(4);
    expect(cfg.disabled).toBe(false);
  });

  it("strips trailing slash from vault_url", () => {
    const cfg = validateConfig({
      vault_url: "http://127.0.0.1:1940/",
      vault_token: "pvt_abc",
    });
    expect(cfg.vault_url).toBe("http://127.0.0.1:1940");
  });

  it("rejects missing vault_url", () => {
    expect(() => validateConfig({ vault_token: "pvt_abc" })).toThrow(ConfigError);
  });

  it("rejects missing vault_token", () => {
    expect(() => validateConfig({ vault_url: "http://127.0.0.1:1940" })).toThrow(ConfigError);
  });

  it("rejects non-object root", () => {
    expect(() => validateConfig("nope")).toThrow(ConfigError);
    expect(() => validateConfig([])).toThrow(ConfigError);
    expect(() => validateConfig(null)).toThrow(ConfigError);
  });

  it("rejects non-integer poll_interval_seconds", () => {
    expect(() =>
      validateConfig({
        vault_url: "http://x",
        vault_token: "t",
        poll_interval_seconds: 1.5,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects zero poll_interval_seconds", () => {
    expect(() =>
      validateConfig({
        vault_url: "http://x",
        vault_token: "t",
        poll_interval_seconds: 0,
      }),
    ).toThrow(ConfigError);
  });

  it("rejects non-boolean disabled", () => {
    expect(() =>
      validateConfig({ vault_url: "http://x", vault_token: "t", disabled: "yes" }),
    ).toThrow(ConfigError);
  });
});

describe("loadConfig", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-config-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads and validates a file", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        vault_url: "http://127.0.0.1:1940",
        vault_name: "gitcoin",
        vault_token: "pvt_xyz",
        poll_interval_seconds: 30,
      }),
    );
    const cfg = loadConfig(configPath);
    expect(cfg.vault_name).toBe("gitcoin");
    expect(cfg.poll_interval_seconds).toBe(30);
  });

  it("throws ConfigError on missing file", () => {
    expect(() => loadConfig(path.join(tmpDir, "nope.json"))).toThrow(ConfigError);
  });

  it("throws ConfigError on bad JSON", () => {
    const configPath = path.join(tmpDir, "config.json");
    fs.writeFileSync(configPath, "not json {");
    expect(() => loadConfig(configPath)).toThrow(ConfigError);
  });
});
