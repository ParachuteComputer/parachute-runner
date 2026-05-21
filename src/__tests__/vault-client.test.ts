/**
 * Tests for `src/vault-client.ts` — wire-shape against a fake vault.
 *
 * We stand up a `Bun.serve` instance that records each request and replies
 * with canned data, then drive VaultClient against it. This way we verify
 * the actual URLs + headers + bodies the client puts on the wire rather
 * than mocking the fetch surface.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { VaultClient, VaultClientError } from "../vault-client.ts";

type RecordedRequest = {
  method: string;
  path: string;
  query: Record<string, string>;
  authorization: string | null;
  body: string;
};

let server: ReturnType<typeof Bun.serve>;
const recorded: RecordedRequest[] = [];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const body = req.method === "GET" ? "" : await req.text();
      recorded.push({
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        authorization: req.headers.get("authorization"),
        body,
      });

      // GET /vault/test/api/notes?tag=job — return two job notes
      if (req.method === "GET" && url.pathname === "/vault/test/api/notes") {
        return Response.json([
          { id: "n1", path: "jobs/a", content: "---\nschedule: daily\n---\nbody" },
          { id: "n2", path: "jobs/b", content: "---\nschedule: hourly\n---\nbody" },
        ]);
      }
      // GET /vault/test/api/notes/<id>
      if (req.method === "GET" && url.pathname.startsWith("/vault/test/api/notes/")) {
        const id = decodeURIComponent(url.pathname.slice("/vault/test/api/notes/".length));
        if (id === "missing") return new Response("Not Found", { status: 404 });
        return Response.json({ id, path: `jobs/${id}`, content: "body" });
      }
      // POST /vault/test/api/notes
      if (req.method === "POST" && url.pathname === "/vault/test/api/notes") {
        const parsed = JSON.parse(body);
        return Response.json({ id: "created-1", ...parsed }, { status: 201 });
      }
      return new Response("not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop();
});

function client() {
  return new VaultClient({
    vaultUrl: `http://127.0.0.1:${server.port}`,
    vaultName: "test",
    vaultToken: "pvt_xyz",
  });
}

describe("VaultClient.queryJobs", () => {
  it("hits GET /vault/<name>/api/notes?tag=job&limit=...&include_content=true", async () => {
    recorded.length = 0;
    const notes = await client().queryJobs();
    expect(notes).toHaveLength(2);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.method).toBe("GET");
    expect(recorded[0]!.path).toBe("/vault/test/api/notes");
    expect(recorded[0]!.query.tag).toBe("job");
    expect(recorded[0]!.query.include_content).toBe("true");
    expect(recorded[0]!.authorization).toBe("Bearer pvt_xyz");
  });
});

describe("VaultClient.getNote", () => {
  it("returns the note on 2xx", async () => {
    recorded.length = 0;
    const note = await client().getNote("hello");
    expect(note?.id).toBe("hello");
    expect(recorded[0]!.path).toBe("/vault/test/api/notes/hello");
  });

  it("returns null on 404 (not a thrown error)", async () => {
    const note = await client().getNote("missing");
    expect(note).toBeNull();
  });
});

describe("VaultClient.createNote", () => {
  it("POSTs the single-note shape (not the batch wrapper)", async () => {
    recorded.length = 0;
    const note = await client().createNote({
      path: "jobs/runs/x/2026-05-21",
      content: "hello",
      tags: ["job-run"],
      metadata: { run_exit_code: 0 },
    });
    expect(note.id).toBe("created-1");
    const rec = recorded[0]!;
    expect(rec.method).toBe("POST");
    expect(rec.path).toBe("/vault/test/api/notes");
    expect(rec.authorization).toBe("Bearer pvt_xyz");
    const parsed = JSON.parse(rec.body);
    expect(parsed.path).toBe("jobs/runs/x/2026-05-21");
    expect(parsed.tags).toEqual(["job-run"]);
    expect(parsed.metadata.run_exit_code).toBe(0);
  });
});

describe("VaultClient — error handling", () => {
  it("wraps a non-2xx as VaultClientError", async () => {
    // Force a 404 on POST by sending to a wrong path
    const c = new VaultClient({
      vaultUrl: `http://127.0.0.1:${server.port}`,
      vaultName: "nonexistent",
      vaultToken: "t",
    });
    await expect(c.createNote({ path: "x", content: "x" })).rejects.toThrow(VaultClientError);
  });
});
