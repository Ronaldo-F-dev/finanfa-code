import { describe, expect, it } from "vitest";
import { toOpenAiMessages, toOpenAiTools } from "../../src/providers/openai-compatible-provider.js";
import type { NeutralMessage } from "../../src/core/types.js";
import type { ToolDefinition } from "../../src/core/types.js";

describe("openai-compatible-provider conversions", () => {
  it("prepends the system prompt and converts a plain user turn", () => {
    const messages: NeutralMessage[] = [{ role: "user", content: "hi" }];
    expect(toOpenAiMessages("be helpful", messages)).toEqual([
      { role: "system", content: "be helpful" },
      { role: "user", content: "hi" },
    ]);
  });

  it("converts an assistant tool call into OpenAI's tool_calls shape", () => {
    const messages: NeutralMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "read_file", input: { path: "a.txt" } }],
      },
    ];
    const [, converted] = toOpenAiMessages("sys", messages);
    expect(converted).toEqual({
      role: "assistant",
      content: null,
      tool_calls: [
        { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      ],
    });
  });

  it("converts a user message with images into OpenAI's image_url content parts", () => {
    const messages: NeutralMessage[] = [
      { role: "user", content: "look", images: [{ mimeType: "image/png", base64: "AAAA" }] },
    ];
    const [, converted] = toOpenAiMessages("sys", messages);
    expect(converted).toEqual({
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
      ],
    });
  });

  it("omits the text part when an image message has no text content", () => {
    const messages: NeutralMessage[] = [
      { role: "user", content: "", images: [{ mimeType: "image/jpeg", base64: "BBBB" }] },
    ];
    const [, converted] = toOpenAiMessages("sys", messages);
    expect(converted).toEqual({
      role: "user",
      content: [{ type: "image_url", image_url: { url: "data:image/jpeg;base64,BBBB" } }],
    });
  });

  it("expands a batched tool result message into one OpenAI 'tool' message per result", () => {
    const messages: NeutralMessage[] = [
      {
        role: "tool",
        results: [
          { toolCallId: "call_1", content: "contents", isError: false },
          { toolCallId: "call_2", content: "boom", isError: true },
        ],
      },
    ];
    const [, ...rest] = toOpenAiMessages("sys", messages);
    expect(rest).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "contents" },
      { role: "tool", tool_call_id: "call_2", content: "boom" },
    ]);
  });

  it("converts tool definitions into OpenAI function-tool shape", () => {
    const tools: ToolDefinition[] = [
      {
        name: "grep",
        description: "search",
        riskLevel: "safe",
        inputSchema: { type: "object", properties: { pattern: { type: "string" } } },
        handler: async () => ({ content: "", isError: false }),
      },
    ];
    expect(toOpenAiTools(tools)).toEqual([
      {
        type: "function",
        function: {
          name: "grep",
          description: "search",
          parameters: { type: "object", properties: { pattern: { type: "string" } } },
        },
      },
    ]);
  });
});
