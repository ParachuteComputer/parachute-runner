/**
 * `selfRegister()` — stamp runner's entry into `~/.parachute/services.json`
 * on `parachute-runner serve` boot.
 *
 * Why this exists, in one sentence: hub-as-supervisor (v0.6) reads
 * `~/.parachute/services.json` to know which modules exist on the host; a
 * module that doesn't self-register is invisible to `parachute status`,
 * `parachute restart`, the admin SPA module catalog, and the live
 * `/.well-known/parachute.json` builder.
 *
 * Two reads from the file before we write:
 *   1. The existing row's `port` is preserved on subsequent boots so an
 *      operator (or hub) who set `runner.port = 1948` in services.json
 *      stays at 1948 across restarts — even if the env var that pointed
 *      runner at 1948 is later unset. Same first-boot-vs-subsequent-boot
 *      rule scribe + agent settled (scribe#40, paraclaw#145). When this
 *      is a first run, stamp the resolved port (cli arg or default 1945).
 *   2. The existing row's hub-stamped fields (`installDir` from
 *      parachute-hub#84, future `uiUrl` / `managementUrl`) merge through
 *      because `upsertService` spreads `entry` last. We re-stamp our own
 *      `installDir = PROJECT_ROOT` regardless — hub#293/#302 made the
 *      runtime install path stamp installDir, and we want services.json
 *      to keep that resolution after a `git pull` moves the checkout.
 *
 * Failure mode: any error during the write is logged + swallowed by the
 * caller (see `serve()` in `src/index.ts`). The daemon still serves
 * locally if services.json is unwritable, malformed, or fights with a
 * concurrent writer — the operator just won't see runner in
 * `parachute status` until the underlying issue clears.
 *
 * Hub HTTP self-registration (per vault#266) is NOT what this does — the
 * canonical Parachute pattern is direct filesystem writes to the shared
 * `~/.parachute/services.json` (the agent and scribe pattern). Hub reads
 * the file on demand; it doesn't expose a POST endpoint for registration.
 * If a future hub endpoint changes that, runner's `selfRegister` is the
 * one call site to extend.
 */
import * as path from "node:path";

import pkg from "../package.json" with { type: "json" };
import { type ServiceEntry, readServiceEntry, upsertService } from "./services-manifest.ts";

export type SelfRegisterOpts = {
  /**
   * The port the runner just bound. Used only as the first-run fallback —
   * if services.json already has an entry, we re-stamp the existing port
   * unchanged to preserve operator/hub overrides.
   */
  boundPort: number;
  /**
   * Absolute path to the runner package root (where `.parachute/` and
   * `package.json` live). Stamped as `installDir` so hub can resolve
   * `parachute restart runner` back to this checkout.
   */
  installDir: string;
  /**
   * Override the services.json location (tests). Defaults to
   * `$PARACHUTE_HOME/services.json`.
   */
  manifestPath?: string;
  /** Logger override; default console. */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type SelfRegisterResult = {
  ok: boolean;
  /** The path we wrote to (or attempted to write to). */
  manifestPath: string;
  /** True when services.json already had a row for `runner` before we wrote. */
  hadExistingEntry: boolean;
  /** The port we ended up stamping (existing-entry port or boundPort). */
  portWritten: number;
  /** Set when ok=false — the error swallowed by the caller. */
  error?: Error;
};

/**
 * Self-register runner's services.json entry. Best-effort: returns
 * `{ok: false, error}` on any failure rather than throwing, so the caller's
 * "log + continue" branch is one shape regardless of failure mode.
 *
 * Idempotent against repeated calls — the canonical case is `serve()`
 * invoking this once per boot, but if the daemon restarts in-process (PUT
 * config triggering a reload, etc.) repeated calls converge to the same
 * disk state.
 */
export function selfRegister(opts: SelfRegisterOpts): SelfRegisterResult {
  const logger = opts.logger ?? console;
  const manifestPath = opts.manifestPath; // undefined → resolveManifestPath() default

  let existing: ServiceEntry | undefined;
  try {
    existing = readServiceEntry("runner", manifestPath);
  } catch (e) {
    // Malformed services.json — don't blow up boot. The first write below
    // would also throw; we trade an early bail for a noisy log so the
    // operator sees what's wrong.
    const err = e as Error;
    logger.warn(`[runner] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: false,
      portWritten: opts.boundPort,
      error: err,
    };
  }

  const portToWrite = existing?.port ?? opts.boundPort;
  const entry: ServiceEntry = {
    name: "runner",
    port: portToWrite,
    paths: ["/runner", "/.parachute"],
    health: "/runner/healthz",
    version: pkg.version,
    displayName: "Runner",
    tagline:
      "Vault-as-job-substrate engine — spawns claude -p against vault job notes on schedule.",
    installDir: opts.installDir,
  };

  try {
    upsertService(entry, manifestPath);
  } catch (e) {
    const err = e as Error;
    logger.warn(`[runner] skipped self-register: ${err.message}`);
    return {
      ok: false,
      manifestPath: manifestPath ?? "~/.parachute/services.json",
      hadExistingEntry: existing !== undefined,
      portWritten: portToWrite,
      error: err,
    };
  }

  logger.log(
    `[runner] self-registered services.json entry (port=${portToWrite}, installDir=${opts.installDir}${existing ? ", existing entry merged" : ", first boot"})`,
  );
  return {
    ok: true,
    manifestPath: manifestPath ?? "~/.parachute/services.json",
    hadExistingEntry: existing !== undefined,
    portWritten: portToWrite,
  };
}

/**
 * Resolve the runner package root — the directory containing
 * `.parachute/module.json` + `package.json`. `import.meta.dir` points at
 * `src/`; walk up one level. Matches the resolver in `http-server.ts`'s
 * `defaultParachuteDir()`.
 */
export function resolveProjectRoot(): string {
  return path.resolve(import.meta.dir, "..");
}
