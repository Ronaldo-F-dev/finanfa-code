import Anthropic from "@anthropic-ai/sdk";
import type {
  LlmProvider,
  NeutralMessage,
  NeutralToolCall,
  StopReason,
  StreamTurnParams,
  StreamTurnResult,
  ToolDefinition,
} from "../core/types.js";

type AnthropicImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/**
 * Marks the last content block of `message` as an ephemeral cache
 * breakpoint, converting bare string content to a one-block array first
 * (cache_control lives on a content block, not on the message itself).
 */
function markCacheBreakpoint(message: Anthropic.MessageParam): void {
  if (typeof message.content === "string") {
    message.content = [{ type: "text", text: message.content, cache_control: { type: "ephemeral" } }];
    return;
  }
  const last = message.content.at(-1);
  // We only ever construct text/tool_use/tool_result/image blocks above —
  // never thinking/redacted_thinking, the two block types that don't carry
  // cache_control — but guard narrowly rather than assume.
  if (last && last.type !== "thinking" && last.type !== "redacted_thinking") {
    last.cache_control = { type: "ephemeral" };
  }
}

export function toAnthropicMessages(messages: NeutralMessage[]): Anthropic.MessageParam[] {
  const out = messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      if (!m.images?.length) return { role: "user", content: m.content };
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const img of m.images) {
        blocks.push({
          type: "image",
          source: { type: "base64", media_type: img.mimeType as AnthropicImageMediaType, data: img.base64 },
        });
      }
      return { role: "user", content: blocks };
    }
    if (m.role === "assistant") {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.content.length > 0) blocks.push({ type: "text", text: m.content });
      for (const call of m.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input as Record<string, unknown> });
      }
      return { role: "assistant", content: blocks };
    }
    // role === "tool" → Anthropic expects tool_result blocks in a `user` message
    const blocks: Anthropic.ToolResultBlockParam[] = m.results.map((r) => ({
      type: "tool_result",
      tool_use_id: r.toolCallId,
      is_error: r.isError,
      content: r.content,
    }));
    return { role: "user", content: blocks };
  });

  // Cache everything up through the second-to-last message — the "stable"
  // prefix a growing multi-turn conversation already sent before — so only
  // the newest message is processed at full price on the next call, instead
  // of the entire history being reprocessed from scratch every turn. (system
  // prompt and tool list are already cached separately, see streamTurn/
  // toAnthropicTools below — this extends the same idea to the transcript,
  // which is usually the fastest-growing and costliest part in a long
  // tool-calling session.)
  const secondToLast = out.length >= 2 ? out.at(-2) : undefined;
  if (secondToLast) markCacheBreakpoint(secondToLast);

  return out;
}

export function toAnthropicTools(tools: ToolDefinition[]): Anthropic.Tool[] {
  const list: Anthropic.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  }));
  const last = list.at(-1);
  if (last) {
    // Cache the (stable, per-session) tool list — identical across every turn.
    last.cache_control = { type: "ephemeral" };
  }
  return list;
}

function mapStopReason(reason: Anthropic.Message["stop_reason"]): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "end_turn" || reason === "stop_sequence") return "end_turn";
  return "other";
}

export function fromAnthropicMessage(
  message: Anthropic.Message,
): Extract<NeutralMessage, { role: "assistant" }> {
  let content = "";
  const toolCalls: NeutralToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "text") content += block.text;
    if (block.type === "tool_use") toolCalls.push({ id: block.id, name: block.name, input: block.input });
  }
  return { role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined };
}

export class AnthropicProvider implements LlmProvider {
  private readonly client: Anthropic;

  constructor(apiKey?: string) {
    this.client = new Anthropic(apiKey ? { apiKey } : undefined);
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const anthropicTools = toAnthropicTools(params.tools);

    const stream = this.client.messages.stream({
      model: params.model,
      max_tokens: 8192,
      system: [{ type: "text", text: params.systemPrompt, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(params.messages),
      tools: anthropicTools.length > 0 ? anthropicTools : undefined,
    });

    stream.on("text", (delta) => params.onTextDelta(delta));
    const message = await stream.finalMessage();

    return {
      assistantMessage: fromAnthropicMessage(message),
      usage: { inputTokens: message.usage.input_tokens, outputTokens: message.usage.output_tokens },
      stopReason: mapStopReason(message.stop_reason),
    };
  }
}
