# @openparachute/runner

Vault-as-job-substrate engine — spawns `claude -p` against vault job notes on schedule. The lightweight successor to `parachute-agent` for owner-operated automation.

**Status: Phase 1.1 — functional MVP.** `parachute-runner once` and `parachute-runner serve` both work against a real vault: parse `tag:job` notes, render templates, spawn `claude -p` per job, write outputs (and failures) back as new vault notes. Module-protocol scaffolding (info, config schema, services.json contract), encrypted bearer storage, and the richer HTTP admin surface (`/runner/jobs`, `/runner/runs`, force-run) land in Phase 1.2+.

## Design

The full design is in [`parachute.computer/design/2026-05-21-parachute-runner-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md). The shape, in one paragraph:

Jobs are vault notes tagged `job`. Their YAML frontmatter declares cron schedule, model, output destination, and allowed tools. Their body is the prompt. Runner polls the vault for `tag:job` notes on a cadence, parses frontmatter into a schedule table, and on each scheduler tick either matures (cron-string fires) or skips. Maturing means: render templates, synthesize inline MCP config via `parachute-vault mcp-config`, spawn `claude -p` with the rendered prompt on stdin, write stdout to a new note in the same vault.

## Phasing

- **Phase 1.0** (rc.1): module-protocol skeleton, stub bin, library surface.
- **Phase 1.1** (rc.2 — **this release**): config loading, vault REST client, job parser, template renderer, MCP config synthesizer, `claude -p` spawn with env scrubbing, output writer (success + failure paths), internal cron scheduler, `/healthz`, real `once` + `serve` CLI.
- **Phase 1.2** (next): richer HTTP admin surface (`/runner/jobs`, `/runner/runs`, `/runner/jobs/<id>/run-now`), encrypted bearer storage (`secrets.db` + `master.key`).
- **Phase 1.3+**: per-job force-run from UI, run-history saved-query helper. See design doc.

## CLI

```bash
parachute-runner serve              # long-running daemon, internal scheduler
  --port <n>                        #   override healthz port (default 1945)
  --poll-interval <seconds>         #   override poll cadence
  --shutdown-timeout <seconds>      #   graceful-shutdown deadline (default 30)

parachute-runner once               # one-shot — enumerate matured jobs, run, exit
  --only <path>                     #   target a single job (includes schedule:manual)
  --date <YYYY-MM-DD>               #   override the {{date}} template
  --dry-run                         #   enumerate + render, but don't spawn claude

parachute-runner --help             # full flag/env reference
parachute-runner --version
```

## Job note schema

```yaml
---
schedule: "0 8 * * *"                            # cron or daily/hourly/weekly/manual
model: claude-opus-4-7
allowed_tools:
  - mcp__parachute-vault-default__query-notes
output_path: "jobs/runs/{{job_name}}/{{date}}"   # optional template
output_tags: [job-run]                           # optional — job-run is always added
timeout: 10m                                     # optional — default 600s
disabled: false                                  # optional
---

Today is **{{date}}**. ... prompt body ...
```

Failure notes (non-zero exit, empty stdout, timeout, template error) land at `<output_path>.failed` with `job-run-failed` tag and `run_error` / `run_stderr_tail` in frontmatter.

## Naming / canonical values

- **Bin:** `parachute-runner`
- **npm:** `@openparachute/runner`
- **Port:** TBD (will claim the next slot in the 1939–1949 band when shipping; design doc proposes `1945`)
- **Mount path:** `/runner`

## License

AGPL-3.0.
