import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PermissionManager } from "../../src/permissions/manager.js";
import { resolveClassifierModel } from "../../src/permissions/classifier.js";
import { DEFAULT_PERMISSION_CONFIG, type PermissionConfig } from "../../src/permissions/config.js";
import type { ToolDefinition, ToolContext } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";

// A real, controllable LlmProvider implementation (same stand-in pattern as
// test/tools/security/redteam-fake-provider.ts) — the classifier makes a
// real streamTurn() call through this exact interface, so this plays the
// role of the actual (cheap) classifier model without hitting a real API.
function fakeClassifierProvider(reply: string | (() => string), opts?: { delayMs?: number; throws?: boolean }): LlmProvider {
  return {
    async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
      if (opts?.throws) throw new Error("classifier provider unreachable");
      if (opts?.delayMs) {
        await new Promise((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          params.signal?.addEventListener("abort", () => {
            clearTimeout(t);
            reject(new Error("aborted"));
          });
        });
      }
      const content = typeof reply === "function" ? reply() : reply;
      return { assistantMessage: { role: "assistant", content }, usage: { inputTokens: 0, outputTokens: 0 }, stopReason: "end_turn" };
    },
  };
}

function makeUi(answer: string): UIAdapter {
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

const ctx: ToolContext = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

const bashLikeTool: ToolDefinition<{ command: string }> = {
  name: "bash",
  description: "",
  riskLevel: "dangerous",
  inputSchema: { type: "object" },
  riskKey: (input) => input.command.split(" ")[0],
  handler: async () => ({ content: "", isError: false }),
};

function classifierConfig(): PermissionConfig {
  return { ...DEFAULT_PERMISSION_CONFIG, autoApprovalClassifier: { enabled: true, model: "fake-classifier" } };
}

describe("PermissionManager auto-approval classifier", () => {
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // check() writes an audit-log entry per decision — isolate HOME so
    // these tests don't touch the developer's real ~/.finanfa-code/audit/.
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-classifier-audit-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(homeDir, { recursive: true, force: true });
  });

  it("low risk: auto-allows silently, without ever prompting the user", async () => {
    const ui = makeUi("n"); // would deny if actually asked — proves the prompt was skipped
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "low", justification: "read-only" }));
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(ui.writeSystem).not.toHaveBeenCalled();
  });

  it("medium risk: auto-allows but surfaces a visible notice explaining why", async () => {
    const ui = makeUi("n");
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "medium", justification: "edits a file already in progress" }));
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "git commit -am wip" }, ctx);

    expect(decision).toBe("allow");
    expect(ui.askUser).not.toHaveBeenCalled();
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("edits a file already in progress"));
    expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("medium risk"));
  });

  it("high risk: falls through to the existing ask prompt, same as today", async () => {
    const ui = makeUi("n");
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "high", justification: "irreversible" }));
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "rm -rf /" }, ctx);

    expect(decision).toBe("deny"); // the "n" answer from the real ask prompt
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("classifier error: fails open to ask, never to allow", async () => {
    const ui = makeUi("n");
    const provider = fakeClassifierProvider("", { throws: true });
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("deny"); // reached via the real ask prompt, answered "n"
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("classifier gives an unparseable response: fails open to ask, never to allow", async () => {
    const ui = makeUi("n");
    const provider = fakeClassifierProvider("not json at all");
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("deny");
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("classifier timeout/abort: fails open to ask, never to allow", async () => {
    // classifyToolRisk ties its own internal timeout controller to the
    // caller's ctx.signal (see manager.ts / classifier.ts) — aborting the
    // outer signal exercises the exact same "the request didn't finish in
    // time" path a real 10s timeout would, without an actual 10s wait.
    const ui = makeUi("n");
    const provider: LlmProvider = {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        return new Promise((_resolve, reject) => {
          params.signal?.addEventListener("abort", () => reject(new Error("timed out")));
        });
      },
    };
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    const localController = new AbortController();
    const localCtx: ToolContext = { ...ctx, signal: localController.signal };
    const checkPromise = manager.check(bashLikeTool, { command: "git status" }, localCtx);
    // Give the pending microtask chain (hooks check → classifyToolRisk →
    // provider.streamTurn) a macrotask tick to actually register its abort
    // listener before we fire it — aborting first would fire the event
    // before anything is listening for it.
    await new Promise((resolve) => setTimeout(resolve, 10));
    localController.abort();

    const decision = await checkPromise;
    expect(decision).toBe("deny"); // reached via the real ask prompt, answered "n"
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("mode disabled (default): completely unchanged existing behavior — classifier never called", async () => {
    const ui = makeUi("y");
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "low", justification: "n/a" }));
    const streamTurnSpy = vi.spyOn(provider, "streamTurn");
    // No autoApprovalClassifier in config at all — the regression guard.
    const manager = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, provider });

    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("allow"); // via the real ask prompt answering "y", not the classifier
    expect(ui.askUser).toHaveBeenCalledTimes(1);
    expect(streamTurnSpy).not.toHaveBeenCalled();
  });

  it("mode enabled via config but disabled again at runtime via setAutoApprovalClassifier(undefined): reverts to normal ask flow", async () => {
    const ui = makeUi("y");
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "low", justification: "n/a" }));
    const streamTurnSpy = vi.spyOn(provider, "streamTurn");
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });

    manager.setAutoApprovalClassifier(undefined);
    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);
    expect(streamTurnSpy).not.toHaveBeenCalled();
  });

  it("no provider wired in: classifier never runs even if config enables it (fails open to normal ask flow)", async () => {
    const ui = makeUi("y");
    const manager = new PermissionManager({ config: classifierConfig(), ui }); // no `provider`

    const decision = await manager.check(bashLikeTool, { command: "git status" }, ctx);

    expect(decision).toBe("allow");
    expect(ui.askUser).toHaveBeenCalledTimes(1);
  });

  it("records the auto_approval_classifier decision source for a low-risk auto-allow", async () => {
    const ui = makeUi("n");
    const provider = fakeClassifierProvider(JSON.stringify({ risk: "low", justification: "read-only" }));
    const manager = new PermissionManager({ config: classifierConfig(), ui, provider });
    await manager.check(bashLikeTool, { command: "git status" }, ctx);

    const { readFile } = await import("node:fs/promises");
    const { auditFilePath } = await import("../../src/observability/audit-log.js");
    const raw = await readFile(auditFilePath(), "utf-8");
    const events = raw.trim().split("\n").map((l) => JSON.parse(l));
    expect(events[0]).toMatchObject({ decision: "allow", source: "auto_approval_classifier" });
  });
});

describe("resolveClassifierModel", () => {
  it("uses the configured model, and never an empty one (the default must always name a real model)", () => {
    expect(resolveClassifierModel({ enabled: true, model: "claude-haiku-4-5" })).toBe("claude-haiku-4-5");
    expect(resolveClassifierModel(undefined)).toBeTruthy();
    expect(resolveClassifierModel({ enabled: true })).toBeTruthy();
    expect(resolveClassifierModel({ enabled: true, model: "  " })).toBeTruthy();
  });
});
