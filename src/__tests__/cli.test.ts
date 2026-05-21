/**
 * Tests for `bin/parachute-runner.ts` — argv handling, --help / --version,
 * exit codes.
 *
 * Spawn the bin under bun to exercise the literal entry point.
 */

import { describe, expect, it } from "bun:test";
import * as path from "node:path";

import pkg from "../../package.json" with { type: "json" };

const BIN = path.join(import.meta.dir, "..", "..", "bin", "parachute-runner.ts");

async function runBin(args: string[], opts: { env?: Record<string, string> } = {}) {
  const proc = Bun.spawn(["bun", BIN, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode };
}

describe("parachute-runner CLI", () => {
  it("--help exits 0 with usage", async () => {
    const r = await runBin(["--help"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("parachute-runner");
    expect(r.stdout).toContain("serve");
    expect(r.stdout).toContain("once");
  });

  it("-h is an alias for --help", async () => {
    const r = await runBin(["-h"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("Usage");
  });

  it("--version prints package version", async () => {
    const r = await runBin(["--version"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe(pkg.version);
  });

  it("unknown command exits non-zero with help hint", async () => {
    const r = await runBin(["wat"]);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("Unknown command");
  });

  it("once with no config exits 2 (fatal)", async () => {
    // Point PARACHUTE_HOME at a tempdir with no runner/config.json so the
    // config loader bails out fast.
    const r = await runBin(["once"], { env: { PARACHUTE_HOME: "/tmp/runner-cli-missing-config" } });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain("fatal");
  });
});
