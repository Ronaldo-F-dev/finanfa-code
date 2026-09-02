import { describe, expect, it } from "vitest";
import { generate3dTool } from "../../src/tools/builtin/generate-3d.js";

describe("generate_3d tool (stub — no provider configured)", () => {
  it("has a safe risk level and describes itself as unavailable", () => {
    expect(generate3dTool.name).toBe("generate_3d");
    expect(generate3dTool.riskLevel).toBe("safe");
    expect(generate3dTool.description).toMatch(/NOT CURRENTLY AVAILABLE/);
  });

  it("always returns an unavailable error mentioning the requested prompt", async () => {
    const result = await generate3dTool.handler({ prompt: "a low-poly fox" }, {} as any);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("unavailable");
    expect(result.content).toContain("a low-poly fox");
  });

  it("describeCall summarizes the request", () => {
    expect(generate3dTool.describeCall?.({ prompt: "a chair" })).toBe("generate 3D: a chair");
  });
});
