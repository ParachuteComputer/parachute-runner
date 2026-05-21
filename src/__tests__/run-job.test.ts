/**
 * Tests for `src/run-job.ts` — orchestrates template-render, MCP-config
 * synthesis, spawn, and output-writing.
 *
 * We stub spawnFn and the vault client so the test runs in-process.
 */

import { describe, expect, it } from "bun:test";

import type { Job } from "../job-parser.ts";
import { runJob } from "../run-job.ts";
import type { SpawnResult } from "../spawn.ts";
import type { CreateNoteBody, VaultClient, VaultNote } from "../vault-client.ts";

function fakeClient(): { client: VaultClient; created: CreateNoteBody[] } {
  const created: CreateNoteBody[] = [];
  const client = {
    vaultUrl: "http://test",
    vaultName: "default",
    vaultToken: "pvt_xyz",
    async createNote(body: CreateNoteBody): Promise<VaultNote> {
      created.push(body);
      return { id: `id-${created.length}`, ...body };
    },
  } as unknown as VaultClient;
  return { client, created };
}

function baseJob(): Job {
  return {
    id: "job-1",
    path: "jobs/daily",
    name: "daily",
    schedule: "daily",
    cronString: "0 0 * * *",
    model: "claude-opus-4-7",
    outputPath: "jobs/runs/{{job_name}}/{{date}}",
    outputTags: ["job-run"],
    allowedTools: ["mcp__a"],
    timeoutMs: 600_000,
    disabled: false,
    prompt: "today is {{date}}",
  };
}

describe("runJob — success path", () => {
  it("renders the prompt + path and writes a successful note", async () => {
    const { client, created } = fakeClient();
    let spawnedPrompt = "";
    let spawnedMcp = "";
    const result = await runJob({
      client,
      job: baseJob(),
      date: "2026-05-21",
      runId: "rid-42",
      spawnFn: async (args) => {
        spawnedPrompt = args.prompt;
        spawnedMcp = args.mcpConfigJson;
        return {
          stdout: "draft tweet",
          stderr: "",
          exitCode: 0,
          timedOut: false,
          durationMs: 1000,
          command: ["claude", "-p"],
        } satisfies SpawnResult;
      },
    });
    expect(result.outcome.status).toBe("ok");
    expect(spawnedPrompt).toBe("today is 2026-05-21");
    // MCP config inlines bearer + vault URL
    expect(spawnedMcp).toContain("http://test/vault/default/mcp");
    expect(spawnedMcp).toContain("Bearer pvt_xyz");
    expect(created[0]!.path).toBe("jobs/runs/daily/2026-05-21");
    expect(created[0]!.tags).toContain("job-run");
  });
});

describe("runJob — render failure", () => {
  it("typo in prompt produces a failure note at a safe fallback path", async () => {
    const job = baseJob();
    job.prompt = "today is {{Date}}"; // typo — capital D
    const { client, created } = fakeClient();
    const result = await runJob({
      client,
      job,
      date: "2026-05-21",
      runId: "rid-42",
      spawnFn: async () => {
        throw new Error("spawn should not be called on render failure");
      },
    });
    expect(result.outcome.status).toBe("failed");
    expect(created[0]!.path).toContain("render-error-rid-42");
    expect(created[0]!.tags).toContain("job-run-failed");
    // The TemplateError lands in stderr_tail; run_error reports the synthetic
    // exit reason ("exited with code 2") from the failure-classifier.
    expect((created[0]!.metadata as Record<string, unknown>).run_stderr_tail).toContain("{{Date}}");
  });
});

describe("runJob — spawn failure", () => {
  it("non-zero exit writes a failure note", async () => {
    const { client, created } = fakeClient();
    const result = await runJob({
      client,
      job: baseJob(),
      date: "2026-05-21",
      runId: "rid",
      spawnFn: async () => ({
        stdout: "",
        stderr: "auth failed",
        exitCode: 7,
        timedOut: false,
        durationMs: 500,
        command: ["claude", "-p"],
      }),
    });
    expect(result.outcome.status).toBe("failed");
    expect(created[0]!.path).toBe("jobs/runs/daily/2026-05-21.failed");
    expect((created[0]!.metadata as Record<string, unknown>).run_exit_code).toBe(7);
  });
});
