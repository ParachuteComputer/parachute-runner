#!/usr/bin/env bun

import pkg from "../package.json" with { type: "json" };

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`parachute-runner — vault-as-job-substrate engine

Phase 1.0 scaffolding — \`serve\` and \`once\` are stubs that exit 0.
Real behavior lands in Phase 1.1+.

Usage:
  parachute-runner serve                 Start the scheduler daemon (Phase 1.1+)
  parachute-runner once [opts]           Enumerate matured jobs, run them, exit (Phase 1.1+)
  parachute-runner --help, -h            Show this help
  parachute-runner --version             Print version and exit

\`once\` options (Phase 1.1+):
  --only <path>                          Mature only the job at <path>
  --date <YYYY-MM-DD>                    Override the date template variable
  --dry-run                              Enumerate + render, but don't spawn claude

Config (Phase 1.2+):
  ~/.parachute/runner/config.json        Resolved config (see .parachute/config/schema)
  PARACHUTE_HOME=/path                   Override the ecosystem root

Design: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md
`);
}

function notImplemented(verb: string): void {
  console.log(`parachute-runner ${verb}: not yet implemented (Phase 1.1)`);
}

switch (command) {
  case "--version":
  case "-v":
    console.log(pkg.version);
    break;

  case "serve":
    notImplemented("serve");
    break;

  case "once":
    notImplemented("once");
    break;

  case "help":
  case "--help":
  case "-h":
  case undefined:
    usage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    console.error("Run `parachute-runner --help` for usage.");
    process.exit(1);
}
