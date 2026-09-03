import { describe, expect, it } from "vitest";
import { truncate, TRUNCATE_LARGE, TRUNCATE_MEDIUM, TRUNCATE_SMALL, TRUNCATE_TINY } from "../../src/util/truncate.js";

describe("truncate", () => {
  it("returns the string unchanged when under the limit", () => {
    expect(truncate("hello", 100)).toBe("hello");
  });

  it("returns the string unchanged when exactly at the limit (boundary, not just over it)", () => {
    const s = "x".repeat(10);
    expect(truncate(s, 10)).toBe(s);
  });

  it("truncates and appends a marker when over the limit", () => {
    const result = truncate("x".repeat(20), 10);
    expect(result).toBe(`${"x".repeat(10)}\n... (truncated)`);
  });

  it("the four named tiers are distinct and ordered large > medium > small > tiny", () => {
    expect(TRUNCATE_LARGE).toBeGreaterThan(TRUNCATE_MEDIUM);
    expect(TRUNCATE_MEDIUM).toBeGreaterThan(TRUNCATE_SMALL);
    expect(TRUNCATE_SMALL).toBeGreaterThan(TRUNCATE_TINY);
  });
});
