/**
 * Tests for `src/job-parser.ts` — frontmatter → Job conversion.
 */

import { describe, expect, it } from "bun:test";

import { InvalidJobError, NAMED_SCHEDULES, parseJob, parseTimeout } from "../job-parser.ts";

function note(content: string, path = "jobs/daily-tweets") {
  return { id: "note-id-1", path, content };
}

describe("parseJob", () => {
  it("parses a valid job with all required fields", () => {
    const job = parseJob(
      note(
        `---
schedule: "0 8 * * *"
model: claude-opus-4-7
allowed_tools:
  - mcp__parachute-vault-default__query-notes
output_path: "jobs/runs/{{job_name}}/{{date}}"
output_tags: [job-run, daily]
timeout: 10m
disabled: false
---

Today is **{{date}}**. Draft three tweets.
`,
      ),
    );
    expect(job.id).toBe("note-id-1");
    expect(job.path).toBe("jobs/daily-tweets");
    expect(job.name).toBe("daily-tweets");
    expect(job.schedule).toBe("0 8 * * *");
    expect(job.cronString).toBe("0 8 * * *");
    expect(job.model).toBe("claude-opus-4-7");
    expect(job.allowedTools).toEqual(["mcp__parachute-vault-default__query-notes"]);
    expect(job.outputPath).toBe("jobs/runs/{{job_name}}/{{date}}");
    expect(job.outputTags).toContain("job-run");
    expect(job.outputTags).toContain("daily");
    expect(job.timeoutMs).toBe(600_000);
    expect(job.disabled).toBe(false);
    expect(job.prompt).toContain("Today is **{{date}}**");
  });

  it("expands named schedule presets", () => {
    const job = parseJob(
      note(
        `---
schedule: daily
model: claude-opus-4-7
allowed_tools: [mcp__x]
---
body`,
      ),
    );
    expect(job.cronString).toBe(NAMED_SCHEDULES.daily!);
  });

  it("handles schedule: manual (cronString null)", () => {
    const job = parseJob(
      note(
        `---
schedule: manual
model: claude-opus-4-7
allowed_tools: [mcp__x]
---
body`,
      ),
    );
    expect(job.cronString).toBeNull();
  });

  it("accepts allowed_tools as a comma-separated string", () => {
    const job = parseJob(
      note(
        `---
schedule: hourly
model: m
allowed_tools: "mcp__a, mcp__b"
---
body`,
      ),
    );
    expect(job.allowedTools).toEqual(["mcp__a", "mcp__b"]);
  });

  it("defaults outputPath when absent", () => {
    const job = parseJob(
      note(
        `---
schedule: hourly
model: m
allowed_tools: [x]
---
body`,
      ),
    );
    expect(job.outputPath).toBe("jobs/runs/{{job_name}}/{{run_id}}");
  });

  it("always includes job-run in outputTags", () => {
    const job = parseJob(
      note(
        `---
schedule: hourly
model: m
allowed_tools: [x]
output_tags: [custom-tag]
---
body`,
      ),
    );
    expect(job.outputTags).toContain("job-run");
    expect(job.outputTags).toContain("custom-tag");
  });

  it("throws InvalidJobError with multiple reasons for a broken job", () => {
    try {
      parseJob(
        note(
          `---
disabled: "notabool"
---
body`,
        ),
      );
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(InvalidJobError);
      const ie = e as InvalidJobError;
      const reasons = ie.reasons.join(" | ");
      expect(reasons).toContain("schedule");
      expect(reasons).toContain("model");
      expect(reasons).toContain("allowed_tools");
      expect(reasons).toContain("disabled");
    }
  });

  it("rejects an unknown schedule preset", () => {
    expect(() =>
      parseJob(
        note(
          `---
schedule: every-tuesday
model: m
allowed_tools: [x]
---
body`,
        ),
      ),
    ).toThrow(InvalidJobError);
  });

  it("rejects a non-cron schedule like 'tomorrow'", () => {
    expect(() =>
      parseJob(
        note(
          `---
schedule: tomorrow at 9
model: m
allowed_tools: [x]
---
body`,
        ),
      ),
    ).toThrow(InvalidJobError);
  });
});

describe("parseTimeout", () => {
  it("treats bare number as seconds", () => {
    expect(parseTimeout(600)).toBe(600_000);
  });

  it("parses 's' / 'm' / 'h' suffixes", () => {
    expect(parseTimeout("30s")).toBe(30_000);
    expect(parseTimeout("10m")).toBe(600_000);
    expect(parseTimeout("1h")).toBe(3_600_000);
  });

  it("parses bare number string as seconds", () => {
    expect(parseTimeout("600")).toBe(600_000);
  });

  it("rejects negative, zero, and bogus values", () => {
    expect(parseTimeout(-1)).toBeNull();
    expect(parseTimeout(0)).toBeNull();
    expect(parseTimeout("nope")).toBeNull();
    expect(parseTimeout({})).toBeNull();
  });
});
