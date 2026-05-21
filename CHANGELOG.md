# Changelog

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
