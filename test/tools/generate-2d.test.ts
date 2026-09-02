import { describe, expect, it } from "vitest";
import { generate2dTool } from "../../src/tools/builtin/generate-2d.js";

describe("generate_2d tool (stub — no working provider)", () => {
  it("has a safe risk level and describes itself as unavailable", () => {
    expect(generate2dTool.name).toBe("generate_2d");
    expect(generate2dTool.riskLevel).toBe("safe");
    expect(generate2dTool.description).toMatch(/NOT CURRENTLY AVAILABLE/);
  });

  it("always returns an unavailable error mentioning the requested prompt", async () => {
    const result = await generate2dTool.handler({ prompt: "a mountain landscape" }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    expect(result.content).toContain("a mountain landscape");
  });

  it("describeCall summarizes the request", () => {
    expect(generate2dTool.describeCall?.({ prompt: "a logo" })).toBe("generate 2D: a logo");
  });
});
