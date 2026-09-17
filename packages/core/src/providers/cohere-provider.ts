import { CohereClientV2, Cohere } from "cohere-ai";
import type {
  LlmProvider,
  NeutralMessage,
  NeutralToolCall,
  StopReason,
  StreamTurnParams,
  StreamTurnResult,
  ToolDefinition,
} from "../core/types.js";
import { repairTruncatedToolCallJson } from "./tool-call-json-repair.js";

// Cohere's Chat API v2 (api.cohere.com/v2/chat) — genuinely distinct from
// the OpenAI/Anthropic wire formats already spoken here: the system
// prompt is just another message in the array (role "system", not a
// separate top-level field), tool results are their own message role
// ("tool", keyed by toolCallId) rather than folded into a user turn the
// way Anthropic's tool_result blocks are, and streaming tool-call
// arguments arrive as a raw accumulating JSON string per call rather
// than as OpenAI-style indexed deltas. Confirmed against the real
// `cohere-ai` npm SDK's own type definitions before writing this, same
// as every other from-scratch provider here (see gemini-provider.ts's
// own comment on why that matters).

export function toCohereMessages(systemPrompt: string, messages: NeutralMessage[]): Cohere.ChatMessageV2[] {
  const out: Cohere.ChatMessageV2[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      out.push({ role: "user", content: m.content });
      continue;
    }
    if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content.length > 0 ? m.content : undefined,
        toolCalls: m.toolCalls?.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.input ?? {}) },
        })),
      });
      continue;
    }
    // role === "tool" — Cohere wants one "tool" message per tool_result, not a batch.
    for (const result of m.results) {
      out.push({ role: "tool", toolCallId: result.toolCallId, content: result.content });
    }
  }
  return out;
}

export function toCohereTools(tools: ToolDefinition[]): Cohere.ToolV2[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema as Record<string, unknown> },
  }));
}

function mapStopReason(reason: Cohere.ChatFinishReason | undefined): StopReason {
  if (reason === Cohere.ChatFinishReason.ToolCall) return "tool_use";
  if (reason === Cohere.ChatFinishReason.Complete || reason === Cohere.ChatFinishReason.StopSequence) return "end_turn";
  return "other";
}

/** Accumulates one in-progress tool call's streamed id/name/arguments-so-far, keyed by Cohere's own per-event `index`. */
interface PendingToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

function finalizeToolCalls(pending: Map<number, PendingToolCall>, rawFinishReason: Cohere.ChatFinishReason | undefined): NeutralToolCall[] {
  const calls: NeutralToolCall[] = [];
  for (const call of pending.values()) {
    let input: unknown = {};
    try {
      input = call.argumentsJson.trim() ? JSON.parse(call.argumentsJson) : {};
    } catch {
      // Same reasoning as OpenAiCompatibleProvider's own tool-call JSON
      // handling: a stream cut off mid-argument for a reason OTHER than
      // hitting the model's own max-token limit is usually just
      // unclosed nesting — cheaply fixable without another full model
      // turn. Skipped specifically on MaxTokens: there the argument's
      // own *content* (not just its JSON envelope) is genuinely
      // incomplete, and silently closing the JSON around it would hide
      // that from the model instead of letting it recover correctly.
      const repaired = rawFinishReason !== Cohere.ChatFinishReason.MaxTokens ? repairTruncatedToolCallJson(call.argumentsJson) : undefined;
      // A provider streaming malformed JSON is the agent loop's problem to
      // reject (see findMissingRequiredFields/JSON-parse handling in
      // loop.ts) the same way a malformed OpenAI/Anthropic tool call
      // already is — not this function's to silently paper over.
      input = repaired !== undefined ? repaired : { __unparsable_arguments__: call.argumentsJson };
    }
    calls.push({ id: call.id, name: call.name, input });
  }
  return calls;
}

export class CohereProvider implements LlmProvider {
  private readonly client: CohereClientV2;

  constructor(apiKey?: string, baseUrl?: string) {
    this.client = new CohereClientV2({ token: apiKey ?? "", ...(baseUrl ? { environment: baseUrl } : {}) });
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const stream = await this.client.chatStream(
      {
        model: params.model,
        messages: toCohereMessages(params.systemPrompt, params.messages),
        tools: params.tools.length > 0 ? toCohereTools(params.tools) : undefined,
        maxTokens: params.maxTokens,
      },
      { abortSignal: params.signal },
    );

    let content = "";
    const pendingToolCalls = new Map<number, PendingToolCall>();
    let stopReason: StopReason = "other";
    let rawFinishReason: Cohere.ChatFinishReason | undefined;
    let usage = { inputTokens: 0, outputTokens: 0 };

    for await (const event of stream) {
      if (event.type === "content-delta") {
        const delta = event.delta?.message?.content?.text;
        if (delta) {
          content += delta;
          params.onTextDelta(delta);
        }
      } else if (event.type === "tool-call-start") {
        const call = event.delta?.message?.toolCalls;
        if (call?.id) {
          pendingToolCalls.set(event.index ?? 0, { id: call.id, name: call.function?.name ?? "", argumentsJson: call.function?.arguments ?? "" });
          if (call.function?.name) params.onToolCallStart?.({ name: call.function.name });
        }
      } else if (event.type === "tool-call-delta") {
        const existing = pendingToolCalls.get(event.index ?? 0);
        const argsDelta = event.delta?.message?.toolCalls?.function?.arguments;
        if (existing && argsDelta) existing.argumentsJson += argsDelta;
      } else if (event.type === "message-end") {
        rawFinishReason = event.delta?.finishReason;
        stopReason = mapStopReason(rawFinishReason);
        usage = { inputTokens: event.delta?.usage?.tokens?.inputTokens ?? 0, outputTokens: event.delta?.usage?.tokens?.outputTokens ?? 0 };
      }
    }

    const toolCalls = finalizeToolCalls(pendingToolCalls, rawFinishReason);
    return {
      assistantMessage: { role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
      usage,
      stopReason,
    };
  }
}
