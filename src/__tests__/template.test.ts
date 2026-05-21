/**
 * Tests for `src/template.ts` — variable substitution + fail-fast on unknown.
 */

import { describe, expect, it } from "bun:test";

import { TemplateError, isoDate, randomRunId, render } from "../template.ts";

describe("render", () => {
  const vars = { date: "2026-05-21", job_name: "daily-tweets", run_id: "rid-1" };

  it("substitutes each known variable", () => {
    expect(render("Today: {{date}}", vars)).toBe("Today: 2026-05-21");
    expect(render("Job: {{job_name}}", vars)).toBe("Job: daily-tweets");
    expect(render("Run: {{run_id}}", vars)).toBe("Run: rid-1");
  });

  it("handles multiple substitutions in one string", () => {
    expect(render("{{job_name}}/{{date}}/{{run_id}}", vars)).toBe("daily-tweets/2026-05-21/rid-1");
  });

  it("ignores whitespace inside braces", () => {
    expect(render("{{ date }}", vars)).toBe("2026-05-21");
  });

  it("throws TemplateError on unknown variable", () => {
    expect(() => render("Hi {{Date}}", vars)).toThrow(TemplateError);
  });

  it("collects every unknown var across the string", () => {
    try {
      render("{{foo}} {{bar}} {{date}}", vars);
      throw new Error("expected throw");
    } catch (e) {
      expect(e).toBeInstanceOf(TemplateError);
      const te = e as TemplateError;
      expect(te.unknownVars.sort()).toEqual(["bar", "foo"]);
    }
  });

  it("leaves text without braces untouched", () => {
    expect(render("plain text", vars)).toBe("plain text");
  });
});

describe("isoDate", () => {
  it("formats UTC year-month-day", () => {
    expect(isoDate(new Date("2026-05-21T15:00:00Z"))).toBe("2026-05-21");
  });

  it("zero-pads month + day", () => {
    expect(isoDate(new Date("2026-01-05T15:00:00Z"))).toBe("2026-01-05");
  });
});

describe("randomRunId", () => {
  it("returns a UUIDv4 shape", () => {
    const id = randomRunId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("returns distinct values across calls", () => {
    expect(randomRunId()).not.toBe(randomRunId());
  });
});
