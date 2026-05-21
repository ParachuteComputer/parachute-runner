# @openparachute/runner

Vault-as-job-substrate engine — spawns `claude -p` against vault job notes on schedule. The lightweight successor to `parachute-agent` for owner-operated automation.

**Status: Phase 1.0 scaffolding — not yet functional.** The binary stubs `serve` and `once` and exits cleanly so the module wiring (install path, hub-supervisor contract, services.json) can be exercised. Scheduler, vault-query, `claude -p` spawn, and output-writing land in subsequent phases.

## Design

The full design is in [`parachute.computer/design/2026-05-21-parachute-runner-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md). The shape, in one paragraph:

Jobs are vault notes tagged `job`. Their YAML frontmatter declares cron schedule, model, output destination, and allowed tools. Their body is the prompt. Runner polls the vault for `tag:job` notes on a cadence, parses frontmatter into a schedule table, and on each scheduler tick either matures (cron-string fires) or skips. Maturing means: render templates, synthesize inline MCP config via `parachute-vault mcp-config`, spawn `claude -p` with the rendered prompt on stdin, write stdout to a new note in the same vault.

## Phasing

- **Phase 1.0** (this scaffold): module-protocol skeleton, stub bin, library surface.
- **Phase 1.1**: scheduler + `once` mode.
- **Phase 1.2**: vault-query + `claude -p` spawn.
- **Phase 1.3**: output writing + HTTP admin surface.
- **Phase 2+**: see design doc.

## CLI (planned)

```bash
parachute-runner serve              # long-running daemon, internal scheduler
parachute-runner once               # one-shot — enumerate matured jobs, run, exit
parachute-runner once --only <path> # one-shot for a single job
parachute-runner --help             # full flag/env reference
parachute-runner --version
```

## Naming / canonical values

- **Bin:** `parachute-runner`
- **npm:** `@openparachute/runner`
- **Port:** TBD (will claim the next slot in the 1939–1949 band when shipping; design doc proposes `1945`)
- **Mount path:** `/runner`

## License

AGPL-3.0.
