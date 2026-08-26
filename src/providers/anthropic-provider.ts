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

export function toAnthropicMessages(messages: NeutralMessage[]): Anthropic.MessageParam[] {
  return messages.map((m): Anthropic.MessageParam => {
    if (m.role === "user") {
      return { role: "user", content: m.content };
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
