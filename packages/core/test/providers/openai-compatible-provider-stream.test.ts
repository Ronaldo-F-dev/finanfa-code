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

  it("fires onToolCallStart exactly once per call, the moment its name is first seen — not on every later arguments-delta chunk for the same call", async () => {
    const events = [
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: "" } }] } }] }),
      JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.txt"}' } }] } }] }),
      JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] }),
    ];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(sseResponse(events)));

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    const onToolCallStart = vi.fn();
    await provider.streamTurn({ model: "m", systemPrompt: "sys", messages: [], tools: [], onTextDelta: () => {}, onToolCallStart });

    expect(onToolCallStart).toHaveBeenCalledTimes(1);
    expect(onToolCallStart).toHaveBeenCalledWith({ name: "read_file" });
  });

  it(
    "defaults max_tokens to 8192 when the caller sets none, instead of sending no cap at all — real reported " +
      "bug: with none sent, the remote server's own (undefined, sometimes small) default silently took over, " +
      "truncating large tool-call arguments (a big file-write) mid-generation",
    async () => {
      const events = [JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })];
      const fetchMock = vi.fn().mockResolvedValue(sseResponse(events));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      await provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });

      const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(requestInit.body as string);
      expect(body.max_tokens).toBe(8192);
    },
  );

  it("still honors an explicit maxTokens (e.g. from an effort tier) instead of overriding it", async () => {
    const events = [JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })];
    const fetchMock = vi.fn().mockResolvedValue(sseResponse(events));
    vi.stubGlobal("fetch", fetchMock);

    const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
    await provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {}, maxTokens: 512 });

    const [, requestInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(requestInit.body as string);
    expect(body.max_tokens).toBe(512);
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

  describe("multi-key rotation (a community-shared pool of keys)", () => {
    it("rotates to the next key on a 401/429-style failure and succeeds, without retrying the dead key", async () => {
      const events = [JSON.stringify({ choices: [{ delta: { content: "ok" }, finish_reason: "stop" }] })];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
        .mockResolvedValueOnce(sseResponse(events));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1", apiKeys: ["dead-key", "good-key"] });
      const result = await provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });

      expect(result.stopReason).toBe("end_turn");
      // Exactly 2 calls — no backoff-retry storm on the dead key before moving on.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer dead-key" });
      expect((fetchMock.mock.calls[1][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer good-key" });
    });

    it("remembers the last working key across calls — doesn't retry the dead one first every time", async () => {
      const events = [JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
        .mockResolvedValueOnce(sseResponse(events))
        .mockResolvedValueOnce(sseResponse(events));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1", apiKeys: ["dead-key", "good-key"] });
      await provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });
      await provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} });

      // 1st turn: dead-key fails, good-key succeeds (2 calls). 2nd turn: goes
      // straight to good-key (1 call) — 3 calls total, not 4.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect((fetchMock.mock.calls[2][1] as RequestInit).headers).toMatchObject({ Authorization: "Bearer good-key" });
    });

    it("names the exact url and model in a 404 error — actionable when several local backends are in play", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response('{"error":"please check the model you provided"}', { status: 404 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:12434/v1" });
      await expect(
        provider.streamTurn({ model: "docker.io/ai/smollm2:latest", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
      ).rejects.toThrow(/http:\/\/localhost:12434\/v1\/chat\/completions.*docker\.io\/ai\/smollm2:latest/);
    });

    it("does not rotate keys for a transient 5xx or a non-key-related error — same key, same behavior as a single-key setup", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("bad request", { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1", apiKeys: ["key-a", "key-b"] });
      await expect(
        provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
      ).rejects.toThrow(/400/);

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("throws the last error once every key in the pool has failed", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1", apiKeys: ["a", "b", "c"] });
      await expect(
        provider.streamTurn({ model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {} }),
      ).rejects.toThrow(/401/);

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
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

  it("retries a mid-stream stall that happens before any text reached the user, and succeeds on the next attempt", async () => {
    vi.useFakeTimers();
    try {
      const stalledBody = new ReadableStream<Uint8Array>({
        start() {
          // never enqueue, never close — stalls before a single byte arrives
        },
      });
      const events = [JSON.stringify({ choices: [{ delta: { content: "hi" }, finish_reason: "stop" }] })];
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(new Response(stalledBody, { status: 200 }))
        .mockResolvedValueOnce(sseResponse(events));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      let streamed = "";
      const promise = provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: (t) => (streamed += t),
      });
      await vi.runAllTimersAsync();
      const result = await promise;

      expect(streamed).toBe("hi");
      expect(result.assistantMessage.content).toBe("hi");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does NOT retry a mid-stream stall once text has already reached the user — would duplicate what's visible", async () => {
    vi.useFakeTimers();
    try {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "already shown" } }] })}\n\n`),
          );
          // then stalls — never closes, never sends another chunk
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);

      const provider = new OpenAiCompatibleProvider({ baseUrl: "http://localhost:11434/v1" });
      let streamed = "";
      const promise = provider.streamTurn({
        model: "m",
        systemPrompt: "s",
        messages: [],
        tools: [],
        onTextDelta: (t) => (streamed += t),
      });
      const assertion = expect(promise).rejects.toThrow(/stalled/);
      await vi.runAllTimersAsync();
      await assertion;

      expect(streamed).toBe("already shown");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up after exhausting retries on a mid-stream stall that never shows any text, surfacing the real timeout error", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        () =>
          Promise.resolve(
            new Response(
              new ReadableStream<Uint8Array>({
                start() {
                  // stalls immediately, every attempt
                },
              }),
              { status: 200 },
            ),
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

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

      expect(fetchMock).toHaveBeenCalledTimes(3);
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

  it(
    "warns and substitutes a __toolCallParseError marker (carrying the real JSON error) for malformed tool-call " +
      "arguments, instead of silently guessing an empty {}",
    async () => {
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

        expect(result.assistantMessage.toolCalls).toEqual([
          { id: "call_1", name: "edit_file", input: { __toolCallParseError: expect.any(String) } },
        ]);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("edit_file"));
      } finally {
        errorSpy.mockRestore();
      }
    },
  );

  it(
    "repairs tool-call arguments left open by a stream cut off for a reason OTHER than the length limit, instead of asking the model to redo the whole call",
    async () => {
      const events = [
        // A real disconnect mid-argument (finish_reason "stop", not "length") — the JSON never closed, but every open brace/bracket/quote here really is just left open, nothing else wrong with it.
        JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "write_file", arguments: '{"path":"a.txt","content":"hello' } }] } }],
        }),
        JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] }),
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

      expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "write_file", input: { path: "a.txt", content: "hello" } }]);
    },
  );

  it(
    "marks malformed tool-call arguments as truncated when finish_reason is 'length', instead of a plain {} — " +
      "real reported pattern: one huge file-write argument (a bash heredoc) cut off by the max output token limit",
    async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const events = [
          // Note the argument fragment never closes its JSON string/object —
          // exactly what a response cut off mid-argument looks like.
          JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "bash", arguments: '{"command": "cat > big.dart << \'EOF\'\\nclass Foo {' } }] } }],
          }),
          JSON.stringify({ choices: [{ delta: {}, finish_reason: "length" }] }),
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

        expect(result.assistantMessage.toolCalls).toEqual([{ id: "call_1", name: "bash", input: { __toolCallTruncated: true } }]);
      } finally {
        errorSpy.mockRestore();
      }
    },
  );
});
