import { describe, expect, it, vi } from "vitest";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { ToolDefinition, ToolContext } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(answer: string): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(answer),
    close: vi.fn(),
  };
}

const ctx: ToolContext = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

const safeTool: ToolDefinition = {
  name: "safe_tool",
  description: "",
  riskLevel: "safe",
  inputSchema: { type: "object" },
  handler: async () => ({ content: "", isError: false }),
};

const bashLikeTool: ToolDefinition<{ command: string }> = {
  name: "bash",
  description: "",
  riskLevel: "dangerous",
  inputSchema: { type: "object" },
  riskKey: (input) => input.command.split(" ")[0],
  handler: async () => ({ content: "", isError: false }),
};

describe("PermissionManager", () => {
  it("allows safe tools without prompting", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(safeTool, {}, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("prompts for dangerous tools and respects 'no'", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("deny");
  });

  it("remembers 'always' for the same risk key only", async () => {
    const ui = makeUi("a");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui });

    const first = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(first).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // same prefix again → no new prompt
    const second = await manager.check(bashLikeTool, { command: "git status" }, ctx);
    expect(second).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);

    // different prefix → prompts again
    await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(ui.askUser).toHaveBeenCalledTimes(2);
  });

  it("--yolo bypasses all prompts", async () => {
    const ui = makeUi("n");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
  });

  it("--non-interactive auto-denies without prompting", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, nonInteractive: true });
    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);
    expect(decision).toBe("deny");
    expect(ui.askUser).not.toHaveBeenCalled();
  });
});
