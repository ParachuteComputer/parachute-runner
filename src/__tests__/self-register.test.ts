/**
 * Tests for `src/self-register.ts` — services.json self-registration on
 * `parachute-runner serve` boot.
 *
 * Coverage:
 *   - First boot: stamps the resolved port + installDir + version
 *   - Subsequent boot: preserves the existing port (operator-override
 *     discipline — paraclaw#145 / scribe#40 shape)
 *   - Hub-stamped fields on a prior row survive the merge
 *   - Best-effort: malformed services.json yields {ok:false} + logs, doesn't
 *     throw
 *   - Best-effort: unwritable target yields {ok:false} + logs, doesn't throw
 *   - resolveProjectRoot returns a directory containing .parachute/module.json
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveProjectRoot, selfRegister } from "../self-register.ts";

interface CapturedLogger {
  log: (msg: string) => void;
  warn: (msg: string) => void;
  error: (msg: string) => void;
  warnings: string[];
  logs: string[];
  errors: string[];
}

function makeLogger(): CapturedLogger {
  const logs: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  return {
    log: (msg: string) => logs.push(msg),
    warn: (msg: string) => warnings.push(msg),
    error: (msg: string) => errors.push(msg),
    logs,
    warnings,
    errors,
  };
}

let tmpDir: string;
let manifestPath: string;
let logger: CapturedLogger;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-self-register-"));
  manifestPath = path.join(tmpDir, "services.json");
  logger = makeLogger();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("selfRegister — first boot", () => {
  test("writes a fresh services.json with our entry", () => {
    const result = selfRegister({
      boundPort: 1945,
      installDir: "/Users/x/parachute-runner",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(false);
    expect(result.portWritten).toBe(1945);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services).toHaveLength(1);
    const entry = raw.services[0]!;
    // Row key is the manifestName from .parachute/module.json — hub looks
    // modules up by manifestName, so registering under the short "runner"
    // here would race the hub-installed `parachute-runner` row and trip
    // the duplicate-port detector.
    expect(entry.name).toBe("parachute-runner");
    expect(entry.port).toBe(1945);
    expect(entry.paths).toEqual(["/runner", "/.parachute"]);
    expect(entry.health).toBe("/runner/healthz");
    expect(entry.installDir).toBe("/Users/x/parachute-runner");
    expect(entry.displayName).toBe("Runner");
    expect(typeof entry.version).toBe("string");
  });

  test("logs a single info-level line on success", () => {
    selfRegister({
      boundPort: 1945,
      installDir: "/abs",
      manifestPath,
      logger,
    });
    expect(logger.logs).toHaveLength(1);
    expect(logger.logs[0]).toContain("self-registered");
    expect(logger.warnings).toHaveLength(0);
  });

  test("regression: row key matches the manifestName hub installs under (no duplicate `runner` row)", () => {
    // Hub's install path writes the services.json row under
    // manifest.manifestName ("parachute-runner"). If self-register writes
    // under the short name "runner", the file ends up with two rows on
    // the same port — hub's re-read flags it as a duplicate-port
    // collision. This test pins the row key to manifestName so the two
    // paths converge to one row.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-runner", // hub-installed row
            port: 1945,
            paths: ["/runner"],
            health: "/runner/healthz",
            version: "hub-stamped",
          },
        ],
      }),
    );
    selfRegister({
      boundPort: 1945,
      installDir: "/post-install/checkout",
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string; port: number }>;
    };
    expect(raw.services).toHaveLength(1); // not 2
    expect(raw.services[0]?.name).toBe("parachute-runner");
    expect(raw.services.find((s) => s.name === "runner")).toBeUndefined();
  });
});

describe("selfRegister — subsequent boot (existing entry)", () => {
  test("preserves an operator-set port from services.json", () => {
    // Seed with a port the operator chose by hand.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-runner",
            port: 1948, // operator override, not the default
            paths: ["/runner", "/.parachute"],
            health: "/runner/healthz",
            version: "0.1.0-rc.3",
            installDir: "/old/checkout",
          },
        ],
      }),
    );
    const result = selfRegister({
      boundPort: 1945,
      installDir: "/new/checkout",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(true);
    expect(result.hadExistingEntry).toBe(true);
    // The result.portWritten should be the operator-override port, NOT
    // boundPort — that's the load-bearing invariant for restart-stability.
    expect(result.portWritten).toBe(1948);

    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services[0]?.port).toBe(1948);
    expect(raw.services[0]?.installDir).toBe("/new/checkout"); // we re-stamp this
  });

  test("hub-stamped fields on prior row survive the merge", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "parachute-runner",
            port: 1945,
            paths: ["/runner"],
            health: "/runner/healthz",
            version: "0.1.0-rc.3",
            // Hub-stamped fields a future hub.installDir-side enhancement
            // might add (matches the agent / scribe merge invariant).
            hubStampedField: "preserve-me",
            uiUrl: "/runner/admin",
          },
        ],
      }),
    );
    selfRegister({
      boundPort: 1945,
      installDir: "/new/checkout",
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services[0]?.hubStampedField).toBe("preserve-me");
    expect(raw.services[0]?.uiUrl).toBe("/runner/admin");
    expect(raw.services[0]?.installDir).toBe("/new/checkout");
  });

  test("idempotent — calling twice doesn't drift the file", () => {
    const opts = {
      boundPort: 1945,
      installDir: "/x",
      manifestPath,
      logger,
    };
    selfRegister(opts);
    const first = fs.readFileSync(manifestPath, "utf8");
    selfRegister(opts);
    const second = fs.readFileSync(manifestPath, "utf8");
    expect(second).toBe(first);
  });

  test("preserves sibling entries", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          { name: "vault", port: 1940, paths: ["/vault"], health: "/h", version: "1" },
          { name: "scribe", port: 1943, paths: ["/scribe"], health: "/h", version: "1" },
        ],
      }),
    );
    selfRegister({
      boundPort: 1945,
      installDir: "/x",
      manifestPath,
      logger,
    });
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(raw.services.map((s) => s.name).sort()).toEqual(["parachute-runner", "scribe", "vault"]);
  });
});

describe("selfRegister — best-effort failure modes", () => {
  test("malformed services.json yields {ok:false} + warn log, doesn't throw", () => {
    fs.writeFileSync(manifestPath, "{not json");
    const result = selfRegister({
      boundPort: 1945,
      installDir: "/x",
      manifestPath,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
    expect(logger.warnings[0]).toContain("skipped self-register");
  });

  test("unwritable manifest path yields {ok:false} + warn log, doesn't throw", () => {
    // Point at a path under a file (not a dir) — mkdir will fail.
    const blocker = path.join(tmpDir, "im-a-file-not-a-dir");
    fs.writeFileSync(blocker, "");
    const unwritable = path.join(blocker, "services.json");
    const result = selfRegister({
      boundPort: 1945,
      installDir: "/x",
      manifestPath: unwritable,
      logger,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    expect(logger.warnings.length).toBeGreaterThan(0);
  });
});

describe("resolveProjectRoot", () => {
  test("points at a directory containing .parachute/module.json", () => {
    const root = resolveProjectRoot();
    const manifestFile = path.join(root, ".parachute", "module.json");
    expect(fs.existsSync(manifestFile)).toBe(true);
    const m = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as { name: string };
    expect(m.name).toBe("runner");
  });
});
