/**
 * Tests for `src/healthz.ts` — small HTTP server returns 200 + JSON.
 */

import { afterEach, describe, expect, it } from "bun:test";

import { startHealthz } from "../healthz.ts";
import { Scheduler } from "../scheduler.ts";
import type { VaultClient } from "../vault-client.ts";

function noClient(): VaultClient {
  return {
    vaultUrl: "http://test",
    vaultName: "default",
    vaultToken: "t",
    async queryJobs() {
      return [];
    },
  } as unknown as VaultClient;
}

describe("startHealthz", () => {
  let server: ReturnType<typeof startHealthz> | null = null;

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it("GET /healthz returns ok JSON with scheduler stats", async () => {
    const scheduler = new Scheduler({
      client: noClient(),
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
    });
    await scheduler.poll();
    server = startHealthz({ scheduler, port: 0, startedAt: new Date(Date.now() - 5_000) });
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      status: string;
      scheduledJobs: number;
      lastTickAt: string | null;
      uptime_seconds: number;
    };
    expect(body.status).toBe("ok");
    expect(body.scheduledJobs).toBe(0);
    expect(body.lastTickAt).not.toBeNull();
    expect(body.uptime_seconds).toBeGreaterThanOrEqual(4);
    await scheduler.stop(100);
  });

  it("GET /runner/healthz also resolves (hub-supervisor mount path)", async () => {
    const scheduler = new Scheduler({
      client: noClient(),
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
    });
    server = startHealthz({ scheduler, port: 0, startedAt: new Date() });
    const res = await fetch(`http://127.0.0.1:${server.port}/runner/healthz`);
    expect(res.status).toBe(200);
    await scheduler.stop(100);
  });

  it("other paths return 404", async () => {
    const scheduler = new Scheduler({
      client: noClient(),
      pollIntervalSeconds: 9999,
      maxConcurrentJobs: 4,
    });
    server = startHealthz({ scheduler, port: 0, startedAt: new Date() });
    const res = await fetch(`http://127.0.0.1:${server.port}/somewhere`);
    expect(res.status).toBe(404);
    await scheduler.stop(100);
  });
});
