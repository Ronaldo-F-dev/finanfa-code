import { describe, expect, it, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runHooks, type HookLlmRunner, type HookPayload } from "../../src/hooks/runner.js";
import type { HooksConfig } from "../../src/hooks/config.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { registerStatefulBuiltins } from "../../src/tools/builtin/index.js";
import { BrowserManager } from "../../src/browser/manager.js";
import type { LlmProvider, StreamTurnResult, ToolDefinition } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

const payload: HookPayload = { hook_event_name: "PreToolUse", session_id: "s", cwd: "/tmp", tool_name: "wipe", tool_input: { target: "db" } };
const promptHook = (extra: object = {}): HooksConfig => ({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "Is this safe? $ARGUMENTS", ...extra }] }] });
const agentHook = (extra: object = {}): HooksConfig => ({ PreToolUse: [{ hooks: [{ type: "agent", prompt: "Do the tests exist?", ...extra }] }] });
const reply = (text: string): HookLlmRunner => ({ prompt: async () => text, agent: async () => text });

describe("prompt hooks (runner)", () => {
  it("block on ok:false, with the model's reason", async () => {
    const out = await runHooks(promptHook(), "PreToolUse", payload, "/tmp", reply('{"ok": false, "reason": "drops a database"}'));
    expect(out).toEqual({ decision: "block", reason: "drops a database" });
  });

  it("say nothing on ok:true", async () => {
    expect(await runHooks(promptHook(), "PreToolUse", payload, "/tmp", reply('{"ok": true}'))).toEqual({});
  });

  it("can never approve: a model answering decision:approve has no effect", async () => {
    const out = await runHooks(promptHook(), "PreToolUse", payload, "/tmp", reply('{"decision": "approve"}'));
    expect(out.decision).toBeUndefined();
    expect(out.output).toContain("gave no verdict");
  });

  it("substitutes $ARGUMENTS with the payload JSON, and appends it when the placeholder is absent", async () => {
    const seen: string[] = [];
    const runner: HookLlmRunner = { prompt: async (p) => (seen.push(p), '{"ok": true}') };
    await runHooks(promptHook(), "PreToolUse", payload, "/tmp", runner);
    await runHooks(promptHook({ prompt: "Check this." }), "PreToolUse", payload, "/tmp", runner);
    expect(seen[0]).toContain('"tool_name": "wipe"');
    expect(seen[0]).not.toContain("$ARGUMENTS");
    expect(seen[1]).toMatch(/^Check this\.\n\nHook input:\n/);
    expect(seen[1]).toContain('"target": "db"');
    expect(seen[0]).toContain('{"ok": false, "reason"');
  });

  it("passes the hook's own model through", async () => {
    const prompt = vi.fn().mockResolvedValue('{"ok": true}');
    await runHooks(promptHook({ model: "tiny-model" }), "PreToolUse", payload, "/tmp", { prompt });
    expect(prompt).toHaveBeenCalledWith(expect.any(String), "tiny-model", 30_000);
  });

  it("is no opinion when the model call fails, times out, or no model is available", async () => {
    const failing = await runHooks(promptHook(), "PreToolUse", payload, "/tmp", { prompt: async () => Promise.reject(new Error("boom")) });
    expect(failing).toEqual({ output: "(prompt hook failed: boom)" });

    const slow = await runHooks(promptHook({ timeout: 0.05 }), "PreToolUse", payload, "/tmp", { prompt: () => new Promise(() => {}) });
    expect(slow.decision).toBeUndefined();
    expect(slow.output).toContain("timed out");

    const none = await runHooks(promptHook(), "PreToolUse", payload, "/tmp");
    expect(none.decision).toBeUndefined();
    expect(none.output).toContain("no model is available");
  });

  it("truncates a huge payload before it reaches the model", async () => {
    const seen: string[] = [];
    await runHooks(promptHook(), "PreToolUse", { ...payload, tool_response: "x".repeat(100_000) }, "/tmp", { prompt: async (p) => (seen.push(p), '{"ok": true}') });
    expect(seen[0].length).toBeLessThan(25_000);
    expect(seen[0]).toContain("(truncated)");
  });
});

describe("agent hooks (runner)", () => {
  it("use the agent runner, not the plain prompt one, and default to a 120s timeout", async () => {
    const agent = vi.fn().mockResolvedValue('{"ok": false, "reason": "no tests"}');
    const prompt = vi.fn();
    const out = await runHooks(agentHook(), "PreToolUse", payload, "/tmp", { agent, prompt });
    expect(out).toEqual({ decision: "block", reason: "no tests" });
    expect(agent).toHaveBeenCalledWith(expect.stringContaining("Do the tests exist?"), 120_000);
    expect(prompt).not.toHaveBeenCalled();
  });
});

function makeUi(): UIAdapter {
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
    askUser: vi.fn().mockResolvedValue("y"),
    close: vi.fn(),
  };
}

const risky: ToolDefinition = { name: "wipe", description: "", riskLevel: "ask", inputSchema: { type: "object" }, handler: async () => ({ content: "", isError: false }) };

function scriptedProvider(text: string) {
  const calls: Array<{ model: string; system: string }> = [];
  const provider = {
    async streamTurn(req: { model: string; systemPrompt?: string }): Promise<StreamTurnResult> {
      calls.push({ model: req.model, system: req.systemPrompt ?? "" });
      return { assistantMessage: { role: "assistant", content: text }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
    },
  } as LlmProvider;
  return { provider, calls };
}

describe("prompt hooks (PermissionManager)", () => {
  it("block a PreToolUse tool call using the provider's cheap model", async () => {
    const { provider, calls } = scriptedProvider('{"ok": false, "reason": "too risky"}');
    const ui = makeUi();
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, provider, hooksConfig: promptHook() });
    const decision = await manager.check(risky, { target: "db" }, { cwd: "/tmp", sessionId: "s" } as never);
    expect(decision).toBe("deny");
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("too risky"));
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBeTruthy();
  });

  it("let the call through on ok:true", async () => {
    const { provider } = scriptedProvider('{"ok": true}');
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui: makeUi(), yolo: true, provider, hooksConfig: promptHook() });
    expect(await manager.check(risky, {}, { cwd: "/tmp", sessionId: "s" } as never)).toBe("allow");
  });

  it("never re-fire hooks from inside an agent hook's own run (no infinite recursion)", async () => {
    const ui = makeUi();
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig: agentHook() });
    let agentRuns = 0;
    manager.setHookAgentRunner(async () => {
      agentRuns++;
      // The agent itself calls a tool, which would trigger the same PreToolUse agent hook again.
      await manager.check(risky, {}, { cwd: "/tmp", sessionId: "inner" } as never);
      return '{"ok": true}';
    });
    expect(await manager.check(risky, {}, { cwd: "/tmp", sessionId: "outer" } as never)).toBe("allow");
    expect(agentRuns).toBe(1);
  });

  it("do not suppress hooks for an unrelated concurrent tool call", async () => {
    const ui = makeUi();
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, hooksConfig: agentHook() });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let runs = 0;
    manager.setHookAgentRunner(async () => {
      runs++;
      if (runs === 1) await gate; // the first agent hook stays "inside" while the second call happens
      return '{"ok": true}';
    });
    const first = manager.check(risky, {}, { cwd: "/tmp", sessionId: "a" } as never);
    await new Promise((r) => setTimeout(r, 20));
    const second = manager.check(risky, {}, { cwd: "/tmp", sessionId: "b" } as never);
    await new Promise((r) => setTimeout(r, 20));
    release();
    await Promise.all([first, second]);
    expect(runs).toBe(2);
  });
});

describe("agent hooks through the real task tool", () => {
  it("run a read-only hook-verifier sub-agent and block on its verdict", async () => {
    const cwd = await mkdtemp(path.join(tmpdir(), "finanfa-agent-hook-"));
    const { provider, calls } = scriptedProvider('I looked around.\n{"ok": false, "reason": "no test covers this"}');
    const ui = makeUi();
    const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true, provider, hooksConfig: agentHook() });
    const registry = new ToolRegistry();
    registerStatefulBuiltins(registry, { provider, permissions, ui, model: "m", cwd, browser: new BrowserManager(), designContract: "", systemPrompt: "sys" });

    const decision = await permissions.check(risky, { target: "db" }, { cwd, sessionId: "s" } as never);
    expect(decision).toBe("deny");
    expect(ui.writeError).toHaveBeenCalledWith(expect.stringContaining("no test covers this"));
    // The sub-agent ran with the hook-verifier system prompt, not the generic one.
    expect(calls.some((c) => c.system.includes("You verify one condition"))).toBe(true);
  }, 30_000);
});
