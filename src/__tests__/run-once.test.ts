/**
 * End-to-end integration: `runOnce` against a fake vault + a fake config
 * file. Verifies the full path — config load → query jobs → parse → render
 * → spawn (stubbed) → write output.
 *
 * The claude -p subprocess is replaced via `runOnce`'s ServeOptions chain
 * by overriding the global Bun.spawn would be intrusive — instead we wire
 * runOnce to use a real VaultClient against a Bun.serve fake, so claude
 * never actually runs because we configure jobs as dry-run.
 *
 * For the actual spawn integration we cover that in run-job.test.ts where
 * we inject spawnFn directly.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runOnce } from "../index.ts";

type RecordedRequest = { method: string; path: string };

let server: ReturnType<typeof Bun.serve>;
let configPath: string;
const recorded: RecordedRequest[] = [];
let createdNotes: Array<Record<string, unknown>> = [];

beforeAll(() => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-runonce-"));
  const runnerHome = path.join(tmpDir, "runner");
  fs.mkdirSync(runnerHome, { recursive: true });
  configPath = path.join(runnerHome, "config.json");

  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      recorded.push({ method: req.method, path: url.pathname });
      if (req.method === "GET" && url.pathname === "/vault/default/api/notes") {
        return Response.json([
          {
            id: "j1",
            path: "jobs/manual-test",
            content:
              "---\nschedule: manual\nmodel: claude-opus-4-7\nallowed_tools: [mcp__x]\n---\nhello {{date}}",
          },
          {
            id: "j2",
            path: "jobs/daily-test",
            content:
              "---\nschedule: daily\nmodel: claude-opus-4-7\nallowed_tools: [mcp__x]\n---\nhello",
          },
        ]);
      }
      // VaultClient.getNote percent-encodes the path; Bun.serve's URL leaves
      // pathname percent-encoded so the literal we match here is the encoded
      // form (jobs%2Fmanual-test) — using `decodeURIComponent` to canonicalize.
      const notePrefix = "/vault/default/api/notes/";
      if (req.method === "GET" && url.pathname.startsWith(notePrefix)) {
        const idOrPath = decodeURIComponent(url.pathname.slice(notePrefix.length));
        if (idOrPath === "jobs/manual-test") {
          return Response.json({
            id: "j1",
            path: "jobs/manual-test",
            content:
              "---\nschedule: manual\nmodel: claude-opus-4-7\nallowed_tools: [mcp__x]\n---\nhello {{date}}",
          });
        }
        return new Response("Not Found", { status: 404 });
      }
      if (req.method === "POST" && url.pathname === "/vault/default/api/notes") {
        const body = (await req.json()) as Record<string, unknown>;
        createdNotes.push(body);
        return Response.json({ id: `created-${createdNotes.length}`, ...body }, { status: 201 });
      }
      return new Response("nf", { status: 404 });
    },
  });

  fs.writeFileSync(
    configPath,
    JSON.stringify({
      vault_url: `http://127.0.0.1:${server.port}`,
      vault_name: "default",
      vault_token: "pvt_test",
    }),
  );
});

afterAll(() => {
  server.stop();
});

describe("runOnce — dry-run", () => {
  it("enumerates jobs but doesn't write outputs", async () => {
    recorded.length = 0;
    createdNotes = [];
    const silent = { log() {}, warn() {}, error() {} } as Pick<Console, "log" | "warn" | "error">;
    const result = await runOnce({ configPath, dryRun: true, logger: silent });
    // Manual job is skipped; daily is dry-run-skipped → total=2, skipped=2.
    expect(result.total).toBe(2);
    expect(result.skipped).toBe(2);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    // No POST should have happened — only the initial GET notes query.
    expect(createdNotes).toHaveLength(0);
    expect(recorded.some((r) => r.method === "POST")).toBe(false);
  });
});

describe("runOnce — --only with schedule:manual", () => {
  it("runs a manual job when explicitly targeted in dry-run", async () => {
    recorded.length = 0;
    createdNotes = [];
    const silent = { log() {}, warn() {}, error() {} } as Pick<Console, "log" | "warn" | "error">;
    const result = await runOnce({
      configPath,
      only: "jobs/manual-test",
      dryRun: true,
      logger: silent,
    });
    expect(result.total).toBe(1);
    // dry-run path skips
    expect(result.skipped).toBe(1);
  });
});
