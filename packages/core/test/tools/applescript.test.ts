import { describe, expect, it } from "vitest";
import { createRunAppleScriptTool } from "../../src/tools/builtin/applescript.js";

const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
const isMac = process.platform === "darwin";

describe.skipIf(!isMac)("run_applescript tool (real osascript, macOS only)", () => {
  it("runs a real AppleScript expression and returns its result", async () => {
    const tool = createRunAppleScriptTool();
    const result = await tool.handler({ script: "return 1 + 1" }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("2");
  });

  it("runs a real multi-line script containing quotes, unaffected by shell retokenization", async () => {
    const tool = createRunAppleScriptTool();
    const result = await tool.handler({ script: 'set x to "hello world"\nreturn x' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("hello world");
  });

  it("reports a real AppleScript execution error as isError, with the real error text", async () => {
    const tool = createRunAppleScriptTool();
    const result = await tool.handler({ script: 'return "not a number" + 1' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("-1700");
  });

  it("has 'dangerous' risk level", () => {
    expect(createRunAppleScriptTool().riskLevel).toBe("dangerous");
  });
});

describe("run_applescript tool describeCall", () => {
  it("summarizes only the first line of a multi-line script", () => {
    const tool = createRunAppleScriptTool();
    expect(tool.describeCall?.({ script: "tell application \"Finder\"\nactivate\nend tell" })).toBe('run AppleScript: tell application "Finder"');
  });
});
