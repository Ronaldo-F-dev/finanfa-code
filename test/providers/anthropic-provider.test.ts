import { describe, expect, it } from "vitest";
import { toAnthropicMessages, fromAnthropicMessage } from "../../src/providers/anthropic-provider.js";
import type { NeutralMessage } from "../../src/core/types.js";
import type Anthropic from "@anthropic-ai/sdk";

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
});
