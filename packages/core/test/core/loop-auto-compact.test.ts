import { describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { runTurn } from "../../src/core/loop.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

function makeStubUi(): UIAdapter {
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
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

class RecordingProvider implements LlmProvider {
  calls: StreamTurnParams[] = [];
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.calls.push(params);
    // compactSession's own summarization call is identifiable by its
    // distinct system prompt (see loop.ts) — everything else is a normal
    // turn.
    if (params.systemPrompt.startsWith("Summarize the conversation transcript")) {
      return {
        assistantMessage: { role: "assistant", content: "Summary: a big earlier conversation, now condensed." },
        usage: { inputTokens: 5, outputTokens: 5 },
        stopReason: "end_turn",
      };
    }
    return {
      assistantMessage: { role: "assistant", content: "All good now that context is small again." },
      usage: { inputTokens: 10, outputTokens: 5 },
      stopReason: "end_turn",
    };
  }
}

describe(
  "runTurn: auto-compacts before a call whose estimated size (system prompt + tool schemas + messages) is too " +
    "large, instead of only finding out after a silent empty/failed response",
  () => {
    it(
      "real reported bug: a huge accumulated tool result (hundreds of thousands of chars) triggers automatic " +
        "compaction before the next provider call, not after",
      async () => {
        let homeDir: string | undefined;
        try {
          homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-auto-compact-home-"));
          const originalHome = process.env.HOME;
          process.env.HOME = homeDir;
          try {
            const tools = new ToolRegistry();
            const ui = makeStubUi();
            const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
            const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
            // A single huge verbose tool result (the real trigger: large
            // `ls -la`/`cat`/`find` dumps accumulating unbounded — see the
            // AUTO_COMPACT_TOKEN_THRESHOLD comment in loop.ts) — well past
            // the 100k-token threshold on its own.
            session.messages = [
              { role: "user", content: "explore the project" },
              { role: "assistant", content: "ok", toolCalls: [{ id: "1", name: "bash", input: { command: "ls -la" } }] },
              { role: "tool", results: [{ toolCallId: "1", content: "x".repeat(500_000), isError: false }] },
            ];
            const provider = new RecordingProvider();

            await runTurn(session, provider, ui, tools, permissions, "continue");

            expect(provider.calls).toHaveLength(2);
            expect(provider.calls[0]!.systemPrompt).toContain("Summarize the conversation transcript");
            expect(ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("compacting automatically"));
            // The huge old tool result is gone from what's actually stored —
            // proof the compaction really replaced session.messages, not
            // just shrank what got sent for one call the way
            // compactForProvider alone would.
            expect(JSON.stringify(session.messages)).not.toContain("x".repeat(1000));
            expect(session.messages.some((m) => m.role === "assistant" && m.content === "All good now that context is small again.")).toBe(true);
          } finally {
            process.env.HOME = originalHome;
          }
        } finally {
          if (homeDir) await rm(homeDir, { recursive: true, force: true });
        }
      },
    );

    it("does not compact a small, ordinary conversation", async () => {
      const homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-auto-compact-home-"));
      const originalHome = process.env.HOME;
      process.env.HOME = homeDir;
      try {
        const tools = new ToolRegistry();
        const ui = makeStubUi();
        const permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
        const session = new AgentSession({ cwd: "/tmp", model: "test-model", systemPrompt: "sys" });
        const provider = new RecordingProvider();

        await runTurn(session, provider, ui, tools, permissions, "hello");

        expect(provider.calls).toHaveLength(1);
        expect(ui.writeSystem).not.toHaveBeenCalledWith(expect.stringContaining("compacting automatically"));
      } finally {
        process.env.HOME = originalHome;
        await rm(homeDir, { recursive: true, force: true });
      }
    });
  },
);
