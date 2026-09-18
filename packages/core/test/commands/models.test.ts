import { describe, expect, it, vi, afterEach } from "vitest";
import { CommandRegistry } from "../../src/commands/registry.js";
import { registerBuiltinCommands } from "../../src/commands/builtin.js";
import { AgentSession } from "../../src/core/session.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

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
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

function baseCtx() {
  const session = new AgentSession({ cwd: "/tmp", model: "m", systemPrompt: "s" });
  return {
    session,
    ui: makeUi(),
    tools: undefined as never,
    permissions: undefined as never,
    mcp: undefined as never,
    provider: undefined as never,
    cwd: "/tmp",
    args: "",
    setSession: () => {},
    customCommands: undefined,
  };
}

// Real, reported pain point: setting up a local model meant guessing the
// right combination of provider/baseUrl/model out of several possible
// local servers/ports — wrong four times in a row (Ollama, then an MLX
// server on two different ports) in one real session before landing on
// the right one. /models is meant to remove that guesswork.
describe("/models command", () => {
  const commands = new CommandRegistry();
  registerBuiltinCommands(commands);

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports the models of whichever common local port is actually reachable, with the exact env vars to use", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:11434/v1/models") {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "llama3.2:latest" }] }), { status: 200 }),
          );
        }
        return Promise.reject(new TypeError("fetch failed"));
      }),
    );

    const ctx = baseCtx();
    const result = await commands.get("models")!(ctx);

    const written = (ctx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("Ollama — http://localhost:11434/v1");
    expect(written).toContain("llama3.2:latest");
    expect(written).toContain("FINANFA_BASE_URL=http://localhost:11434/v1 FINANFA_MODEL=llama3.2:latest");
    expect(written).not.toContain("LM Studio");
    expect(result).toBe("continue");
  });

  it("surfaces a real-tested compatibility note next to a model that has one, so the user doesn't rediscover it the hard way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:11434/v1/models") {
          return Promise.resolve(
            new Response(JSON.stringify({ data: [{ id: "lfm2.5-thinking:latest" }] }), { status: 200 }),
          );
        }
        return Promise.reject(new TypeError("fetch failed"));
      }),
    );

    const ctx = baseCtx();
    await commands.get("models")!(ctx);

    const written = (ctx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("⚠");
    expect(written).toContain("tool-search indirection");
  });

  it("says plainly when nothing was found on any of the common ports, instead of an empty result", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));

    const ctx = baseCtx();
    await commands.get("models")!(ctx);

    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("No local OpenAI-compatible server found"));
    expect(ctx.ui.writeSystem).toHaveBeenCalledWith(expect.stringContaining("FINANFA_BASE_URL=<url>"));
  });

  it("flags a server that's reachable but has no models loaded yet, distinct from one that's simply down", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (url === "http://localhost:1234/v1/models") {
          return Promise.resolve(new Response(JSON.stringify({ data: [] }), { status: 200 }));
        }
        return Promise.reject(new TypeError("fetch failed"));
      }),
    );

    const ctx = baseCtx();
    await commands.get("models")!(ctx);

    const written = (ctx.ui.writeSystem as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(written).toContain("LM Studio — http://localhost:1234/v1");
    expect(written).toContain("reachable, but reports no models");
  });
});
