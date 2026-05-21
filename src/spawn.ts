/**
 * Spawn `claude -p` against a rendered job prompt.
 *
 * Per design doc decision 8 ("subprocess environment scrubbing") + the
 * trust-gradient-isolation pattern: the child gets a **minimal env** — only
 * the vars claude-cli needs to authenticate and find binaries. The runner's
 * bearer, the master key, and unrelated process env never enter the child.
 *
 * Args shape (per design doc decision 8 and the Gitcoin Brain prototype):
 *
 *   claude -p
 *     --strict-mcp-config
 *     --mcp-config '<inline json>'
 *     --allowedTools '<comma-joined>'
 *     --permission-mode bypassPermissions
 *     --model <job.model>
 *     --no-session-persistence
 *     --output-format text
 *
 * Stdin = the rendered prompt body. Stdout = the output that becomes the note.
 */

export type SpawnArgs = {
  /** Rendered prompt — written to the child's stdin and closed. */
  prompt: string;
  /** Inline MCP config JSON (from buildMcpConfigJson). */
  mcpConfigJson: string;
  /** Comma-joined tool list passed to claude -p --allowedTools. */
  allowedTools: string[];
  /** Model id (claude-opus-4-7, etc.). */
  model: string;
  /** Hard kill after this many ms. Default 600_000 (10min). */
  timeoutMs?: number;
  /** Override the claude binary lookup. Default: just `claude` on PATH. */
  claudeBin?: string;
  /**
   * Inject a fake `Bun.spawn` for tests. Real callers omit. Returns the
   * same shape as `Bun.spawn` so we don't have to wrap.
   */
  spawnFn?: typeof Bun.spawn;
};

export type SpawnResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  /** True when the runner killed the process for exceeding `timeoutMs`. */
  timedOut: boolean;
  durationMs: number;
  /** The argv the child was spawned with (with the bearer redacted). */
  command: string[];
};

/**
 * Build the argv for claude -p. Exposed for testing — assertions in
 * spawn.test.ts compare the literal argv shape against a fixture so
 * accidental flag reorders surface loudly.
 */
export function buildClaudeArgs(opts: {
  mcpConfigJson: string;
  allowedTools: string[];
  model: string;
  claudeBin?: string;
}): string[] {
  const bin = opts.claudeBin ?? "claude";
  const args = [
    bin,
    "-p",
    "--strict-mcp-config",
    "--mcp-config",
    opts.mcpConfigJson,
    "--allowedTools",
    opts.allowedTools.join(","),
    "--permission-mode",
    "bypassPermissions",
    "--model",
    opts.model,
    "--no-session-persistence",
    "--output-format",
    "text",
  ];
  return args;
}

/**
 * Redact bearer tokens from an argv list before logging. Looks for any arg
 * containing "Bearer " and replaces the trailing token with `<redacted>`.
 */
export function redactBearer(args: string[]): string[] {
  return args.map((a) => a.replace(/Bearer [^"\s]+/g, "Bearer <redacted>"));
}

/**
 * Scrub the env passed to the child. The runner's own env carries the
 * vault token + master-key path; nothing claude needs. Keep only:
 *   - PATH                  (so claude can find subprocesses)
 *   - HOME                  (claude-cli stores credentials there)
 *   - ANTHROPIC_API_KEY     (the canonical claude-cli auth env var)
 *   - CLAUDE_CONFIG_DIR     (claude-cli config override; preserve if set)
 *   - LANG / LC_*           (locale for stdio encoding)
 *   - TZ                    (so timestamps in stdout match operator expectation)
 */
export function buildChildEnv(
  parentEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  // Vars claude-cli legitimately needs (or might need on at least one platform):
  //  - PATH / HOME       — fundamentals
  //  - USER / LOGNAME    — some claude flows read these
  //  - SHELL / TERM      — claude tool shell, when enabled
  //  - LANG / TZ         — locale/timezone for stdio + timestamps
  //  - ANTHROPIC_API_KEY — explicit API auth, if set
  //  - CLAUDE_*          — claude-cli's own config overrides
  //  - XDG_*             — Linux config/data discovery for claude-cli
  const passthrough = [
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "LANG",
    "TZ",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CONFIG_DIR",
    "CLAUDE_API_KEY",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_RUNTIME_DIR",
  ];
  for (const k of passthrough) {
    const v = parentEnv[k];
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  // Pass through any LC_* locale vars (LC_ALL, LC_CTYPE, …) and any
  // ANTHROPIC_* / CLAUDE_* not already covered (forward-compat for new
  // claude-cli env vars without a code change).
  for (const [k, v] of Object.entries(parentEnv)) {
    if (typeof v !== "string" || v.length === 0) continue;
    if (k.startsWith("LC_") || k.startsWith("ANTHROPIC_") || k.startsWith("CLAUDE_")) {
      out[k] = v;
    }
  }
  // Provide a sane PATH default if the parent had none — most desktop shells
  // do, but launchd-spawned children sometimes don't inherit a useful one.
  if (!out.PATH) out.PATH = "/usr/local/bin:/usr/bin:/bin";
  return out;
}

/**
 * Spawn claude -p, write the prompt to its stdin, and collect stdout/stderr.
 *
 * Timeout handling: after `timeoutMs` we SIGTERM, then if the process is
 * still alive 5s later we SIGKILL. `timedOut` distinguishes a runner-killed
 * run from a claude-exited-nonzero run in the output writer's metadata.
 */
export async function spawnClaude(args: SpawnArgs): Promise<SpawnResult> {
  const argv = buildClaudeArgs(args);
  const spawnFn = args.spawnFn ?? Bun.spawn;
  const timeoutMs = args.timeoutMs ?? 600_000;
  const started = Date.now();

  // Child env is scrubbed — no inherit of runner's bearer + master key. See
  // trust-gradient-isolation pattern decision 3.
  const child = spawnFn(argv, {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: buildChildEnv(),
  }) as Bun.Subprocess<"pipe", "pipe", "pipe">;

  // Write the prompt to stdin and close it so claude knows the input is done.
  // Bun's FileSink supports .write/.end on stdin when configured with "pipe".
  child.stdin.write(args.prompt);
  await child.stdin.end();

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      child.kill("SIGTERM");
    } catch {}
    // Hard-kill 5s later if it didn't honor SIGTERM.
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
    }, 5_000);
  }, timeoutMs);

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ]);
  clearTimeout(timer);

  return {
    stdout: stdoutText,
    stderr: stderrText,
    exitCode,
    timedOut,
    durationMs: Date.now() - started,
    command: redactBearer(argv),
  };
}
