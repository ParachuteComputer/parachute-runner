# Changelog

## [0.1.0-rc.7] - 2026-05-23

### Removed

- Dropped `kind` field from the `/.parachute/info` runtime endpoint response. Companion to runner#7's module.json drop. Closes part of hub#340.

## [0.1.0-rc.6] - 2026-05-23

- Dropped `kind` field from `.parachute/module.json`. Per hub#301 Phase B. No behavior change.

## [0.1.0-rc.5] - 2026-05-22

fix(runner): self-register uses `manifestName` as services.json row key
(matches hub install path; mirrors app fix).

Hub installs modules under `manifest.manifestName` (`"parachute-runner"`),
but the boot-time self-registration was writing under the short name
`"runner"`. The two writes left services.json with two rows on the
same port, which trips hub's duplicate-port detector on re-read.

The row key is now sourced from `.parachute/module.json#manifestName`,
so the install path and the runtime path converge to one row. Mirrors
the fix landed in parachute-app for the same shape of bug.

## [0.1.0-rc.4] - 2026-05-21

feat(runner): Phase 1.3 — self-registration + module-protocol polish + health alias.

This is the last Phase 1 piece — runner is friend-deploy ready. On `parachute-runner serve` boot, runner now self-registers into `~/.parachute/services.json` with its `installDir` stamped, matching the canonical agent/scribe pattern (paraclaw#117 / scribe#40). Hub's `parachute status`, `parachute restart runner`, and the live `/.well-known/parachute.json` builder all see the runner without an operator step. The `port` field — required by hub's strict `.parachute/module.json` parser — is now declared (1945, claiming the next slot in the canonical 1939–1949 range). The `/runner/healthz` alias is verified alongside canonical `/healthz` so hub-as-supervisor's health probes resolve either form.

### Added

- `src/services-manifest.ts` — `upsertService` + `readServiceEntry` over `~/.parachute/services.json` (path resolution honors `PARACHUTE_HOME`). Atomic write via `<path>.tmp-<pid>-<now>` rename. Merges with any existing row rather than replacing it so hub-stamped fields (`installDir` from hub#84, future `uiUrl` pass-throughs) survive a self-registration pass.
- `src/self-register.ts` — `selfRegister({ boundPort, installDir, manifestPath?, logger? })` returns `{ ok, hadExistingEntry, portWritten, error? }`. Best-effort: malformed services.json + unwritable target both yield `{ok: false}` + warn log rather than throwing, so the daemon still serves locally when the manifest write fails. First boot stamps the resolved port; subsequent boots preserve the existing port (operator-override discipline — scribe#40 / paraclaw#145 shape). `resolveProjectRoot()` returns the runner package root (where `.parachute/` and `package.json` live) for the `installDir` stamp.
- `src/index.ts` — `serve()` invokes `selfRegister()` after the HTTP server is up. `once` mode is unchanged — registration is daemon-only (CLI scripts don't claim a port).
- `src/__tests__/services-manifest.test.ts` — 14 tests over `resolveManifestPath` (env precedence), `readServiceEntry` (missing file / missing name / malformed JSON), `upsertService` (first-write / merge / idempotent / sibling-preserve / atomic / nested dir create).
- `src/__tests__/self-register.test.ts` — 9 tests over first-boot stamping, port-preservation across restarts, hub-stamped field merge, idempotency, sibling preservation, malformed-services.json + unwritable-target best-effort failure paths, and `resolveProjectRoot` pointing at a directory containing `.parachute/module.json`.

### Fixed

- `.parachute/module.json` — added the required `port: 1945` field (hub's strict module-manifest parser rejected the prior shape; rc.3's vendored `RUNNER_FALLBACK` in hub masked this gap). Once hub's `RUNNER_FALLBACK` retires, this is the canonical manifest hub reads.

### Verified

- `bun test src/` — 158 pass / 0 fail / 346 expect() calls (rc.3: 135 / 281).
- `bun run typecheck` — clean.
- `bunx biome check .` — clean.
- Live smoke against `PARACHUTE_HOME=$(mktemp -d)` sandbox: runner serve binds, `/healthz` + `/runner/healthz` + `/.parachute/info` + `/.parachute/config/schema` all return 200; `/.parachute/config` returns 401 unauthenticated; self-register log emitted; services.json written with correct `port` + `paths` + `health` + `installDir`. Second boot with pre-existing services.json `port: 18999` preserved the operator port and stamped fresh `installDir` + `version`.

## [0.1.0-rc.3] - 2026-05-21

feat(runner): Phase 1.2 — HTTP admin endpoints + encrypted bearer storage.

The runner's HTTP surface grows into the full set the design doc names: jobs / runs / run-now admin endpoints, the `.parachute/config[/schema]` module-protocol endpoints (consumable by hub#300's admin SPA), and a clear-credential admin action. Every non-`/healthz` route is gated by a hub-issued JWT carrying `runner:admin` scope. The `vault_token` migrates off plaintext disk into an AES-256-GCM envelope keyed off `master.key` — same shape parachute-agent established for credentials at rest. PUT-config hot-reloads the live scheduler in-process (poll cadence, kill switch, vault client) so the design doc's "changes take effect immediately, no process restart" actually holds.

### Added

- `src/secrets.ts` — `SecretsStore` over `master.key` (0o600, 32 random bytes, auto-generated on first boot) + `secrets.json` envelope. AES-256-GCM with 12-byte random IV per write (fresh nonce per encryption; identical plaintext produces different ciphertext). Versioned envelope shape so future migrations don't strand existing operators. Plaintext `vault_token` in legacy `config.json` is auto-migrated to the envelope on first boot and stripped from the file (idempotent — re-runs after a partial crash converge to the same end state).
- `src/auth.ts` — hub-issued JWT verification via `@openparachute/scope-guard@^0.3.0`. Process-wide guard, lazy-instantiated. Audience pinned to `"runner"` (matches hub#300's mint shape); `runner:admin` scope required on every non-`/healthz` route. Revocation-list integration inherited from scope-guard. Hub origin resolved via `PARACHUTE_HUB_ORIGIN` env with loopback fallback at `http://127.0.0.1:1939`.
- `src/http-server.ts` — replaces `healthz.ts`. Hosts: `GET /healthz`, `GET /runner/jobs`, `GET /runner/runs`, `POST /runner/jobs/<path>/run-now`, `GET/PUT /.parachute/config`, `GET /.parachute/config/schema`, `GET /.parachute/info`, `POST /.parachute/clear-credential/vault-token`. Loopback-only by default; runner reaches operators through hub's reverse proxy on the same localhost.
- `src/config.ts` lift — `loadConfig` merges the encrypted `vault_token` from the envelope before validation; `applyConfigPatch` is the read-modify-write entry point the PUT handler uses; `validatePutBody` accepts partial updates (missing fields = "leave unchanged"); `toPublicConfig` drops the writeOnly bearer for GET responses.
- `Scheduler` lift — `forceRun` now returns `{runId, status, outputPath}` so the HTTP endpoint can surface where the result note will land. `snapshot()` includes `lastRunAt`, `lastRunStatus`, `lastRunId`, `disabled`. `setPollIntervalSeconds`, `setDisabled`, and `replaceClient` are the hot-reload entry points the PUT handler calls.
- `VaultClient.queryRuns()` — `tag:job-run` query for the runs endpoint; vault stays the source of truth per design doc decision 5.
- `src/__tests__/secrets.test.ts` — 20 tests covering AES-GCM round-trip, IV freshness, file modes (0o600 on master.key + secrets.json + config.json), envelope tamper-detection, version-mismatch rejection, master-key corruption, plaintext migration (happy path + idempotency + file mode).
- `src/__tests__/http-server.test.ts` — 33 tests over a Bun.serve fake hub (JWKS + revocation-list) + fake vault. Covers every route's 200 happy path, 401/403 by various failure modes (missing bearer, bad signature, wrong issuer, wrong audience, wrong scope), 404 unknown job, 400 bad input, writeOnly omission on GET-config, partial PUT preserves unchanged values, hot-reload of poll_interval / disabled / vault_token / vault_url, clear-credential clears the secret + halts the scheduler, PUT-written vault_token never lands in config.json on disk.

### Changed

- `module.json#paths` adds `/.parachute` so hub's reverse proxy forwards the module-protocol endpoints (hub#300's admin SPA consumes these).
- `module.json#stripPrefix: false` so the runner sees the full path (e.g. `/runner/jobs`) as before — explicit on-entry for clarity.

### Verified

- `bun test src/` — 132 pass / 0 fail / 281 expect() calls.
- `bun run typecheck` — clean.
- `bunx biome check .` — clean (formatter + linter).

## [0.1.0-rc.2] - 2026-05-21

feat(runner): Phase 1.1 — `once` + `serve` against real vault.

The runner now does its job: reads tag:`job` notes from a vault, parses frontmatter, renders `{{date}}` / `{{job_name}}` / `{{run_id}}` templates, synthesizes an inline `--mcp-config` JSON, spawns `claude -p` per job (subprocess env scrubbed per the trust-gradient-isolation pattern), and writes outputs back as new notes. Failures get tagged `job-run-failed` so vault saved-queries can surface them. Both `parachute-runner once` (one-shot) and `parachute-runner serve` (long-running daemon with internal cron scheduler + `/healthz`) modes ship.

### Added

- `src/config.ts` — load + validate `$PARACHUTE_HOME/runner/config.json` against the schema. Fails fast on missing `vault_url` / `vault_token`.
- `src/vault-client.ts` — thin REST client (`queryJobs`, `getNote`, `createNote`) against `GET/POST /vault/<name>/api/notes`.
- `src/job-parser.ts` — frontmatter (via `gray-matter`) → typed `Job`. Validates `schedule` / `model` / `allowed_tools` are present; collects every problem into one `InvalidJobError` so operators see the full picture.
- `src/template.ts` — `{{date}}` / `{{job_name}}` / `{{run_id}}` substitution; **unknown variables are fail-fast** (typos surface loudly instead of silently writing to a broken path).
- `src/mcp-config.ts` — replicates vault's `buildMcpConfigJson` (literal-mode) for inline `--mcp-config '<json>'`. Byte-equivalent pinned by test against vault#345's emission.
- `src/spawn.ts` — `Bun.spawn` claude -p with env scrubbed to the allowlist `[PATH, HOME, USER, LOGNAME, SHELL, TERM, LANG, TZ, ANTHROPIC_*, CLAUDE_*, XDG_*, LC_*]`. Hard timeout per job (SIGTERM → SIGKILL after 5s). Bearer redaction in the echoed argv.
- `src/output-writer.ts` — writes successful runs at the rendered `output_path` with `tags + metadata`; failures (non-zero exit, empty stdout, timeout, render error) land at `<output_path>.failed` tagged `job-run + job-run-failed` with `run_error` / `run_stderr_tail` in frontmatter.
- `src/run-job.ts` — orchestrator: render → build MCP config → spawn → write. Render-time failures produce a fallback-path failure note so the operator always finds the error in vault.
- `src/scheduler.ts` — `croner`-backed cron table; polls vault every `poll_interval_seconds`, diffs against the in-memory table (add / remove / schedule-change), respects `max_concurrent_jobs` via a semaphore, drains in-flight runs on graceful stop.
- `src/healthz.ts` — `Bun.serve` minimal HTTP. `GET /healthz` (and `/runner/healthz`) returns `{status, scheduledJobs, lastTickAt, uptime_seconds}`.
- `bin/parachute-runner.ts` — real `once [--only <path>] [--date <YYYY-MM-DD>] [--dry-run]` and `serve [--port N] [--poll-interval N] [--shutdown-timeout N]` verbs, with SIGINT/SIGTERM → graceful shutdown.
- `src/__tests__/` — 11 test files, 82 tests covering config validation, frontmatter parsing, template substitution + fail-fast, mcp-config byte-equivalence with vault#345, vault REST wire shape (against `Bun.serve` fake), spawn argv + env scrubbing, output writer success+failure paths, scheduler diff + manual/disabled handling, healthz HTTP, end-to-end `runOnce`, and CLI help/version/error handling.

### Dependencies

- `croner` ^10 — small zero-dep cron scheduler.
- `gray-matter` ^4 — battle-tested YAML frontmatter parser.

### Smoked

End-to-end against Aaron's running vault at `http://127.0.0.1:1940`:

- Created `tests/runner-smoke-rc2` job tagged `job`, schedule `manual`.
- `parachute-runner once --only tests/runner-smoke-rc2` spawned `claude -p` (duration 2.4s).
- claude returned `"smoke test passed at 2026-05-21."`.
- Output note landed at `tests/runner-smoke-rc2-output/2026-05-21` with tags `[job-run, smoke-test]` and full metadata (`parent_job_id`, `run_started_at`, `run_duration_ms`, `run_exit_code: 0`, `run_id`, `model`).
- Test artifacts deleted; smoke token revoked.
