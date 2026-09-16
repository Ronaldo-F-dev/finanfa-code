import { describe, expect, it, vi } from "vitest";
import { toAnthropicMessages, fromAnthropicMessage, streamAnthropicTurn, type AnthropicMessagesClient } from "../../src/providers/anthropic-provider.js";
import type { NeutralMessage, StreamTurnParams } from "../../src/core/types.js";
import type Anthropic from "@anthropic-ai/sdk";

/** A fake AnthropicMessagesClient — narrow enough (see that interface's own comment) to double without touching the real SDK/network. Captures the exact request `client.messages.stream` was called with. */
function fakeClient(finalMessage: Partial<Anthropic.Message>): { client: AnthropicMessagesClient; lastRequest: () => Record<string, unknown> | undefined } {
  let lastRequest: Record<string, unknown> | undefined;
  const client: AnthropicMessagesClient = {
    messages: {
      stream: ((request: Record<string, unknown>) => {
        lastRequest = request;
        return {
          on: () => {},
          finalMessage: () => Promise.resolve({ content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn", ...finalMessage }),
        };
      }) as unknown as Anthropic["messages"]["stream"],
    },
  };
  return { client, lastRequest: () => lastRequest };
}

function baseParams(overrides: Partial<StreamTurnParams> = {}): StreamTurnParams {
  return { model: "m", systemPrompt: "s", messages: [], tools: [], onTextDelta: () => {}, ...overrides };
}

describe("anthropic-provider conversions", () => {
  it("converts a user message", () => {
    const neutral: NeutralMessage[] = [{ role: "user", content: "hello" }];
    expect(toAnthropicMessages(neutral)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("converts an assistant message with text and tool calls to content blocks", () => {
    const neutral: NeutralMessage[] = [
      {
        role: "assistant",
        content: "let me check",
        toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.txt" } }],
      },
    ];
    expect(toAnthropicMessages(neutral)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "let me check" },
          { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" } },
        ],
      },
    ]);
  });

  it("converts a user message with images into text + image content blocks", () => {
    const neutral: NeutralMessage[] = [
      {
        role: "user",
        content: "(image result from the tool call above)",
        images: [{ mimeType: "image/png", base64: "AAAA" }],
      },
    ];
    expect(toAnthropicMessages(neutral)).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "(image result from the tool call above)" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
        ],
      },
    ]);
  });

  it("omits the text block when an image message has no text content", () => {
    const neutral: NeutralMessage[] = [
      { role: "user", content: "", images: [{ mimeType: "image/jpeg", base64: "BBBB" }] },
    ];
    expect(toAnthropicMessages(neutral)).toEqual([
      {
        role: "user",
        content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } }],
      },
    ]);
  });

  it("converts a tool result message into a user message with tool_result blocks", () => {
    const neutral: NeutralMessage[] = [
      { role: "tool", results: [{ toolCallId: "t1", content: "file contents", isError: false }] },
    ];
    expect(toAnthropicMessages(neutral)).toEqual([
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "t1", is_error: false, content: "file contents" }],
      },
    ]);
  });

  it("marks a cache breakpoint on the second-to-last message, not the last", () => {
    const neutral: NeutralMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const out = toAnthropicMessages(neutral);

    expect(out[0].content).toEqual([{ type: "text", text: "first", cache_control: { type: "ephemeral" } }]);
    // The newest message is left as plain content — nothing to cache yet, it's new every call.
    expect(out[1].content).toEqual([{ type: "text", text: "second" }]);
  });

  it("marks the cache breakpoint on the LAST block when the second-to-last message has multiple blocks", () => {
    const neutral: NeutralMessage[] = [
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "t1", name: "read_file", input: { path: "a.txt" } }],
      },
      { role: "tool", results: [{ toolCallId: "t1", content: "file contents", isError: false }] },
    ];
    const out = toAnthropicMessages(neutral);

    expect(out[0].content).toEqual([
      { type: "text", text: "checking" },
      { type: "tool_use", id: "t1", name: "read_file", input: { path: "a.txt" }, cache_control: { type: "ephemeral" } },
    ]);
  });

  it("does not add a cache breakpoint for a single-message conversation", () => {
    const neutral: NeutralMessage[] = [{ role: "user", content: "hello" }];
    expect(toAnthropicMessages(neutral)).toEqual([{ role: "user", content: "hello" }]);
  });

  it("moves the cache breakpoint forward as the conversation grows (incremental caching)", () => {
    const turnOne: NeutralMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ];
    const turnTwo: NeutralMessage[] = [...turnOne, { role: "user", content: "third" }];

    const outOne = toAnthropicMessages(turnOne);
    const outTwo = toAnthropicMessages(turnTwo);

    // Call 1 marks a breakpoint after "first". Call 2 moves the (single)
    // breakpoint forward to "second" — Anthropic's cache lookup matches the
    // longest previously-cached prefix under that new breakpoint, so the
    // "first" portion is still a cache read even though it's no longer
    // marked directly; only "third" (after the new breakpoint) is fresh.
    expect(outOne[0].content).toEqual([{ type: "text", text: "first", cache_control: { type: "ephemeral" } }]);
    expect(outTwo[0].content).toBe("first");
    expect(outTwo[1].content).toEqual([{ type: "text", text: "second", cache_control: { type: "ephemeral" } }]);
    expect(outTwo[2].content).toBe("third");
  });

  it("converts an Anthropic response back into a neutral assistant message", () => {
    const message = {
      content: [
        { type: "text", text: "done" },
        { type: "tool_use", id: "t2", name: "bash", input: { command: "ls" } },
      ],
    } as unknown as Anthropic.Message;

    expect(fromAnthropicMessage(message)).toEqual({
      role: "assistant",
      content: "done",
      toolCalls: [{ id: "t2", name: "bash", input: { command: "ls" } }],
    });
  });

  it("captures a real thinking block (with its signature) alongside a tool call", () => {
    const message = {
      content: [
        { type: "thinking", thinking: "let me work this out...", signature: "sig-abc" },
        { type: "tool_use", id: "t3", name: "bash", input: { command: "ls" } },
      ],
    } as unknown as Anthropic.Message;

    expect(fromAnthropicMessage(message)).toEqual({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "t3", name: "bash", input: { command: "ls" } }],
      thinkingBlocks: [{ type: "thinking", thinking: "let me work this out...", signature: "sig-abc" }],
    });
  });

  it("captures an opaque redacted_thinking block unmodified", () => {
    const message = { content: [{ type: "redacted_thinking", data: "opaque-blob" }, { type: "text", text: "done" }] } as unknown as Anthropic.Message;
    expect(fromAnthropicMessage(message).thinkingBlocks).toEqual([{ type: "redacted_thinking", data: "opaque-blob" }]);
  });

  it("replays thinkingBlocks back as the first content block(s), ahead of text/tool_use — required for Anthropic to accept the next request in the same turn", () => {
    const neutral: NeutralMessage[] = [
      {
        role: "assistant",
        content: "checking",
        toolCalls: [{ id: "t1", name: "bash", input: { command: "ls" } }],
        thinkingBlocks: [{ type: "thinking", thinking: "reasoning...", signature: "sig-1" }],
      },
    ];
    expect(toAnthropicMessages(neutral)).toEqual([
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "reasoning...", signature: "sig-1" },
          { type: "text", text: "checking" },
          { type: "tool_use", id: "t1", name: "bash", input: { command: "ls" } },
        ],
      },
    ]);
  });
});

describe("streamAnthropicTurn — extended thinking", () => {
  it("enables thinking with the given budget when it's valid (≥1024, below max_tokens)", async () => {
    const { client, lastRequest } = fakeClient({});
    await streamAnthropicTurn(client, baseParams({ thinkingBudgetTokens: 2048, maxTokens: 4096 }));
    expect(lastRequest()?.thinking).toEqual({ type: "enabled", budget_tokens: 2048 });
  });

  it("does not enable thinking when unset (default — zero behavior change)", async () => {
    const { client, lastRequest } = fakeClient({});
    await streamAnthropicTurn(client, baseParams());
    expect(lastRequest()?.thinking).toBeUndefined();
  });

  it("does not enable thinking when the budget is below Anthropic's own 1024 minimum", async () => {
    const { client, lastRequest } = fakeClient({});
    await streamAnthropicTurn(client, baseParams({ thinkingBudgetTokens: 100, maxTokens: 4096 }));
    expect(lastRequest()?.thinking).toBeUndefined();
  });

  it("does not enable thinking when the budget isn't strictly less than max_tokens — would guarantee a 400", async () => {
    const { client, lastRequest } = fakeClient({});
    await streamAnthropicTurn(client, baseParams({ thinkingBudgetTokens: 4096, maxTokens: 4096 }));
    expect(lastRequest()?.thinking).toBeUndefined();
  });

  it("streams thinking deltas through onThinkingDelta when provided", async () => {
    const client: AnthropicMessagesClient = {
      messages: {
        stream: (() => {
          const handlers = new Map<string, (delta: string) => void>();
          return {
            on: (event: string, cb: (delta: string) => void) => handlers.set(event, cb),
            finalMessage: async () => {
              handlers.get("thinking")?.("partial thought");
              return { content: [], usage: { input_tokens: 1, output_tokens: 1 }, stop_reason: "end_turn" } as unknown as Anthropic.Message;
            },
          };
        }) as unknown as Anthropic["messages"]["stream"],
      },
    };
    const onThinkingDelta = vi.fn();
    await streamAnthropicTurn(client, baseParams({ thinkingBudgetTokens: 2048, maxTokens: 4096, onThinkingDelta }));
    expect(onThinkingDelta).toHaveBeenCalledWith("partial thought");
  });
});
