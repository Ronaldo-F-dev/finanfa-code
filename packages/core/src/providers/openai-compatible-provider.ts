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
 * Marks a mid-stream failure (idle timeout, dropped connection) as safe to
 * retry from scratch — thrown only when the read loop confirms zero text
 * has reached `onTextDelta` yet. Once any text has been shown to the user,
 * the original error propagates unwrapped and is never retried, since
 * redoing the request would duplicate what's already visible.
 */
class StreamNotYetVisibleError extends Error {
  constructor(readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

/**
 * The initial request, before any streaming has started — safe to redo from
 * scratch on a transient failure (network blip, rate limit, momentary 5xx).
 * Once we start reading the response body below, we never retry: some of it
 * may already be visible to the user, and redoing it would duplicate output.
 */
const REQUEST_TIMEOUT_MS = 60_000;
const STREAM_IDLE_TIMEOUT_MS = 60_000;

async function fetchInitialResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  return retryWithBackoff(
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ ...body, stream: true }),
        // Unlike bash.ts (ctx.signal + its own timeout/kill) and
        // http-request.ts (AbortSignal.timeout), this had no timeout at
        // all — a server that accepts the connection but never responds
        // (GPU/OOM stress on a local model server) hung the call forever,
        // with no way to recover short of killing the process. Combined
        // (not replaced) with the caller's own signal, e.g. a user
        // interrupt via loop.ts's streamController — either one aborts.
        signal: signal ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), signal]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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

async function attemptStreamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onTextDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  const response = await fetchInitialResponse(url, headers, body, signal);

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
    // A per-read idle timeout, not one overall timeout for the whole stream
    // — a long-but-healthy generation is fine, a server that stops sending
    // bytes mid-stream (stalls without closing the socket or ever sending a
    // terminal finish_reason) previously hung this read forever.
    let idleTimer: ReturnType<typeof setTimeout>;
    const idleTimeout = new Promise<never>((_, reject) => {
      idleTimer = setTimeout(
        () => reject(new Error(`No data received for ${STREAM_IDLE_TIMEOUT_MS}ms — the connection appears to have stalled.`)),
        STREAM_IDLE_TIMEOUT_MS,
      );
    });
    // Races the read against both the idle timeout and a user interrupt —
    // aborting the fetch above also errors the body stream, but that
    // rejection can lag; racing an explicit abort listener here makes a Stop
    // during a real generation take effect immediately instead of waiting
    // on the underlying stream to notice.
    const abortRace = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
          else signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
        })
      : undefined;
    let done: boolean, value: Uint8Array | undefined;
    try {
      ({ done, value } = await Promise.race([reader.read(), idleTimeout, ...(abortRace ? [abortRace] : [])]));
    } catch (err) {
      await reader.cancel().catch(() => {});
      // A deliberate interrupt must propagate as-is, not get wrapped as
      // "safe to retry" below — StreamNotYetVisibleError only means "no
      // output reached the user yet, redoing the request is harmless",
      // which is not true of a request the user explicitly asked to stop.
      if (signal?.aborted) throw err;
      // Nothing has reached onTextDelta yet at this point in the stream —
      // safe to redo the whole request from scratch instead of failing the
      // turn outright. Once content.length > 0 the original error propagates
      // unwrapped and streamChatCompletion below will not retry it.
      throw content.length === 0 ? new StreamNotYetVisibleError(err) : err;
    } finally {
      clearTimeout(idleTimer!);
    }
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
      // A truncated/malformed arguments fragment used to silently become
      // `{}` — e.g. an edit_file call missing its path, with no error
      // surfaced anywhere, so the model would see a confusing tool failure
      // (or worse, act on wrongly-empty input) with no hint why. Surfacing
      // it here at least makes it visible instead of a silent substitution.
      console.error(`Warning: malformed tool-call arguments for "${call.name}", treating as {}: ${call.arguments}`);
      input = {};
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }

  return { content, toolCalls, finishReason, usage };
}

async function streamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onTextDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<ChatCompletionResult> {
  try {
    return await retryWithBackoff(() => attemptStreamChatCompletion(url, headers, body, onTextDelta, signal), {
      attempts: 3,
      baseDelayMs: 500,
      // A deliberate interrupt must never be retried, regardless of error
      // shape — checked first so it can't accidentally match the
      // StreamNotYetVisibleError case below on its way out.
      shouldRetry: (err) => !signal?.aborted && err instanceof StreamNotYetVisibleError,
    });
  } catch (err) {
    // Unwrap so callers see the real underlying error (idle timeout, socket
    // reset), not our internal retry-eligibility marker.
    throw err instanceof StreamNotYetVisibleError ? err.cause : err;
  }
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
      params.signal,
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
      // If the connection ends without ever sending a terminal
      // finish_reason (e.g. it closes right after the last tool-call
      // fragment), mapFinishReason(null) resolves to "other" — the branch
      // in runTurn() for a non-tool_use stop then fires and any fully-formed
      // pending tool call is silently discarded. Trust the calls we actually
      // captured over a missing/absent finish_reason.
      stopReason: result.toolCalls.length > 0 ? "tool_use" : mapFinishReason(result.finishReason),
    };
  }
}
