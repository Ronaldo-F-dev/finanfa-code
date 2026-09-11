import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "@finanfa/core/src/core/session.js";
import { buildHistoryReplay } from "../../src/engine/history.js";

describe("buildHistoryReplay", () => {
  it("returns an empty array for a fresh session", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-history-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
      expect(buildHistoryReplay(session)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("replays user/assistant text messages in order, skipping tool messages", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-history-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
      session.messages = [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello", toolCalls: [{ id: "1", name: "bash", input: {} }] },
        { role: "tool", results: [{ toolCallId: "1", content: "ok", isError: false }] },
        { role: "assistant", content: "done" },
      ];
      expect(buildHistoryReplay(session)).toEqual([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "assistant", content: "done" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("interleaves errorLog entries at their original afterMessageIndex position", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "finanfa-history-"));
    try {
      const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "s" });
      session.messages = [
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "user", content: "second" },
      ];
      session.errorLog = [{ text: "the model call failed", afterMessageIndex: 2 }];
      expect(buildHistoryReplay(session)).toEqual([
        { role: "user", content: "first" },
        { role: "assistant", content: "ok" },
        { role: "error", content: "the model call failed" },
        { role: "user", content: "second" },
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
