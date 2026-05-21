/**
 * Internal cron scheduler for `parachute-runner serve`.
 *
 * Polls the vault for `tag:job` notes every `pollIntervalSeconds`, diffs
 * against the in-memory table, and registers a `croner.Cron` per job. Jobs
 * with `schedule: manual` are loaded but never auto-fire. Disabled jobs are
 * pruned from the cron table but tracked in metrics.
 *
 * Concurrency: a semaphore caps simultaneous claude -p spawns at
 * `maxConcurrentJobs`. A scheduled job whose tick fires while the semaphore
 * is full waits at the semaphore (rather than skipping) — short fan-outs
 * are common; permanently-overloaded operators will see queue depth grow
 * and can bump the cap.
 */

import { Cron } from "croner";

import { InvalidJobError, parseJob } from "./job-parser.ts";
import { runJob } from "./run-job.ts";
import type { VaultClient, VaultNote } from "./vault-client.ts";

export type SchedulerOpts = {
  client: VaultClient;
  pollIntervalSeconds: number;
  maxConcurrentJobs: number;
  /** Global pause — daemon stays running but no jobs fire. */
  disabled?: boolean;
  /** Hook for tests to observe maturation outcomes. */
  onJobRun?: (event: SchedulerEvent) => void;
  /** Logger override (default: console.log/error). */
  logger?: Pick<Console, "log" | "warn" | "error">;
};

export type SchedulerEvent =
  | { type: "tick"; at: Date; scheduledJobs: number }
  | { type: "job-loaded"; jobPath: string; schedule: string }
  | { type: "job-removed"; jobPath: string }
  | { type: "job-parse-error"; jobPath: string; reasons: string[] }
  | { type: "job-fired"; jobPath: string; status: "ok" | "failed" }
  | { type: "job-error"; jobPath: string; error: string };

type Scheduled = {
  jobPath: string;
  schedule: string;
  cron: Cron | null;
};

/**
 * Long-running scheduler. Constructed once per `serve` invocation; call
 * `start()` to begin polling + scheduling, `stop()` to gracefully drain.
 */
export class Scheduler {
  readonly opts: SchedulerOpts;
  private scheduled = new Map<string, Scheduled>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private inFlight = 0;
  private waitQueue: Array<() => void> = [];
  private lastTickAt: Date | null = null;
  private stopped = false;
  /** Promise chain tracking every in-flight job; `stop()` awaits these. */
  private liveRuns = new Set<Promise<void>>();

  constructor(opts: SchedulerOpts) {
    this.opts = opts;
  }

  get scheduledJobs(): number {
    return this.scheduled.size;
  }

  get lastTickAtIso(): string | null {
    return this.lastTickAt?.toISOString() ?? null;
  }

  /**
   * Poll immediately (synchronous start), then on the configured interval.
   * Returns a promise that resolves once the initial poll completes — handy
   * for `serve` to log "scheduler started with N jobs" before listening.
   */
  async start(): Promise<void> {
    await this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.opts.pollIntervalSeconds * 1000);
    // Don't keep the event loop alive solely for the poll timer — the
    // scheduler's purpose is to fire jobs and serve HTTP, both of which
    // hold the loop themselves.
    if (
      typeof (this.pollTimer as ReturnType<typeof setInterval> & { unref?: () => void }).unref ===
      "function"
    ) {
      (this.pollTimer as ReturnType<typeof setInterval> & { unref: () => void }).unref();
    }
  }

  /**
   * Graceful shutdown: cancel every Cron, wait for in-flight runs up to
   * `shutdownTimeoutMs`, then resolve. The CLI escalates to process exit
   * after this returns.
   */
  async stop(shutdownTimeoutMs = 30_000): Promise<void> {
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    for (const s of this.scheduled.values()) s.cron?.stop();
    this.scheduled.clear();

    if (this.liveRuns.size === 0) return;
    const deadline = Date.now() + shutdownTimeoutMs;
    while (this.liveRuns.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.all([...this.liveRuns]).catch(() => {}),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    }
  }

  /**
   * One poll cycle: query vault, parse jobs, diff against the scheduled
   * table. Exposed publicly so tests (and the `once` mode) can drive a
   * single poll without the timer.
   */
  async poll(): Promise<void> {
    this.lastTickAt = new Date();
    let notes: VaultNote[];
    try {
      notes = await this.opts.client.queryJobs();
    } catch (e) {
      this.logger().error(`[scheduler] poll failed: ${(e as Error).message}`);
      return;
    }
    // Filter out runner-written output notes that may also carry `job` tag
    // somewhere — the convention is jobs live outside `jobs/runs/`.
    notes = notes.filter((n) => !(n.path ?? "").startsWith("jobs/runs/"));

    const seen = new Set<string>();
    for (const note of notes) {
      if (!note.path) continue;
      seen.add(note.path);
      let job: ReturnType<typeof parseJob>;
      try {
        job = parseJob(note);
      } catch (e) {
        if (e instanceof InvalidJobError) {
          this.emit({ type: "job-parse-error", jobPath: note.path, reasons: e.reasons });
        }
        continue;
      }
      const existing = this.scheduled.get(job.path);
      if (existing && existing.schedule === job.schedule) {
        // No change — leave the existing Cron in place.
        continue;
      }
      // New job OR schedule changed: cancel any prior Cron + (re)register.
      existing?.cron?.stop();
      this.scheduled.delete(job.path);

      if (job.disabled || job.cronString === null) {
        // disabled + manual jobs are tracked but don't auto-fire.
        this.scheduled.set(job.path, { jobPath: job.path, schedule: job.schedule, cron: null });
      } else {
        const cron = new Cron(job.cronString, { paused: false }, () => {
          if (this.stopped || this.opts.disabled) return;
          void this.maturate(note);
        });
        this.scheduled.set(job.path, { jobPath: job.path, schedule: job.schedule, cron });
      }
      this.emit({ type: "job-loaded", jobPath: job.path, schedule: job.schedule });
    }

    // Prune jobs that the vault no longer returns.
    for (const [path, entry] of this.scheduled) {
      if (!seen.has(path)) {
        entry.cron?.stop();
        this.scheduled.delete(path);
        this.emit({ type: "job-removed", jobPath: path });
      }
    }

    this.emit({ type: "tick", at: this.lastTickAt, scheduledJobs: this.scheduled.size });
  }

  /**
   * Run a single job, respecting the semaphore. Each spawn-and-write is
   * registered in `liveRuns` so `stop()` can wait for them.
   */
  private async maturate(note: VaultNote): Promise<void> {
    if (this.stopped) return;
    await this.acquireSlot();
    const run = this.execute(note).finally(() => {
      this.releaseSlot();
    });
    this.liveRuns.add(run);
    run.finally(() => this.liveRuns.delete(run)).catch(() => {});
  }

  private async execute(note: VaultNote): Promise<void> {
    let job: ReturnType<typeof parseJob>;
    try {
      job = parseJob(note);
    } catch (e) {
      this.emit({
        type: "job-error",
        jobPath: note.path ?? "<unknown>",
        error: (e as Error).message,
      });
      return;
    }
    try {
      // Re-fetch the note body in case it changed since the poll — this
      // matches the Gitcoin Brain prototype's hot-edit semantics.
      const fresh = (await this.opts.client.getNote(note.id)) ?? note;
      const reparsed = parseJob(fresh);
      const result = await runJob({ client: this.opts.client, job: reparsed });
      this.emit({ type: "job-fired", jobPath: job.path, status: result.outcome.status });
    } catch (e) {
      this.emit({ type: "job-error", jobPath: job.path, error: (e as Error).message });
    }
  }

  private acquireSlot(): Promise<void> {
    if (this.inFlight < this.opts.maxConcurrentJobs) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waitQueue.push(() => {
        this.inFlight++;
        resolve();
      });
    });
  }

  private releaseSlot(): void {
    this.inFlight--;
    const next = this.waitQueue.shift();
    if (next) next();
  }

  /**
   * Force-run a job by path (used by `once --only <path>` and the
   * `/runner/jobs/<id>/run-now` Phase 1.2 endpoint). Returns the
   * RunJobResult or throws on parse failure.
   */
  async forceRun(jobPath: string): Promise<void> {
    const fresh = await this.opts.client.getNote(jobPath);
    if (!fresh) throw new Error(`no job at ${jobPath}`);
    const job = parseJob(fresh);
    await this.acquireSlot();
    try {
      const result = await runJob({ client: this.opts.client, job });
      this.emit({ type: "job-fired", jobPath: job.path, status: result.outcome.status });
    } finally {
      this.releaseSlot();
    }
  }

  /** Return a snapshot of the scheduled jobs — used by /healthz + /jobs. */
  snapshot(): Array<{ jobPath: string; schedule: string; nextRunAt: string | null }> {
    return [...this.scheduled.values()].map((s) => ({
      jobPath: s.jobPath,
      schedule: s.schedule,
      nextRunAt: s.cron?.nextRun()?.toISOString() ?? null,
    }));
  }

  private emit(event: SchedulerEvent): void {
    this.opts.onJobRun?.(event);
  }

  private logger(): Pick<Console, "log" | "warn" | "error"> {
    return this.opts.logger ?? console;
  }
}
