#!/usr/bin/env bun
/**
 * `parachute-runner` CLI.
 *
 * Two verbs:
 *   - `once`   — enumerate matching jobs, mature them, exit. Driven by
 *                external cron / launchd / manual debug.
 *   - `serve`  — long-running daemon, internal cron scheduler, healthz
 *                HTTP, graceful shutdown on SIGINT/SIGTERM.
 *
 * See `parachute-runner --help` and the design doc for the full picture.
 */

import pkg from "../package.json" with { type: "json" };
import { runOnce, serve } from "../src/index.ts";

const args = process.argv.slice(2);
const command = args[0];

function usage(): void {
  console.log(`parachute-runner — vault-as-job-substrate engine

Usage:
  parachute-runner serve [opts]          Start the scheduler daemon
  parachute-runner once [opts]           Enumerate matured jobs, run, exit
  parachute-runner --help, -h            Show this help
  parachute-runner --version             Print version and exit

\`once\` options:
  --only <path>                          Mature only the job at <path> (including
                                         schedule:manual jobs)
  --date <YYYY-MM-DD>                    Override the {{date}} template variable
  --dry-run                              Enumerate + render, but don't spawn claude

\`serve\` options:
  --port <n>                             Override healthz port (default: 1945)
  --poll-interval <seconds>              Override poll cadence (default: from config)
  --shutdown-timeout <seconds>           Graceful-shutdown deadline (default: 30)

Config:
  \$PARACHUTE_HOME/runner/config.json     Resolved config (see .parachute/config/schema)
  PARACHUTE_HOME=/path                   Override the ecosystem root (default: ~/.parachute)

Design: https://github.com/ParachuteComputer/parachute.computer/blob/main/design/2026-05-21-parachute-runner-design.md
`);
}

/**
 * Tiny argv parser. Recognizes `--flag value` and `--flag=value`. Returns
 * `{flags: Map, positional: string[]}` so the caller can pick out what it
 * cares about without pulling in commander/yargs (extra deps for ~5 flags).
 */
function parseArgs(input: string[]): {
  flags: Map<string, string>;
  positional: string[];
  booleans: Set<string>;
} {
  const flags = new Map<string, string>();
  const booleans = new Set<string>();
  const positional: string[] = [];
  for (let i = 0; i < input.length; i++) {
    const a = input[i]!;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const next = input[i + 1];
        if (next === undefined || next.startsWith("--")) {
          booleans.add(a.slice(2));
        } else {
          flags.set(a.slice(2), next);
          i++;
        }
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, booleans };
}

async function main(): Promise<void> {
  switch (command) {
    case "--version":
    case "-v":
      console.log(pkg.version);
      return;

    case "help":
    case "--help":
    case "-h":
    case undefined:
      usage();
      return;

    case "once": {
      const parsed = parseArgs(args.slice(1));
      try {
        const result = await runOnce({
          only: parsed.flags.get("only"),
          date: parsed.flags.get("date"),
          dryRun: parsed.booleans.has("dry-run"),
        });
        console.log(
          `[runner] done: total=${result.total} ok=${result.succeeded} failed=${result.failed} skipped=${result.skipped}`,
        );
        if (result.failed > 0) process.exit(1);
        return;
      } catch (e) {
        console.error(`[runner] fatal: ${(e as Error).message}`);
        process.exit(2);
      }
      return;
    }

    case "serve": {
      const parsed = parseArgs(args.slice(1));
      const portStr = parsed.flags.get("port");
      const pollStr = parsed.flags.get("poll-interval");
      const shutdownStr = parsed.flags.get("shutdown-timeout");
      const opts = {
        port: portStr ? Number(portStr) : undefined,
        pollIntervalSeconds: pollStr ? Number(pollStr) : undefined,
        shutdownTimeoutMs: shutdownStr ? Number(shutdownStr) * 1000 : undefined,
      };
      let handle: Awaited<ReturnType<typeof serve>>;
      try {
        handle = await serve(opts);
      } catch (e) {
        console.error(`[runner] fatal: ${(e as Error).message}`);
        process.exit(2);
        return;
      }
      let stopping = false;
      const shutdown = async (signal: string) => {
        if (stopping) return;
        stopping = true;
        console.log(`[runner] received ${signal}`);
        await handle.stop();
        process.exit(0);
      };
      process.on("SIGINT", () => {
        void shutdown("SIGINT");
      });
      process.on("SIGTERM", () => {
        void shutdown("SIGTERM");
      });
      // Keep the process alive — Bun.serve + the scheduler's interval do
      // this on their own; this empty await just makes the intent obvious.
      await new Promise(() => {});
      return;
    }

    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run `parachute-runner --help` for usage.");
      process.exit(1);
  }
}

void main();
