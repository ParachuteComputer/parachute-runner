/**
 * Minimal HTTP server for `parachute-runner serve`.
 *
 * Phase 1.1 ships only `GET /healthz` — enough for hub-as-supervisor to
 * confirm "this child is alive + scheduling." The richer admin endpoints
 * (`/runner/jobs`, `/runner/runs`, `/runner/jobs/<id>/run-now`) land in
 * Phase 1.2 per the design doc.
 */

import type { Scheduler } from "./scheduler.ts";

export type HealthzOpts = {
  scheduler: Scheduler;
  port: number;
  /** Starting time of the runner process (for uptime calc). */
  startedAt: Date;
  /** Override for tests — defaults to Bun.serve. */
  serveFn?: typeof Bun.serve;
};

/**
 * Spin up a tiny HTTP server. Returns the running Bun.Server so the CLI can
 * `server.stop()` during graceful shutdown.
 */
export function startHealthz(opts: HealthzOpts): ReturnType<typeof Bun.serve> {
  const { scheduler, port, startedAt } = opts;
  const serve = opts.serveFn ?? Bun.serve;
  return serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (
        req.method === "GET" &&
        (url.pathname === "/healthz" || url.pathname === "/runner/healthz")
      ) {
        const body = {
          status: "ok" as const,
          scheduledJobs: scheduler.scheduledJobs,
          lastTickAt: scheduler.lastTickAtIso,
          uptime_seconds: Math.floor((Date.now() - startedAt.getTime()) / 1000),
        };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("Not Found", { status: 404 });
    },
  });
}
