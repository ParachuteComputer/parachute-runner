# Changelog

## [0.1.0-rc.1] - 2026-05-21

Initial scaffold per [design doc](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md).

Module-protocol-compliant skeleton with a stub `parachute-runner` binary that prints usage and exits cleanly. No scheduler, no vault-query, no `claude -p` spawn, no output-writing — those land in Phase 1.1 onward.

### Added

- `package.json` declaring `@openparachute/runner` at `0.1.0-rc.1`, bin → `bin/parachute-runner.ts`.
- `bin/parachute-runner.ts` — argv parser supporting `--help`/`-h`, `--version`, and stub `serve` / `once` subcommands that print "not yet implemented (Phase 1.1)" and exit 0.
- `src/index.ts` — library entry exposing `runOnce()` and `serve()` stubs (both throw) and the package version.
- `.parachute/module.json` — canonical module-protocol shape (name `runner`, kind `service`, scopes `runner:read` / `runner:admin`).
- `.parachute/info` — module discovery JSON.
- `.parachute/config/schema` — Draft-07 JSON Schema for the config (`vault_url`, `vault_token` (writeOnly), `poll_interval_seconds`, `max_concurrent_jobs`, `disabled`).
- `src/__tests__/scaffold.test.ts` — minimal test that asserts the library version export matches `package.json`.
- biome.json, tsconfig.json, .gitignore, README.md, LICENSE (AGPL-3.0).
