import { describe, expect, it, vi } from "vitest";
import { exitPlanModeTool } from "../../src/tools/builtin/exit-plan-mode.js";
import type { ToolContext } from "../../src/core/types.js";

const ctx = (exitPlanMode?: () => void): ToolContext => ({
  cwd: "/tmp",
  sessionId: "s",
  signal: new AbortController().signal,
  exitPlanMode,
});

describe("exit_plan_mode tool", () => {
  it("has 'ask' risk level", () => {
    expect(exitPlanModeTool.riskLevel).toBe("ask");
  });

  it("preview() returns the plan text verbatim, for the confirmation prompt", async () => {
    const preview = await exitPlanModeTool.preview!({ plan: "1. Do X\n2. Do Y" }, ctx());
    expect(preview).toBe("1. Do X\n2. Do Y");
  });

  it("calls ctx.exitPlanMode() and reports success", async () => {
    const exitPlanMode = vi.fn();
    const result = await exitPlanModeTool.handler({ plan: "a plan" }, ctx(exitPlanMode));
    expect(exitPlanMode).toHaveBeenCalledTimes(1);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Plan approved");
  });

  it("does not throw when ctx.exitPlanMode is absent (direct unit-test contexts)", async () => {
    const result = await exitPlanModeTool.handler({ plan: "a plan" }, ctx());
    expect(result.isError).toBe(false);
  });
});
