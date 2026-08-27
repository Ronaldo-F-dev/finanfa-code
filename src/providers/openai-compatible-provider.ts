import type {
  LlmProvider,
  NeutralMessage,
  NeutralToolCall,
  StopReason,
  StreamTurnParams,
  StreamTurnResult,
  ToolDefinition,
} from "../core/types.js";
import { retryWithBackoff } from "../util/retry.js";

// A generic client for any server implementing the OpenAI chat-completions
// wire format: Ollama, OpenRouter, Poolside, LM Studio, vLLM, etc. all speak
// this same dialect at POST {baseUrl}/chat/completions.

type OpenAiContentPart = { type: "text"; text: string } | { type: "image_url"; image_url: { url: string } };

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | OpenAiContentPart[] | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

export function toOpenAiMessages(systemPrompt: string, messages: NeutralMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: "system", content: systemPrompt }];
  for (const m of messages) {
    if (m.role === "user") {
      if (!m.images?.length) {
        out.push({ role: "user", content: m.content });
      } else {
        const parts: OpenAiContentPart[] = [];
        if (m.content.length > 0) parts.push({ type: "text", text: m.content });
        for (const img of m.images) {
          parts.push({ type: "image_url", image_url: { url: `data:${img.mimeType};base64,${img.base64}` } });
        }
        out.push({ role: "user", content: parts });
      }
    } else if (m.role === "assistant") {
      out.push({
        role: "assistant",
        content: m.content.length > 0 ? m.content : null,
        tool_calls: m.toolCalls?.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        })),
      });
    } else {
      for (const r of m.results) {
        out.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }
    }
  }
  return out;
}

export function toOpenAiTools(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: tool.inputSchema },
  }));
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  return "other";
}

interface OpenAiStreamChunk {
  choices?: {
    delta?: {
      content?: string;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens: number; completion_tokens: number };
}

interface PendingToolCall {
  id?: string;
  name?: string;
  arguments: string;
}

interface ChatCompletionResult {
  content: string;
  toolCalls: NeutralToolCall[];
  finishReason: string | null;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

class RetryableHttpError extends Error {}

/**
 * The initial request, before any streaming has started — safe to redo from
 * scratch on a transient failure (network blip, rate limit, momentary 5xx).
 * Once we start reading the response body below, we never retry: some of it
 * may already be visible to the user, and redoing it would duplicate output.
 */
async function fetchInitialResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<Response> {
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ ...body, stream: true }),
      });
      if (RETRYABLE_STATUSES.has(response.status)) {
        const text = await response.text().catch(() => "");
        throw new RetryableHttpError(`OpenAI-compatible API error (${response.status}): ${text}`);
      }
      return response;
    },
    {
      attempts: 3,
      baseDelayMs: 500,
      // Node's fetch (undici) throws a TypeError for network-level failures
      // (connection refused, DNS, timeout) — worth retrying the same as a
      // transient HTTP status. Anything else (a programming error, an
      // unexpected exception type) is not assumed retryable.
      shouldRetry: (err) => err instanceof RetryableHttpError || err instanceof TypeError,
    },
  );
}

async function streamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onTextDelta: (text: string) => void,
): Promise<ChatCompletionResult> {
  const response = await fetchInitialResponse(url, headers, body);

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI-compatible API error (${response.status}): ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let finishReason: string | null = null;
  let usage: ChatCompletionResult["usage"];
  const pendingCalls = new Map<number, PendingToolCall>();

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]" || data.length === 0) continue;

      let chunk: OpenAiStreamChunk;
      try {
        chunk = JSON.parse(data) as OpenAiStreamChunk;
      } catch {
        continue;
      }

      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta ?? {};
      if (typeof delta.content === "string" && delta.content.length > 0) {
        content += delta.content;
        onTextDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const existing = pendingCalls.get(tc.index) ?? { arguments: "" };
        if (tc.id) existing.id = tc.id;
        if (tc.function?.name) existing.name = tc.function.name;
        if (tc.function?.arguments) existing.arguments += tc.function.arguments;
        pendingCalls.set(tc.index, existing);
      }
    }
  }

  const toolCalls: NeutralToolCall[] = [];
  for (const call of pendingCalls.values()) {
    if (!call.id || !call.name) continue;
    let input: unknown = {};
    try {
      input = call.arguments.length > 0 ? JSON.parse(call.arguments) : {};
    } catch {
      input = {};
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }

  return { content, toolCalls, finishReason, usage };
}

export interface OpenAiCompatibleProviderOptions {
  /** e.g. "http://localhost:11434/v1" (Ollama), "https://openrouter.ai/api/v1", "https://inference.poolside.ai/v1" */
  baseUrl: string;
  apiKey?: string;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(private readonly opts: OpenAiCompatibleProviderOptions) {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const headers: Record<string, string> = {};
    if (this.opts.apiKey) headers.Authorization = `Bearer ${this.opts.apiKey}`;

    const result = await streamChatCompletion(
      `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
      headers,
      {
        model: params.model,
        messages: toOpenAiMessages(params.systemPrompt, params.messages),
        tools: params.tools.length > 0 ? toOpenAiTools(params.tools) : undefined,
      },
      params.onTextDelta,
    );

    return {
      assistantMessage: {
        role: "assistant",
        content: result.content,
        toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined,
      },
      usage: {
        inputTokens: result.usage?.prompt_tokens ?? 0,
        outputTokens: result.usage?.completion_tokens ?? 0,
      },
      stopReason: mapFinishReason(result.finishReason),
    };
  }
}
