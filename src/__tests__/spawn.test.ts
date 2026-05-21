/**
 * Tests for `src/spawn.ts` — argv shape, env scrubbing, bearer redaction.
 *
 * We don't actually invoke `claude -p` here (would require a real Anthropic
 * backend + the claude-cli on PATH). Tests assert against the argv we'd
 * pass + the env we'd build.
 */

import { describe, expect, it } from "bun:test";

import { buildChildEnv, buildClaudeArgs, redactBearer } from "../spawn.ts";

describe("buildClaudeArgs", () => {
  it("produces the canonical claude -p invocation shape", () => {
    const args = buildClaudeArgs({
      mcpConfigJson: '{"mcpServers":{}}',
      allowedTools: ["mcp__a", "mcp__b"],
      model: "claude-opus-4-7",
    });
    expect(args).toEqual([
      "claude",
      "-p",
      "--strict-mcp-config",
      "--mcp-config",
      '{"mcpServers":{}}',
      "--allowedTools",
      "mcp__a,mcp__b",
      "--permission-mode",
      "bypassPermissions",
      "--model",
      "claude-opus-4-7",
      "--no-session-persistence",
      "--output-format",
      "text",
    ]);
  });

  it("respects a claudeBin override (for tests + alternate installs)", () => {
    const args = buildClaudeArgs({
      mcpConfigJson: "{}",
      allowedTools: ["x"],
      model: "m",
      claudeBin: "/opt/local/bin/claude",
    });
    expect(args[0]).toBe("/opt/local/bin/claude");
  });
});

describe("redactBearer", () => {
  it("masks 'Bearer <token>' anywhere in any arg", () => {
    const original = ["claude", "--header", "Authorization: Bearer pvt_secret123"];
    const masked = redactBearer(original);
    expect(masked[2]).toBe("Authorization: Bearer <redacted>");
  });

  it("leaves args without bearer tokens unchanged", () => {
    const original = ["claude", "--model", "claude-opus-4-7"];
    expect(redactBearer(original)).toEqual(original);
  });

  it("masks bearer inside JSON arg", () => {
    const json = '{"headers":{"Authorization":"Bearer pvt_xyz"}}';
    const masked = redactBearer([json]);
    expect(masked[0]).toContain("Bearer <redacted>");
    expect(masked[0]).not.toContain("pvt_xyz");
  });
});

describe("buildChildEnv", () => {
  it("only passes through the allowlisted vars", () => {
    const child = buildChildEnv({
      PATH: "/usr/bin",
      HOME: "/Users/x",
      // these MUST NOT leak into the child
      PARACHUTE_VAULT_TOKEN: "pvt_secret",
      RUNNER_MASTER_KEY: "deadbeef",
      AWS_ACCESS_KEY_ID: "AK...",
    });
    expect(child.PATH).toBe("/usr/bin");
    expect(child.HOME).toBe("/Users/x");
    expect(child.PARACHUTE_VAULT_TOKEN).toBeUndefined();
    expect(child.RUNNER_MASTER_KEY).toBeUndefined();
    expect(child.AWS_ACCESS_KEY_ID).toBeUndefined();
  });

  it("passes through ANTHROPIC_API_KEY (claude-cli auth)", () => {
    const child = buildChildEnv({ ANTHROPIC_API_KEY: "sk-..." });
    expect(child.ANTHROPIC_API_KEY).toBe("sk-...");
  });

  it("passes through LC_* locale vars", () => {
    const child = buildChildEnv({ LC_ALL: "en_US.UTF-8", LC_CTYPE: "en_US.UTF-8" });
    expect(child.LC_ALL).toBe("en_US.UTF-8");
    expect(child.LC_CTYPE).toBe("en_US.UTF-8");
  });

  it("provides a sane PATH default if parent has none", () => {
    const child = buildChildEnv({});
    expect(child.PATH).toContain("/usr/bin");
  });

  it("passes USER / LOGNAME / TERM / SHELL through (claude-cli reads these)", () => {
    const child = buildChildEnv({
      USER: "aaron",
      LOGNAME: "aaron",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
    });
    expect(child.USER).toBe("aaron");
    expect(child.LOGNAME).toBe("aaron");
    expect(child.TERM).toBe("xterm-256color");
    expect(child.SHELL).toBe("/bin/zsh");
  });

  it("forwards any CLAUDE_* and ANTHROPIC_* env vars (forward-compat)", () => {
    const child = buildChildEnv({
      CLAUDE_FOO: "bar",
      ANTHROPIC_BETA: "extended-cache-2026",
    });
    expect(child.CLAUDE_FOO).toBe("bar");
    expect(child.ANTHROPIC_BETA).toBe("extended-cache-2026");
  });
});
