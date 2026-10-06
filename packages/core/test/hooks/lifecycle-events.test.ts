import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import type { LlmProvider, StreamTurnResult, ToolDefinition } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeUi(answer = "y"): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
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

const provider: LlmProvider = {
  async streamTurn(): Promise<StreamTurnResult> {
    return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  },
} as LlmProvider;

const originalHome = process.env.HOME;
let dir: string;
beforeEach(async () => {
  process.env.HOME = await mkdtemp(path.join(tmpdir(), "finanfa-home-"));
  dir = await mkdtemp(path.join(tmpdir(), "finanfa-hooks-"));
});
afterEach(() => {
  process.env.HOME = originalHome;
});

/** A hook that appends its event name (from the stdin payload) to a marker file. */
function recorder(event: string): HooksConfig {
  const file = path.join(dir, "events.log");
  return { [event]: [{ hooks: [{ type: "command", command: `cat >/dev/null; echo ${event} >> ${file}` }] }] } as HooksConfig;
}
const readEvents = async (): Promise<string[]> => (await readFile(path.join(dir, "events.log"), "utf-8").catch(() => "")).split("\n").filter(Boolean);

describe("subagent turns", () => {
  it("fire SubagentStop, not Stop, and never SessionStart", async () => {
    const hooks: HooksConfig = { ...recorder("Stop"), SubagentStop: recorder("SubagentStop").SubagentStop, SessionStart: recorder("SessionStart").SessionStart };
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig: hooks });
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "task", undefined, undefined, { subagent: true });
    expect(await readEvents()).toEqual(["SubagentStop"]);
  });

  it("the user's own turn still fires Stop and SessionStart, not SubagentStop", async () => {
    const hooks: HooksConfig = { ...recorder("Stop"), SubagentStop: recorder("SubagentStop").SubagentStop, SessionStart: recorder("SessionStart").SessionStart };
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig: hooks });
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
    await runTurn(session, provider, ui, new ToolRegistry(), permissions, "hello");
    expect((await readEvents()).sort()).toEqual(["SessionStart", "Stop"]);
  });
});

describe("Notification hook", () => {
  const dangerous: ToolDefinition = {
    name: "wipe",
    description: "",
    riskLevel: "dangerous",
    inputSchema: { type: "object" },
    handler: async () => ({ content: "", isError: false }),
  };

  it("fires when the user is asked to approve a tool call", async () => {
    const ui = makeUi("y");
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, hooksConfig: recorder("Notification") });
    const decision = await permissions.check(dangerous, {}, { cwd: dir, sessionId: "s1" } as never);
    expect(decision).toBe("allow");
    await vi.waitFor(async () => expect(await readEvents()).toEqual(["Notification"]));
  });

  it("does not fire when nothing needs approval (yolo)", async () => {
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig: recorder("Notification") });
    await permissions.check(dangerous, {}, { cwd: dir, sessionId: "s1" } as never);
    await new Promise((r) => setTimeout(r, 200));
    expect(await readEvents()).toEqual([]);
  });
});
