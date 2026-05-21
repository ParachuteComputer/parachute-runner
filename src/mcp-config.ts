/**
 * Build the inline `--mcp-config` JSON consumed by `claude -p`.
 *
 * Shape replicates `parachute-vault`'s `buildMcpConfigJson` (see
 * `parachute-vault/src/mcp-install.ts:377` — the `literal` emission mode).
 *
 * **Library-import vs replicate.** Runner does NOT depend on
 * `@openparachute/vault` at runtime — that would pull in jose, otpauth,
 * MCP SDK, qrcode-terminal for one ~20-line helper. The function is tiny +
 * shape-pinned + covered by `mcp-config.test.ts` (which asserts byte-for-byte
 * agreement with vault's emission). If the shape changes in vault, the test
 * fails loudly; coordinate a runner PR to match.
 *
 * Phase 2 may extract a shared `@openparachute/mcp-config` package if a third
 * caller appears.
 */

export type BuildMcpConfigOpts = {
  vaultName: string;
  /** Base URL (without `/vault/<name>/mcp`). */
  vaultUrl: string;
  /** Verbatim bearer to inline into the JSON. Treat the output as secret. */
  vaultToken: string;
};

/**
 * Emit stable JSON with two-space indent. Match vault's emission convention
 * (also two-space) so diffs comparing the two stay clean.
 */
export function buildMcpConfigJson(opts: BuildMcpConfigOpts): string {
  const { vaultName, vaultUrl, vaultToken } = opts;
  const entryKey = `parachute-vault-${vaultName}`;
  const url = `${vaultUrl.replace(/\/$/, "")}/vault/${vaultName}/mcp`;
  const config = {
    mcpServers: {
      [entryKey]: {
        type: "http",
        url,
        headers: { Authorization: `Bearer ${vaultToken}` },
      },
    },
  };
  return JSON.stringify(config, null, 2);
}
