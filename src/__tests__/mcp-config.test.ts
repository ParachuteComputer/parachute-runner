/**
 * Tests for `src/mcp-config.ts` — shape match against vault's
 * `buildMcpConfigJson` emission (vault#345).
 *
 * This is the load-bearing pin: runner replicates vault's helper rather than
 * importing it (to avoid a fat dep). If vault changes the shape, this test
 * fails loudly — at which point we coordinate a runner PR to match.
 */

import { describe, expect, it } from "bun:test";

import { buildMcpConfigJson } from "../mcp-config.ts";

describe("buildMcpConfigJson", () => {
  it("matches the canonical literal-mode shape from vault#345", () => {
    const json = buildMcpConfigJson({
      vaultName: "gitcoin",
      vaultUrl: "http://127.0.0.1:1940",
      vaultToken: "pvt_test123",
    });
    // Byte-equivalent shape (two-space indent, alpha-natural key order matching
    // vault's emission in src/mcp-install.ts:377+).
    expect(json).toBe(
      `{
  "mcpServers": {
    "parachute-vault-gitcoin": {
      "type": "http",
      "url": "http://127.0.0.1:1940/vault/gitcoin/mcp",
      "headers": {
        "Authorization": "Bearer pvt_test123"
      }
    }
  }
}`,
    );
  });

  it("strips a trailing slash from vaultUrl", () => {
    const json = buildMcpConfigJson({
      vaultName: "default",
      vaultUrl: "http://127.0.0.1:1940/",
      vaultToken: "pvt_xyz",
    });
    expect(json).toContain('"url": "http://127.0.0.1:1940/vault/default/mcp"');
  });

  it("uses the parachute-vault-<name> entry key", () => {
    const json = buildMcpConfigJson({
      vaultName: "personal",
      vaultUrl: "http://127.0.0.1:1940",
      vaultToken: "pvt",
    });
    const cfg = JSON.parse(json);
    expect(Object.keys(cfg.mcpServers)).toEqual(["parachute-vault-personal"]);
  });

  it("inlines the bearer verbatim into the Authorization header", () => {
    const json = buildMcpConfigJson({
      vaultName: "default",
      vaultUrl: "http://127.0.0.1:1940",
      vaultToken: "pvt_secret",
    });
    const cfg = JSON.parse(json);
    expect(cfg.mcpServers["parachute-vault-default"].headers.Authorization).toBe(
      "Bearer pvt_secret",
    );
  });
});
