import { describe, expect, it, vi } from "vitest";
import { askUserTool } from "../../src/tools/builtin/ask-user.js";
import type { UIAdapter } from "../../src/ui/adapter.js";

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

describe("ask_user tool", () => {
  it("asks the user the given question and returns their real answer as the tool result", async () => {
    const ui = makeUi("staging");
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal, ui };

    const result = await askUserTool.handler({ question: "Which environment: staging or production?" }, ctx);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("staging");
    expect(ui.askUser).toHaveBeenCalledWith("Which environment: staging or production?", "input");
  });

  it("reports a clear error instead of throwing when there's no UI to ask through", async () => {
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };

    const result = await askUserTool.handler({ question: "anything?" }, ctx);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available");
  });

  it("has 'safe' risk level — it only reads input, no side effects", () => {
    expect(askUserTool.riskLevel).toBe("safe");
  });
});
