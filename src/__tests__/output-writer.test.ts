/**
 * Tests for `src/output-writer.ts` — success + failure paths produce notes
 * with the expected shape (path, tags, metadata).
 *
 * We mock the vault client (capture createNote calls) so the test is fast
 * and doesn't require a live vault.
 */

import { describe, expect, it } from "bun:test";

import type { Job } from "../job-parser.ts";
import { writeRunOutput } from "../output-writer.ts";
import type { SpawnResult } from "../spawn.ts";
import type { CreateNoteBody, VaultClient, VaultNote } from "../vault-client.ts";

function fakeClient(): {
  client: VaultClient;
  created: CreateNoteBody[];
} {
  const created: CreateNoteBody[] = [];
  const client = {
    vaultUrl: "http://test",
    vaultName: "default",
    vaultToken: "t",
    async createNote(body: CreateNoteBody): Promise<VaultNote> {
      created.push(body);
      return {
        id: `id-${created.length}`,
        path: body.path,
        content: body.content,
        tags: body.tags,
      };
    },
  } as unknown as VaultClient;
  return { client, created };
}

function baseJob(): Job {
  return {
    id: "job-1",
    path: "jobs/daily-tweets",
    name: "daily-tweets",
    schedule: "0 8 * * *",
    cronString: "0 8 * * *",
    model: "claude-opus-4-7",
    outputPath: "jobs/runs/{{job_name}}/{{date}}",
    outputTags: ["job-run", "daily"],
    allowedTools: ["mcp__x"],
    timeoutMs: 600_000,
    disabled: false,
    prompt: "hello",
  };
}

function spawnResult(overrides: Partial<SpawnResult> = {}): SpawnResult {
  return {
    stdout: "draft tweet 1\ndraft tweet 2",
    stderr: "",
    exitCode: 0,
    timedOut: false,
    durationMs: 1234,
    command: ["claude", "-p"],
    ...overrides,
  };
}

describe("writeRunOutput — success", () => {
  it("writes a note at the rendered output path with success metadata", async () => {
    const { client, created } = fakeClient();
    const startedAt = new Date("2026-05-21T12:00:00Z");
    const outcome = await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "jobs/runs/daily-tweets/2026-05-21",
      runId: "rid-1",
      startedAt,
      result: spawnResult(),
    });
    expect(outcome.status).toBe("ok");
    expect(created).toHaveLength(1);
    expect(created[0]!.path).toBe("jobs/runs/daily-tweets/2026-05-21");
    expect(created[0]!.tags).toEqual(["job-run", "daily"]);
    expect(created[0]!.content).toBe("draft tweet 1\ndraft tweet 2");
    expect((created[0]!.metadata as Record<string, unknown>).run_exit_code).toBe(0);
    expect((created[0]!.metadata as Record<string, unknown>).parent_job_id).toBe("job-1");
    expect((created[0]!.metadata as Record<string, unknown>).run_id).toBe("rid-1");
    expect((created[0]!.metadata as Record<string, unknown>).run_duration_ms).toBe(1234);
  });

  it("trims trailing whitespace from stdout", async () => {
    const { client, created } = fakeClient();
    await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "p",
      runId: "rid",
      startedAt: new Date(),
      result: spawnResult({ stdout: "  body  \n\n" }),
    });
    expect(created[0]!.content).toBe("body");
  });
});

describe("writeRunOutput — failure", () => {
  it("non-zero exit produces a job-run-failed note", async () => {
    const { client, created } = fakeClient();
    const outcome = await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "jobs/runs/daily-tweets/2026-05-21",
      runId: "rid-1",
      startedAt: new Date(),
      result: spawnResult({ stdout: "", stderr: "boom", exitCode: 1 }),
    });
    expect(outcome.status).toBe("failed");
    expect(created[0]!.path).toBe("jobs/runs/daily-tweets/2026-05-21.failed");
    expect(created[0]!.tags).toContain("job-run-failed");
    expect(created[0]!.tags).toContain("job-run");
    expect((created[0]!.metadata as Record<string, unknown>).run_error).toContain(
      "exited with code 1",
    );
    expect((created[0]!.metadata as Record<string, unknown>).run_stderr_tail).toContain("boom");
  });

  it("empty stdout is treated as failure even with exit=0", async () => {
    const { client, created } = fakeClient();
    const outcome = await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "p",
      runId: "r",
      startedAt: new Date(),
      result: spawnResult({ stdout: "   \n  ", exitCode: 0 }),
    });
    expect(outcome.status).toBe("failed");
    expect((created[0]!.metadata as Record<string, unknown>).run_error).toContain("empty stdout");
  });

  it("timeout produces exit_code 124 by convention", async () => {
    const { client, created } = fakeClient();
    await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "p",
      runId: "r",
      startedAt: new Date(),
      result: spawnResult({ stdout: "", timedOut: true, exitCode: 0 }),
    });
    expect((created[0]!.metadata as Record<string, unknown>).run_exit_code).toBe(124);
    expect((created[0]!.metadata as Record<string, unknown>).run_error).toContain("timed out");
  });

  it("truncates stderr to STDERR_TAIL_BYTES", async () => {
    const { client, created } = fakeClient();
    const longStderr = "x".repeat(10_000);
    await writeRunOutput({
      client,
      job: baseJob(),
      outputPath: "p",
      runId: "r",
      startedAt: new Date(),
      result: spawnResult({ stdout: "", exitCode: 2, stderr: longStderr }),
    });
    const tail = (created[0]!.metadata as Record<string, unknown>).run_stderr_tail as string;
    expect(tail.length).toBeLessThanOrEqual(2048);
  });
});
