/**
 * Bearer-token auth for runner's HTTP admin endpoints.
 *
 * Two paths reach the runner:
 *   - **Hub-issued JWT** (`eyJ…`) — verified against the hub's JWKS at
 *     `<origin>/.well-known/jwks.json`. The trust kernel (issuer pin,
 *     audience strict-check, scope parsing, revocation cache) lives in
 *     `@openparachute/scope-guard`; this file is the runner-side adapter.
 *   - **Loopback hub admin SPA proxy** — hub#300 mints a fresh
 *     `runner:admin`-scoped JWT per request when an operator opens the
 *     module-config form. That bearer reaches runner as a hub-issued JWT
 *     and goes through the same path.
 *
 * The `runner:admin` scope gates `/runner/jobs`, `/runner/runs`,
 * `/runner/jobs/<id>/run-now`, and every `/.parachute/config*` endpoint per
 * the canonical "<service>:admin gates /.parachute/config*" rule. `/healthz`
 * stays unauthenticated (matches scribe's pattern + the design doc table).
 *
 * Hub-origin resolution honors `PARACHUTE_HUB_ORIGIN` with a loopback
 * fallback — same shape as scribe, vault, parachute-agent.
 */

import { HubJwtError, type ScopeGuard, createScopeGuard } from "@openparachute/scope-guard";

export const SCOPE_ADMIN = "runner:admin" as const;
export const SCOPE_READ = "runner:read" as const;

/** Hub loopback for v0.6 single-container; deploys override via env. */
const DEFAULT_HUB_LOOPBACK = "http://127.0.0.1:1939";

/** Audience the runner declares — hub#300 mints with `aud: "runner"`. */
export const AUDIENCE = "runner" as const;

export function getHubOrigin(): string {
  const env = process.env.PARACHUTE_HUB_ORIGIN?.replace(/\/$/, "");
  if (env && env.length > 0) return env;
  return DEFAULT_HUB_LOOPBACK;
}

let guard: ScopeGuard | null = null;

/**
 * Lazy process-wide guard. The resolver form lets tests flip
 * `PARACHUTE_HUB_ORIGIN` between cases without restarting the harness; the
 * lib re-resolves on every `validateHubJwt` call. JWKS + revocation caches
 * live inside the guard and survive across requests in production.
 */
function getGuard(): ScopeGuard {
  if (!guard) {
    guard = createScopeGuard({ hubOrigin: () => getHubOrigin() });
  }
  return guard;
}

/**
 * Test seam: forget the cached guard so a beforeEach that swaps the
 * `PARACHUTE_HUB_ORIGIN` env var picks up the new origin on the next call.
 */
export function resetGuard(): void {
  if (guard) {
    guard.resetJwksCache();
    guard.resetRevocationCache();
  }
  guard = null;
}

export function extractBearer(authHeader: string | null | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = authHeader.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() || undefined;
}

export type AuthResult =
  | { ok: true; scopes: readonly string[] }
  | { ok: false; status: 401 | 403; body: { error: string; message: string } };

/**
 * Validate the presented bearer against the hub. Returns the granted scope
 * list on success; on failure returns a typed 401 or 403 the caller forwards
 * verbatim.
 *
 * `aud === "runner"` enforced via `expectedAudience` — a token minted for a
 * different module can't reach our admin surface even if it carries
 * `runner:admin` (which it can't, but defense-in-depth).
 */
export async function validateBearer(token: string | undefined): Promise<AuthResult> {
  if (!token) {
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", message: "Authorization: Bearer <token> required" },
    };
  }
  try {
    const claims = await getGuard().validateHubJwt(token, { expectedAudience: AUDIENCE });
    return { ok: true, scopes: claims.scopes };
  } catch (err) {
    if (err instanceof HubJwtError && err.code === "revoked") {
      console.warn(`[runner-auth] hub JWT rejected: ${err.message}`);
      return {
        ok: false,
        status: 401,
        body: { error: "unauthorized", message: "token has been revoked" },
      };
    }
    if (err instanceof HubJwtError && err.code === "revocation_unavailable") {
      console.warn(`[runner-auth] hub JWT rejected: ${err.message}`);
      return {
        ok: false,
        status: 401,
        body: {
          error: "unauthorized",
          message: "token cannot be validated: revocation list unavailable",
        },
      };
    }
    const message =
      err instanceof HubJwtError
        ? err.message
        : err instanceof Error
          ? err.message
          : "JWT validation failed";
    return {
      ok: false,
      status: 401,
      body: { error: "unauthorized", message },
    };
  }
}

/** Exact-match scope check. Non-vault scopes don't inherit per oauth-scopes.md. */
export function hasScope(granted: readonly string[], required: string): boolean {
  return granted.includes(required);
}

/**
 * Resolve auth + scope. Returns either a Response to forward (401/403) or
 * the granted scopes for the caller to use in finer-grained checks.
 *
 * `requiredScope` is the route's scope. Pass null for routes that need a
 * valid bearer but no specific scope (we don't currently have any; reserved
 * for future shape changes).
 */
export async function enforceAdmin(
  req: Request,
  requiredScope: string,
): Promise<Response | { scopes: readonly string[] }> {
  const token = extractBearer(req.headers.get("authorization"));
  const result = await validateBearer(token);
  if (!result.ok) {
    return Response.json(result.body, { status: result.status });
  }
  if (!hasScope(result.scopes, requiredScope)) {
    return Response.json(
      {
        error: "Forbidden",
        error_type: "insufficient_scope",
        message: `This endpoint requires the '${requiredScope}' scope.`,
        required_scope: requiredScope,
        granted_scopes: result.scopes,
      },
      { status: 403 },
    );
  }
  return { scopes: result.scopes };
}
