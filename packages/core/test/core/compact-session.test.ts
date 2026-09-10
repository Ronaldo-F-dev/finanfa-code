import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { compactSession } from "../../src/core/loop.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";

class FixedSummaryProvider implements LlmProvider {
  calls: StreamTurnParams[] = [];
  constructor(private readonly summary: string) {}
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.calls.push(params);
    return {
      assistantMessage: { role: "assistant", content: this.summary },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

class MalformedContentProvider implements LlmProvider {
  async streamTurn(): Promise<StreamTurnResult> {
    return {
      assistantMessage: { role: "assistant", content: undefined as unknown as string },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "end_turn",
    };
  }
}

class ThrowingProvider implements LlmProvider {
  async streamTurn(): Promise<StreamTurnResult> {
    throw new Error("network error");
  }
}

describe("compactSession", () => {
  let dir: string;

  it("replaces the conversation with a two-message summary, and persists it", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
      session.messages = [
        { role: "user", content: "build me a login page" },
        { role: "assistant", content: "sure, here's a login page", toolCalls: [{ id: "1", name: "write_file", input: {} }] },
        { role: "tool", results: [{ toolCallId: "1", content: "wrote login.html", isError: false }] },
        { role: "assistant", content: "done, login.html is ready" },
      ];
      const provider = new FixedSummaryProvider("User asked for a login page; login.html was created and is ready.");

      const result = await compactSession(session, provider);

      expect(result).toEqual({ messagesBefore: 4 });
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0]).toEqual({ role: "user", content: "[Earlier conversation compacted to save context — see the summary below]" });
      expect(session.messages[1]).toEqual({ role: "assistant", content: "User asked for a login page; login.html was created and is ready." });

      // The summarization call itself got the FULL transcript, not just a fragment.
      expect(provider.calls).toHaveLength(1);
      expect(provider.calls[0].messages[0].role).toBe("user");
      const transcript = (provider.calls[0].messages[0] as { content: string }).content;
      expect(transcript).toContain("build me a login page");
      expect(transcript).toContain("write_file");
      // Real bug, fixed: tool results used to collapse to a bare "ok"/"error"
      // with none of the actual content, so the summarizer had no way to
      // know what a tool call actually produced (e.g. text_to_speech
      // genuinely writing a file got summarized as "unclear whether it
      // succeeded") — the real content must reach the summarization prompt.
      expect(transcript).toContain("wrote login.html");
      expect(provider.calls[0].tools).toEqual([]);

      const reloaded = await AgentSession.resume(dir, session.id, "sys");
      expect(reloaded.messages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does nothing for an empty session — no provider call, returns undefined", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
      const provider = new FixedSummaryProvider("N/A");

      const result = await compactSession(session, provider);

      expect(result).toBeUndefined();
      expect(provider.calls).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the original conversation untouched when the provider call fails", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
      session.messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];

      const result = await compactSession(session, new ThrowingProvider());

      expect(result).toBeUndefined();
      expect(session.messages).toHaveLength(2);
      expect(session.messages[0]).toEqual({ role: "user", content: "hi" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the original conversation untouched when the provider's content is undefined, not just empty/thrown", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
      session.messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];

      const result = await compactSession(session, new MalformedContentProvider());

      expect(result).toBeUndefined();
      expect(session.messages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("leaves the original conversation untouched when the model returns an empty summary", async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-compact-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
      session.messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ];
      const provider = new FixedSummaryProvider("   ");

      const result = await compactSession(session, provider);

      expect(result).toBeUndefined();
      expect(session.messages).toHaveLength(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
