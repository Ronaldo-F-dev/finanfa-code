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
import { repairTruncatedToolCallJson } from "./tool-call-json-repair.js";

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

// 429 deliberately excluded: with multiple API keys in play (see
// OpenAiCompatibleProvider.apiKeys below), a rate limit is exactly the
// signal that should move on to the NEXT key immediately, not spend 3
// backoff-delayed attempts hammering the same already-limited one first. A
// single-key setup still gets a sensible outcome either way — same
// immediate-throw-and-report path 401/403 already took before this existed.
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);

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
// 60s was too short for a real, reported case: switching to a local model
// (Docker Model Runner/Ollama) served through this provider timed out with
// "The operation was aborted due to timeout" — not a hung server, just a
// legitimate cold start (loading a multi-GB GGUF file from disk into RAM,
// no GPU) taking longer than a minute before the first token comes back.
// Raised generously rather than tuned tightly, since the whole point of
// this timeout is "eventually give up on a truly hung server" — a real
// remote API essentially never takes this long, so a well-behaved backend
// never notices the difference; only a local cold start or a genuinely
// stuck server does.
const REQUEST_TIMEOUT_MS = 300_000;
// Real, reported case: a small local model (MLX/llama.cpp-backed) composing
// a large tool call — an entire HTML/CSS file as a write_file argument —
// sent no bytes at all for over two minutes while still genuinely working
// (some local servers don't stream individual tokens while assembling a
// tool call, unlike plain text deltas), tripping this timeout and losing
// the whole turn's progress. 120s was tuned for "the connection actually
// stalled", not "a slow box is still legitimately generating a big
// response" — raised to match REQUEST_TIMEOUT_MS's own reasoning above:
// a real remote API's response never goes this long silent, so this only
// ever bites a genuinely stuck local server, not a slow-but-alive one.
// Still overridable (FINANFA_STREAM_IDLE_TIMEOUT_MS) for a setup slower
// than even this.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

async function fetchInitialResponse(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
  // A single-key setup still benefits from the old backoff-and-retry
  // behavior on 429 (a rate limit often clears within a couple seconds).
  // OpenAiCompatibleProvider passes false here whenever it has more than
  // one key in its pool, so a rate-limited key falls through to the outer
  // key-rotation logic (streamTurn) immediately instead of burning 3
  // backoff-delayed attempts on the same already-limited key first.
  retryOn429 = true,
): Promise<Response> {
  return retryWithBackoff(
    async () => {
      // Real, reported bug: AbortSignal.timeout(REQUEST_TIMEOUT_MS) passed
      // straight to fetch() doesn't just bound the wait for response
      // headers — the resulting signal stays attached to the fetch's
      // underlying connection for as long as its body is being read, so it
      // also aborted a healthy, still-streaming response the moment total
      // request duration (headers + the whole download) crossed 300s. A
      // small local model streaming a large HTML/CSS file plus its own
      // explanatory text legitimately took longer than that end to end and
      // got its connection killed mid-stream, discarding everything
      // already generated — indistinguishable from a genuinely stuck
      // server. A dedicated controller whose timer is cleared the moment
      // headers arrive means this only ever bounds time-to-first-byte, as
      // intended; STREAM_IDLE_TIMEOUT_MS below is what protects the body
      // read itself, and it resets on every chunk instead of capping total
      // duration.
      const ttfbController = new AbortController();
      const ttfbTimer = setTimeout(
        () => ttfbController.abort(new Error(`No response within ${REQUEST_TIMEOUT_MS}ms`)),
        REQUEST_TIMEOUT_MS,
      );
      let response: Response;
      try {
        response = await fetch(url, {
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
          signal: signal ? AbortSignal.any([ttfbController.signal, signal]) : ttfbController.signal,
        });
      } finally {
        clearTimeout(ttfbTimer);
      }
      const retryable = RETRYABLE_STATUSES.has(response.status) || (retryOn429 && response.status === 429);
      if (retryable) {
        const text = await response.text().catch(() => "");
        throw new RetryableHttpError(`OpenAI-compatible API error (${response.status}) from ${url} (model: ${body.model}): ${text}`);
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
  retryOn429 = true,
  onToolCallStart?: (call: { name: string }) => void,
  idleTimeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): Promise<ChatCompletionResult> {
  const response = await fetchInitialResponse(url, headers, body, signal, retryOn429);

  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => "");
    // Naming the exact url/model this request actually used is what makes a
    // "model not found"-style error from a self-hosted/local backend
    // (several available at once — Ollama, Docker Model Runner, a
    // configured remote one, ...) actionable instead of ambiguous about
    // which server or model string was really sent.
    throw new Error(`OpenAI-compatible API error (${response.status}) from ${url} (model: ${body.model}): ${text}`);
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
        () => reject(new Error(`No data received for ${idleTimeoutMs}ms — the connection appears to have stalled.`)),
        idleTimeoutMs,
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
        if (tc.function?.name && !existing.name) {
          existing.name = tc.function.name;
          onToolCallStart?.({ name: tc.function.name });
        }
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
    } catch (err) {
      if (finishReason === "length") {
        // Real reported pattern: a model repeatedly generating one huge
        // single tool call (e.g. an entire file's contents as one bash
        // heredoc argument) whose JSON never gets a chance to close because
        // the response hit its own max-output-token limit first — the SAME
        // failure then repeats near-identically across retries until the
        // loop guard gives up. Carried into a marker field (harmless to a
        // tool's own required-fields check — see loop.ts's
        // findMissingRequiredFields) so the tool_result the model sees can
        // name the real cause and actually recover (split into smaller
        // calls) instead of blindly retrying. Deliberately NOT attempting
        // JSON-nesting repair here even though it would often succeed
        // syntactically — the argument's own *content* (e.g. a half-written
        // file) is genuinely incomplete, and silently "fixing" the JSON
        // envelope around it would hide that from the model instead of
        // letting it recover correctly.
        console.error(`Warning: malformed tool-call arguments for "${call.name}", treating as {}: ${call.arguments}`);
        input = { __toolCallTruncated: true };
      } else {
        // Before falling back to a marker field asking the model to redo
        // the whole call: the single most common real cause of a parse
        // failure that ISN'T a length cutoff is the stream simply getting
        // cut off before the JSON closed (a dropped connection, a
        // mid-argument disconnect) — cheaply fixable by closing whatever
        // nesting was left open, without another full model turn. Only
        // ever "finishes" open nesting, never guesses at content, so a
        // genuine syntax error (not a truncation) correctly falls through
        // to the marker-field handling below instead of being silently
        // misrepaired.
        const repaired = repairTruncatedToolCallJson(call.arguments);
        if (repaired !== undefined) {
          toolCalls.push({ id: call.id, name: call.name, input: repaired });
          continue;
        }

        // A truncated/malformed arguments fragment used to silently become
        // `{}` — e.g. an edit_file call missing its path, with no error
        // surfaced anywhere, so the model would see a confusing tool failure
        // (or worse, act on wrongly-empty input) with no hint why. Surfacing
        // it here at least makes it visible instead of a silent substitution.
        console.error(`Warning: malformed tool-call arguments for "${call.name}", treating as {}: ${call.arguments}`);
        // Real reported pattern, distinct from the length case above: a
        // model producing a write_file call with a large/complex `content`
        // string whose own JSON escaping was wrong (an unescaped quote or
        // control character) — genuinely malformed JSON, not truncation.
        // The generic "missing required fields" message that used to be
        // the ONLY feedback here is technically accurate (the fields really
        // are absent from the {} fallback) but doesn't tell the model WHY —
        // observed for real: the model retried the identical broken call 3
        // times per turn, across 3 separate turns, never once fixing it,
        // because nothing ever told it the actual JSON syntax error. This
        // carries that real parser error through so loop.ts can surface it
        // instead.
        input = { __toolCallParseError: err instanceof Error ? err.message : String(err) };
      }
    }
    toolCalls.push({ id: call.id, name: call.name, input });
  }

  return { content, toolCalls, finishReason, usage };
}

/** Exported for AzureOpenAiProvider — Azure OpenAI speaks the same chat-completions wire format and SSE framing, differing only in URL construction (per-deployment path) and auth header (api-key, not Authorization: Bearer), so it reuses this instead of duplicating the whole request/SSE/retry pipeline. */
export async function streamChatCompletion(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  onTextDelta: (text: string) => void,
  signal?: AbortSignal,
  retryOn429 = true,
  onToolCallStart?: (call: { name: string }) => void,
  idleTimeoutMs: number = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
): Promise<ChatCompletionResult> {
  try {
    return await retryWithBackoff(
      () => attemptStreamChatCompletion(url, headers, body, onTextDelta, signal, retryOn429, onToolCallStart, idleTimeoutMs),
      {
        attempts: 3,
        baseDelayMs: 500,
        // A deliberate interrupt must never be retried, regardless of error
        // shape — checked first so it can't accidentally match the
        // StreamNotYetVisibleError case below on its way out.
        shouldRetry: (err) => !signal?.aborted && err instanceof StreamNotYetVisibleError,
      },
    );
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
  /**
   * Multiple API keys sharing the same baseUrl/model — e.g. a community
   * that pooled their own individual free-tier keys for a shared model, so
   * the tool keeps working for everyone even once any single person's key
   * is rate-limited or exhausted. Takes priority over `apiKey` when
   * non-empty. Tried starting from whichever key last worked (not always
   * from the front), advancing to the next only on a key-specific failure
   * (401/402/403/429) — not on a transient 5xx or network error, which
   * switching keys wouldn't fix anyway since they share the same endpoint.
   */
  apiKeys?: string[];
  /**
   * Overrides DEFAULT_STREAM_IDLE_TIMEOUT_MS — for a local server even
   * slower than that generous default to compose a large tool call with no
   * intermediate bytes. Set from FINANFA_STREAM_IDLE_TIMEOUT_MS in app.ts.
   */
  streamIdleTimeoutMs?: number;
}

// Statuses that mean "this credential specifically is the problem"
// (unauthorized, payment/quota required, rate-limited) — worth moving to
// the next key in the pool for. Anything else (a transient 5xx, a network
// failure, a malformed request) would fail identically on every key sharing
// the same baseUrl, so rotating wouldn't help and isn't attempted.
const KEY_ROTATION_STATUSES = new Set([401, 402, 403, 429]);

const HTTP_STATUS_PATTERN = /\((\d{3})\)/;

function extractHttpStatus(message: string): number | undefined {
  const match = HTTP_STATUS_PATTERN.exec(message);
  return match ? Number(match[1]) : undefined;
}

export class OpenAiCompatibleProvider implements LlmProvider {
  private readonly keys: string[];
  // Persists across calls on the same provider instance (one per session)
  // so a key that just proved dead isn't retried first on every subsequent
  // turn — once rotation lands on a working key, later calls start there.
  private keyIndex = 0;

  constructor(private readonly opts: OpenAiCompatibleProviderOptions) {
    this.keys = opts.apiKeys && opts.apiKeys.length > 0 ? opts.apiKeys : opts.apiKey ? [opts.apiKey] : [];
  }

  /** So a caller (loop.ts's "model not found" recovery) can query this same server's /models. */
  get baseUrl(): string {
    return this.opts.baseUrl;
  }

  get apiKey(): string | undefined {
    return this.keys[0];
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const attempts = Math.max(this.keys.length, 1);
    let lastError: unknown;

    for (let i = 0; i < attempts; i++) {
      const key = this.keys[this.keyIndex];
      const headers: Record<string, string> = {};
      if (key) headers.Authorization = `Bearer ${key}`;

      try {
        const result = await streamChatCompletion(
          `${this.opts.baseUrl.replace(/\/$/, "")}/chat/completions`,
          headers,
          {
            model: params.model,
            messages: toOpenAiMessages(params.systemPrompt, params.messages),
            tools: params.tools.length > 0 ? toOpenAiTools(params.tools) : undefined,
            // Real reported bug: a fresh session with no effort tier picked
            // (session.maxTokens stays undefined) sent no max_tokens field
            // at all — JSON.stringify just drops an undefined value — so
            // whatever conservative default the remote OpenAI-compatible
            // server itself applies took over silently. Against Poolside,
            // that was small enough to truncate a single large file-write
            // tool call mid-argument, over and over, no matter how many
            // times the earlier truncation fixes helped the model recover.
            // anthropic-provider.ts already falls back to 8192 the same way
            // (params.maxTokens ?? 8192) — this had never been given the
            // same fallback, so the two providers behaved differently for
            // the exact same "nothing configured" state. 8192 matches both
            // that and the "high" effort tier's own value.
            max_tokens: params.maxTokens ?? 8192,
          },
          params.onTextDelta,
          params.signal,
          this.keys.length <= 1,
          params.onToolCallStart,
          this.opts.streamIdleTimeoutMs,
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
      } catch (err) {
        lastError = err;
        // extractHttpStatus only ever matches a status this provider itself
        // embedded in a message before any streaming began (fetchInitialResponse's
        // own status check) — never a mid-stream failure, so rotating here
        // can't duplicate output that already reached the user.
        const status = err instanceof Error ? extractHttpStatus(err.message) : undefined;
        if (this.keys.length > 1 && status !== undefined && KEY_ROTATION_STATUSES.has(status)) {
          this.keyIndex = (this.keyIndex + 1) % this.keys.length;
          continue;
        }
        throw err;
      }
    }
    throw lastError;
  }
}

// Every real OpenAI-compatible server this project talks to (Ollama, LM
// Studio, vLLM, MLX's own server, ...) also serves GET {baseUrl}/models —
// used only for the "model not found" recovery message in loop.ts, so a
// user pointed at the wrong port/model name sees what that server actually
// has instead of a bare 404. Best-effort: any failure here (server doesn't
// implement it, network error) just means no suggestion, never a thrown error.
export async function listAvailableModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/models`, { headers });
    if (!res.ok) return [];
    const body = (await res.json()) as { data?: { id?: string }[] };
    return (body.data ?? []).map((m) => m.id).filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}
