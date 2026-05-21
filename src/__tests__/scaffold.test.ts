import { describe, expect, it } from "bun:test";

import pkg from "../../package.json" with { type: "json" };
import { VERSION, runOnce, serve } from "../index.ts";

describe("scaffold", () => {
  it("exports VERSION matching package.json", () => {
    expect(VERSION).toBe(pkg.version);
  });

  it("runOnce stub throws not-yet-implemented", async () => {
    await expect(runOnce()).rejects.toThrow(/not yet implemented/);
  });

  it("serve stub throws not-yet-implemented", async () => {
    await expect(serve()).rejects.toThrow(/not yet implemented/);
  });
});
