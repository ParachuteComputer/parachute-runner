# @openparachute/runner

Vault-as-job-substrate engine — spawns `claude -p` against vault job notes on schedule. The lightweight successor to `parachute-agent` for owner-operated automation.

**Status: Phase 1.3 — friend-deploy ready.** `parachute-runner once` and `parachute-runner serve` both work against a real vault: parse `tag:job` notes, render templates, spawn `claude -p` per job, write outputs (and failures) back as new vault notes. The HTTP admin surface (`/runner/jobs`, `/runner/runs`, force-run, config GET/PUT, clear-credential) is gated by hub-issued JWTs with `runner:admin` scope. The `vault_token` lives encrypted on disk (AES-256-GCM + master.key). On boot, runner self-registers into `~/.parachute/services.json` so hub-as-supervisor and `parachute status` see it. Installable via `parachute install runner` or the hub admin SPA — friend-deploys (v0.6 single-container, Render) work out of the box.

## Design

The full design is in [`parachute.computer/design/2026-05-21-parachute-runner-design.md`](https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md). The shape, in one paragraph:

Jobs are vault notes tagged `job`. Their YAML frontmatter declares cron schedule, model, output destination, and allowed tools. Their body is the prompt. Runner polls the vault for `tag:job` notes on a cadence, parses frontmatter into a schedule table, and on each scheduler tick either matures (cron-string fires) or skips. Maturing means: render templates, synthesize inline MCP config via `parachute-vault mcp-config`, spawn `claude -p` with the rendered prompt on stdin, write stdout to a new note in the same vault.

## Phasing

- **Phase 1.0** (rc.1): module-protocol skeleton, stub bin, library surface.
- **Phase 1.1** (rc.2): config loading, vault REST client, job parser, template renderer, MCP config synthesizer, `claude -p` spawn with env scrubbing, output writer (success + failure paths), internal cron scheduler, `/healthz`, real `once` + `serve` CLI.
- **Phase 1.2** (rc.3): richer HTTP admin surface (`/runner/jobs`, `/runner/runs`, `/runner/jobs/<id>/run-now`, `.parachute/config[/schema]`, clear-credential), encrypted bearer storage (`secrets.json` + `master.key`), hot-reload of `vault_url` / `vault_token` / `poll_interval` / `disabled` via PUT-config.
- **Phase 1.3** (rc.4 — **this release**): services.json self-registration with `installDir` (so `parachute status` + hub-as-supervisor + admin SPA see runner without an operator step); `.parachute/module.json` polish (`port: 1945` declared); verified `/runner/healthz` mount-path alias alongside canonical `/healthz`; friend-deploy ready against hub-as-supervisor on v0.6 single-container + Render.
- **Phase 2+**: vault tag-schema enforcement for `tag:job`, per-job pause/timeline view beyond the generic config form, `parachute jobs ...` umbrella CLI verb. See design doc.

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

## Install via hub

Once hub is running (`parachute expose hub` or the v0.6 single-container deploy is up), runner installs through the same path as every other module:

```bash
# CLI install — bun add -g + seed services.json + start
parachute install runner

# Or from the hub admin SPA: /admin/modules → "Install" → pick `runner`
# (hub#260 / hub#300 land this flow). The SPA renders the config form
# from /.parachute/config/schema, so vault_url + vault_token can be set
# without touching the CLI.

# Verify the install
parachute status                 # runner appears with port + version + uptime
curl http://127.0.0.1:1945/healthz
```

The first `parachute-runner serve` boot self-registers `runner` into `~/.parachute/services.json` with `installDir` stamped, so `parachute restart runner` and the hub well-known builder resolve to this checkout without a vendored fallback.

## Naming / canonical values

- **Bin:** `parachute-runner`
- **npm:** `@openparachute/runner`
- **Port:** `1945` (claimed slot in the canonical 1939–1949 Parachute range)
- **Mount paths:** `/runner` (admin endpoints), `/.parachute` (module-protocol endpoints)

## License

AGPL-3.0.
