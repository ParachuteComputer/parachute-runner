/**
 * Tests for `src/services-manifest.ts` — the services.json read/write
 * helpers backing self-registration.
 *
 * Coverage:
 *   - resolveManifestPath honors PARACHUTE_HOME, HOME fallback, default
 *   - readServiceEntry returns undefined for missing file + missing name
 *   - upsertService writes services.json with the entry on first call
 *   - upsertService merges hub-stamped fields (installDir from a prior write)
 *     rather than clobbering them
 *   - upsertService is idempotent — writing the same entry twice yields the
 *     same file contents
 *   - upsertService preserves sibling entries (vault, scribe, etc.)
 *   - readServiceEntry throws on malformed JSON (matches scribe behavior —
 *     fail loud, don't silently overwrite)
 *   - upsertService write is atomic (no `.tmp-...` left after success)
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { readServiceEntry, resolveManifestPath, upsertService } from "../services-manifest.ts";

let tmpDir: string;
let manifestPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-services-manifest-"));
  manifestPath = path.join(tmpDir, "services.json");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("resolveManifestPath", () => {
  test("honors PARACHUTE_HOME", () => {
    const p = resolveManifestPath({ PARACHUTE_HOME: "/tmp/parachute-home-override" });
    expect(p).toBe("/tmp/parachute-home-override/services.json");
  });

  test("falls back to $HOME/.parachute when PARACHUTE_HOME unset", () => {
    const p = resolveManifestPath({ HOME: "/Users/test-home" });
    expect(p).toBe("/Users/test-home/.parachute/services.json");
  });

  test("falls back to os.homedir() when both unset", () => {
    const p = resolveManifestPath({});
    expect(p).toBe(path.join(os.homedir(), ".parachute", "services.json"));
  });
});

describe("readServiceEntry", () => {
  test("returns undefined when services.json is missing", () => {
    expect(readServiceEntry("runner", manifestPath)).toBeUndefined();
  });

  test("returns undefined when name not present", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [{ name: "vault", port: 1940, paths: ["/vault"], health: "/h", version: "1" }],
      }),
    );
    expect(readServiceEntry("runner", manifestPath)).toBeUndefined();
  });

  test("returns the matching entry verbatim", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "runner",
            port: 1945,
            paths: ["/runner"],
            health: "/runner/healthz",
            version: "0.1.0-rc.4",
            installDir: "/Users/x/parachute-runner",
          },
        ],
      }),
    );
    const got = readServiceEntry("runner", manifestPath);
    expect(got).toBeDefined();
    expect(got?.port).toBe(1945);
    expect(got?.installDir).toBe("/Users/x/parachute-runner");
  });

  test("throws on malformed JSON — fail loud, don't silently overwrite", () => {
    fs.writeFileSync(manifestPath, "{ not json");
    expect(() => readServiceEntry("runner", manifestPath)).toThrow();
  });

  test("throws when 'services' is missing", () => {
    fs.writeFileSync(manifestPath, JSON.stringify({ foo: "bar" }));
    expect(() => readServiceEntry("runner", manifestPath)).toThrow(/malformed/);
  });
});

describe("upsertService", () => {
  test("creates services.json on first call", () => {
    upsertService(
      {
        name: "runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
        installDir: "/abs/path",
      },
      manifestPath,
    );
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services).toHaveLength(1);
    expect(raw.services[0]?.name).toBe("runner");
    expect(raw.services[0]?.port).toBe(1945);
    expect(raw.services[0]?.installDir).toBe("/abs/path");
  });

  test("merges with an existing entry rather than replacing it", () => {
    // Seed a row that carries a hub-stamped field runner wouldn't author.
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          {
            name: "runner",
            port: 1945,
            paths: ["/runner"],
            health: "/runner/healthz",
            version: "0.1.0-rc.3",
            // Imagine hub had stamped this on a prior install (hub#84).
            hubStampedField: "preserve-me",
          },
        ],
      }),
    );
    upsertService(
      {
        name: "runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
        installDir: "/new/checkout",
      },
      manifestPath,
    );
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<Record<string, unknown>>;
    };
    expect(raw.services).toHaveLength(1);
    expect(raw.services[0]?.version).toBe("0.1.0-rc.4"); // ours wins
    expect(raw.services[0]?.installDir).toBe("/new/checkout"); // ours wins
    expect(raw.services[0]?.hubStampedField).toBe("preserve-me"); // theirs survives
    expect(raw.services[0]?.paths).toEqual(["/runner", "/.parachute"]); // ours wins
  });

  test("is idempotent — same input twice yields the same disk shape", () => {
    const entry = {
      name: "runner",
      port: 1945,
      paths: ["/runner", "/.parachute"],
      health: "/runner/healthz",
      version: "0.1.0-rc.4",
      installDir: "/x",
    };
    upsertService(entry, manifestPath);
    const first = fs.readFileSync(manifestPath, "utf8");
    upsertService(entry, manifestPath);
    const second = fs.readFileSync(manifestPath, "utf8");
    expect(second).toBe(first);
  });

  test("preserves sibling entries (vault, scribe, etc.)", () => {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({
        services: [
          { name: "vault", port: 1940, paths: ["/vault"], health: "/h", version: "1" },
          { name: "scribe", port: 1943, paths: ["/scribe"], health: "/h", version: "1" },
        ],
      }),
    );
    upsertService(
      {
        name: "runner",
        port: 1945,
        paths: ["/runner", "/.parachute"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
        installDir: "/x",
      },
      manifestPath,
    );
    const raw = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      services: Array<{ name: string }>;
    };
    expect(raw.services.map((s) => s.name).sort()).toEqual(["runner", "scribe", "vault"]);
  });

  test("creates parent directory if missing", () => {
    const nested = path.join(tmpDir, "sub", "dir", "services.json");
    upsertService(
      {
        name: "runner",
        port: 1945,
        paths: ["/runner"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
      },
      nested,
    );
    expect(fs.existsSync(nested)).toBe(true);
  });

  test("no .tmp- leftover after a successful write", () => {
    upsertService(
      {
        name: "runner",
        port: 1945,
        paths: ["/runner"],
        health: "/runner/healthz",
        version: "0.1.0-rc.4",
      },
      manifestPath,
    );
    const leftovers = fs.readdirSync(tmpDir).filter((f) => f.startsWith("services.json.tmp-"));
    expect(leftovers).toHaveLength(0);
  });
});
