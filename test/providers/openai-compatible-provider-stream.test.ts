import { describe, expect, it, vi, afterEach } from "vitest";
import { OpenAiCompatibleProvider } from "../../src/providers/openai-compatible-provider.js";

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200 });
}

describe("OpenAiCompatibleProvider.streamTurn (SSE parsing)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("accumulates streamed text deltas and reports usage/stop reason", async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { content: "Hel" } }] }),
      JSON.stringify({ choices: [{ delta: { content: "lo" } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    ];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    let streamed = "";
    const result = await provider.streamTurn({
      model: "qwen2.5-coder",
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
      onTextDelta: (t) => (streamed += t),
    });

    expect(streamed).toBe("Hello");
    expect(result.assistantMessage.content).toBe("Hello");
    expect(result.stopReason).toBe("end_turn");
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 2 });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:11434/v1/chat/completions",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("accumulates incrementally-streamed tool call arguments across chunks", async () => {
    const events = [
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] } }],
      }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(events)));

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1", apiKey: "k" });
    const result = await provider.streamTurn({
      model: "m",
      systemPrompt: "sys",
      messages: [],
      tools: [],
      onTextDelta: () => {},
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantMessage.toolCalls).toEqual([
      { id: "call_1", name: "read_file", input: { path: "a.txt" } },
    ]);
  });

  it("throws a descriptive error on a non-OK response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    await expect(
      provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
    ).rejects.toThrow(/401/);
  });

  it("does not retry a non-retryable status like 401 — fails on the first attempt", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    await expect(
      provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
    ).rejects.toThrow(/401/);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a transient 503 and succeeds once the server recovers", async () => {
    vi.useFakeTimers();
    try {
      const events = [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
        .mockResolvedValueOnce(sseResponse(events));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      const promise = provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: () => {},
      });
      await vi.runAllTimersAsync();

      const result = await promise;
      expect(result.stopReason).toBe("end_turn");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after exhausting retries on a persistent 503", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      const promise = provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: () => {},
      });
      const assertion = expect(promise).rejects.toThrow(/503/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out and cancels the reader when the stream stalls mid-response, instead of hanging forever", async () => {
    vi.useFakeTimers();
    try {
      let wasCancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}\n\n`,
            ),
          );
          // deliberately never enqueue again or close — simulates a stalled connection
        },
        cancel() {
          wasCancelled = true;
        },
      });
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(body, { status: 200 })));

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      const promise = provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: () => {},
      });
      const assertion = expect(promise).rejects.toThrow(/stalled/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(wasCancelled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats fully-formed pending tool calls as tool_use even with no terminal finish_reason", async () => {
    const events = [
      JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }],
      }),
      // stream ends right here — no finish_reason chunk at all
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(events)));

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    const result = await provider.streamTurn({
      model: "m",
      systemPrompt: "s",
      messages: [],
      tools: [],
      onTextDelta: () => {},
    });

    expect(result.stopReason).toBe("tool_use");
    expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "read_file", input: { path: "a.txt" } }]);
  });

  it("warns and substitutes {} for malformed tool-call arguments, instead of silently guessing", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const events = [
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "edit_file", arguments: "{not valid json" } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
      ];
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(events)));

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      const result = await provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: () => {},
      });

      expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "edit_file", input: {} }]);
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("edit_file"));
    } finally {
      errorSpy.mockRestore();
    }
  });
});
