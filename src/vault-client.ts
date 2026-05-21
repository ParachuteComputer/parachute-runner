/**
 * Thin REST client for the vault HTTP surface.
 *
 * Phase 1.1 needs three operations:
 *   - queryJobs   → GET /vault/<name>/api/notes?tag=job
 *   - getNote     → GET /vault/<name>/api/notes/<id-or-path>
 *   - createNote  → POST /vault/<name>/api/notes
 *
 * Auth is a single bearer token (`Authorization: Bearer <vault_token>`). The
 * client stays small + dependency-free — `fetch` is global in Bun.
 *
 * REST shapes match the canonical routes in
 * `parachute-vault/src/routes.ts:427+` (verified 2026-05-21).
 */

export type VaultClientOptions = {
  vaultUrl: string;
  vaultName: string;
  vaultToken: string;
  /** Override fetch (tests use Bun.serve + this to avoid global network). */
  fetchFn?: typeof fetch;
};

export type VaultNote = {
  id: string;
  path?: string;
  content?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export type CreateNoteBody = {
  path: string;
  content: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
};

/**
 * Wrap a non-2xx vault response with the response body for easier triage.
 * Vault returns structured JSON on errors (`{error: "...", message: "..."}`),
 * so we attempt to surface that.
 */
export class VaultClientError extends Error {
  override name = "VaultClientError" as const;
  readonly status: number;
  readonly body: string;
  constructor(operation: string, status: number, body: string) {
    super(`vault ${operation} failed: ${status} ${body.slice(0, 500)}`);
    this.status = status;
    this.body = body;
  }
}

export class VaultClient {
  readonly vaultUrl: string;
  readonly vaultName: string;
  readonly vaultToken: string;
  readonly fetchFn: typeof fetch;

  constructor(opts: VaultClientOptions) {
    this.vaultUrl = opts.vaultUrl.replace(/\/$/, "");
    this.vaultName = opts.vaultName;
    this.vaultToken = opts.vaultToken;
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  /** Build `<vault_url>/vault/<name>/api`. Reused by every endpoint. */
  apiRoot(): string {
    return `${this.vaultUrl}/vault/${encodeURIComponent(this.vaultName)}/api`;
  }

  /** Standard headers — bearer + JSON content type. Token never logged. */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.vaultToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  /**
   * Query notes by tag. Filters server-side via `?tag=job&limit=<n>`. The
   * response shape is the array of note records (vault returns an array
   * directly on the structured-query endpoint per `routes.ts:564`+).
   */
  async queryJobs(opts: { limit?: number } = {}): Promise<VaultNote[]> {
    const url = new URL(`${this.apiRoot()}/notes`);
    url.searchParams.set("tag", "job");
    url.searchParams.set("limit", String(opts.limit ?? 500));
    // Request content so the parser doesn't have to round-trip a second
    // GET per job. Vault honors `include_content=true` on structured queries.
    url.searchParams.set("include_content", "true");

    const res = await this.fetchFn(url.toString(), {
      method: "GET",
      headers: this.headers(),
    });
    if (!res.ok) {
      throw new VaultClientError("queryJobs", res.status, await res.text());
    }
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) return data as VaultNote[];
    // Some routes wrap results in `{notes: [...]}` — accommodate both shapes.
    if (data && typeof data === "object" && Array.isArray((data as { notes?: unknown }).notes)) {
      return (data as { notes: VaultNote[] }).notes;
    }
    throw new VaultClientError(
      "queryJobs",
      res.status,
      `unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  /**
   * Query recent runs (notes tagged `job-run`). Phase 1.2's /runner/runs
   * endpoint surfaces this. Vault is the source of truth for run history
   * per design doc decision 5 — we avoid a parallel SQLite of runs.
   */
  async queryRuns(opts: { limit?: number } = {}): Promise<VaultNote[]> {
    const url = new URL(`${this.apiRoot()}/notes`);
    url.searchParams.set("tag", "job-run");
    url.searchParams.set("limit", String(opts.limit ?? 100));
    url.searchParams.set("include_content", "false");
    const res = await this.fetchFn(url.toString(), { method: "GET", headers: this.headers() });
    if (!res.ok) {
      throw new VaultClientError("queryRuns", res.status, await res.text());
    }
    const data = (await res.json()) as unknown;
    if (Array.isArray(data)) return data as VaultNote[];
    if (data && typeof data === "object" && Array.isArray((data as { notes?: unknown }).notes)) {
      return (data as { notes: VaultNote[] }).notes;
    }
    throw new VaultClientError(
      "queryRuns",
      res.status,
      `unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  /**
   * Fetch a single note by ID or path. Returns null on 404 to make the
   * "job moved/deleted between poll and run" path cheap to handle.
   */
  async getNote(idOrPath: string): Promise<VaultNote | null> {
    const url = `${this.apiRoot()}/notes/${encodeURIComponent(idOrPath)}`;
    const res = await this.fetchFn(url, { method: "GET", headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new VaultClientError("getNote", res.status, await res.text());
    }
    return (await res.json()) as VaultNote;
  }

  /**
   * Create a new note at `body.path` with content + tags + metadata. Uses
   * POST /api/notes (the single-note path, not the batch-via-`notes: [...]`
   * shape — runner writes one output per job).
   */
  async createNote(body: CreateNoteBody): Promise<VaultNote> {
    const url = `${this.apiRoot()}/notes`;
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new VaultClientError("createNote", res.status, await res.text());
    }
    return (await res.json()) as VaultNote;
  }
}
