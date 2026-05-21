/**
 * Tests for `src/scheduler.ts` — schedule diff (add / remove / change), the
 * manual+disabled handling, and concurrency semaphore.
 *
 * We stub out the VaultClient (so the test is fast + deterministic) and the
 * spawn entirely (we never fire claude here — the scheduler's contract is
 * "register a Cron, fire on tick"; tests inspect the in-memory table).
 */

import { afterEach, describe, expect, it } from "bun:test";

import { Scheduler, type SchedulerEvent } from "../scheduler.ts";
import type { CreateNoteBody, VaultClient, VaultNote } from "../vault-client.ts";

function stubClient(notes: VaultNote[]): VaultClient {
  let current = notes;
  return {
    vaultUrl: "http://test",
    vaultName: "default",
    vaultToken: "t",
    apiRoot() {
      return "http://test/vault/default/api";
    },
    async queryJobs() {
      return current;
    },
    async getNote(id: string) {
      return current.find((n) => n.id === id || n.path === id) ?? null;
    },
    async createNote(body: CreateNoteBody): Promise<VaultNote> {
      return { id: "created", ...body };
    },
    // Helper for tests to swap notes between polls
    _setNotes(next: VaultNote[]) {
      current = next;
    },
  } as unknown as VaultClient & { _setNotes: (n: VaultNote[]) => void };
}

const validJobContent = (schedule: string) =>
  `---\nschedule: ${schedule}\nmodel: m\nallowed_tools: [mcp__x]\n---\nbody`;

describe("Scheduler — diff", () => {
  let scheduler: Scheduler | null = null;

  afterEach(async () => {
    if (scheduler) {
      await scheduler.stop(100);
      scheduler = null;
    }
  });

  it("loads new jobs on first poll", async () => {
    const events: SchedulerEvent[] = [];
    const client = stubClient([
      { id: "n1", path: "jobs/a", content: validJobContent("daily") },
      { id: "n2", path: "jobs/b", content: validJobContent("hourly") },
    ]);
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
      onJobRun: (e) => events.push(e),
    });
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(2);
    const loaded = events.filter((e) => e.type === "job-loaded");
    expect(loaded).toHaveLength(2);
  });

  it("registers manual jobs but doesn't auto-fire them", async () => {
    const events: SchedulerEvent[] = [];
    const client = stubClient([
      { id: "n1", path: "jobs/manual", content: validJobContent("manual") },
    ]);
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
      onJobRun: (e) => events.push(e),
    });
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(1);
    const snap = scheduler.snapshot();
    expect(snap[0]!.nextRunAt).toBeNull();
  });

  it("removes jobs that disappear from a subsequent poll", async () => {
    const events: SchedulerEvent[] = [];
    const client = stubClient([
      { id: "n1", path: "jobs/a", content: validJobContent("daily") },
      { id: "n2", path: "jobs/b", content: validJobContent("daily") },
    ]) as VaultClient & { _setNotes: (n: VaultNote[]) => void };
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
      onJobRun: (e) => events.push(e),
    });
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(2);

    client._setNotes([{ id: "n1", path: "jobs/a", content: validJobContent("daily") }]);
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(1);
    const removed = events.filter((e) => e.type === "job-removed");
    expect(removed.map((e) => (e as { jobPath: string }).jobPath)).toEqual(["jobs/b"]);
  });

  it("re-registers a job when its schedule changes", async () => {
    const events: SchedulerEvent[] = [];
    const client = stubClient([
      { id: "n1", path: "jobs/a", content: validJobContent("daily") },
    ]) as VaultClient & { _setNotes: (n: VaultNote[]) => void };
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
      onJobRun: (e) => events.push(e),
    });
    await scheduler.poll();
    client._setNotes([{ id: "n1", path: "jobs/a", content: validJobContent("hourly") }]);
    await scheduler.poll();
    const loaded = events.filter((e) => e.type === "job-loaded");
    expect(loaded).toHaveLength(2); // initial + the rechange
    expect(scheduler.snapshot()[0]!.schedule).toBe("hourly");
  });

  it("captures parse errors per job without aborting the poll", async () => {
    const events: SchedulerEvent[] = [];
    const client = stubClient([
      { id: "n1", path: "jobs/broken", content: "---\nschedule: tomorrow\n---\n" },
      { id: "n2", path: "jobs/ok", content: validJobContent("daily") },
    ]);
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
      onJobRun: (e) => events.push(e),
    });
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(1);
    const errors = events.filter((e) => e.type === "job-parse-error");
    expect(errors).toHaveLength(1);
    expect((errors[0] as { jobPath: string }).jobPath).toBe("jobs/broken");
  });

  it("filters out runner-written output notes (path prefix jobs/runs/)", async () => {
    const client = stubClient([
      { id: "n1", path: "jobs/a", content: validJobContent("daily") },
      { id: "n2", path: "jobs/runs/a/2026-05-21", content: "---\n---\nbody" },
    ]);
    scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
    });
    await scheduler.poll();
    expect(scheduler.scheduledJobs).toBe(1);
  });
});

describe("Scheduler — last-tick timestamp", () => {
  it("updates lastTickAt on every poll", async () => {
    const client = stubClient([]);
    const scheduler = new Scheduler({
      client,
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
    });
    expect(scheduler.lastTickAtIso).toBeNull();
    await scheduler.poll();
    expect(scheduler.lastTickAtIso).not.toBeNull();
    await scheduler.stop(100);
  });
});
