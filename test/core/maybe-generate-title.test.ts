import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { maybeGenerateTitle } from "../../src/core/loop.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";

class FixedTitleProvider implements LlmProvider {
  calls: StreamTurnParams[] = [];
  constructor(private readonly title: string) {}
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    this.calls.push(params);
    return {
      assistantMessage: { role: "assistant", content: this.title },
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

describe("maybeGenerateTitle", () => {
  let dir: string;
  let homeDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "finanfa-title-cwd-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-title-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(dir, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("sets and persists a title after the first exchange, using the first user message", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    session.messages = [
      { role: "user", content: "how do I center a div" },
      { role: "assistant", content: "use flexbox" },
    ];
    const provider = new FixedTitleProvider("Centering a div with flexbox");

    await maybeGenerateTitle(session, provider);

    expect(session.title).toBe("Centering a div with flexbox");
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages).toEqual([{ role: "user", content: "how do I center a div" }]);
    expect(provider.calls[0].tools).toEqual([]);

    const reloaded = await AgentSession.resume(dir, session.id, "sys");
    expect(reloaded.title).toBe("Centering a div with flexbox");
  });

  it("strips surrounding quotes and truncates an overly long response", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    session.messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const provider = new FixedTitleProvider(`"${"x".repeat(100)}"`);

    await maybeGenerateTitle(session, provider);

    expect(session.title?.startsWith('"')).toBe(false);
    expect(session.title?.length).toBeLessThanOrEqual(60);
  });

  it("does nothing (and makes no provider call) once a title already exists", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    session.title = "Already titled";
    session.messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];
    const provider = new FixedTitleProvider("Should not be used");

    await maybeGenerateTitle(session, provider);

    expect(session.title).toBe("Already titled");
    expect(provider.calls).toHaveLength(0);
  });

  it("does nothing before any user message exists yet", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    const provider = new FixedTitleProvider("N/A");

    await maybeGenerateTitle(session, provider);

    expect(session.title).toBeUndefined();
    expect(provider.calls).toHaveLength(0);
  });

  it("never throws when the provider call fails — a title is best-effort", async () => {
    const session = new AgentSession({ cwd: dir, model: "m", systemPrompt: "sys" });
    session.messages = [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }];

    await expect(maybeGenerateTitle(session, new ThrowingProvider())).resolves.toBeUndefined();
    expect(session.title).toBeUndefined();
  });
});
