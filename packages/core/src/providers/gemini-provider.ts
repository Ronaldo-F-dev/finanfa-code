import { randomUUID } from "node:crypto";
import type {
  LlmProvider,
  NeutralMessage,
  NeutralToolCall,
  StopReason,
  StreamTurnParams,
  StreamTurnResult,
  ToolDefinition,
} from "../core/types.js";

// A real, standalone provider for Google's Gemini API
// (generativelanguage.googleapis.com) — genuinely different from the
// OpenAI/Anthropic wire formats this project already speaks (role names,
// function-call/response shape, SSE framing), unlike Mistral (whose API
// is largely OpenAI-compatible already, so it works via
// OpenAiCompatibleProvider with no new code) or a would-be Azure OpenAI
// provider (mostly a header/URL variant of the same OpenAI format). Not
// hand-rolled for the sake of it — a real REST/SSE API with its own
// genuinely distinct schema (confirmed against Google's own API
// reference before writing this), same as this project's other
// from-scratch protocol implementations.
//
// Deliberately excludes AWS Bedrock from this pass: testing Bedrock for
// real would need either a live AWS account (real cost, real
// credentials — not appropriate to spin up for this) or mocking the AWS
// SDK's client at the command level, which this project's testing
// convention has consistently avoided in favor of real fake servers.
// Revisit if a safe, real way to test it shows up.

interface GeminiTextPart {
  text: string;
}
interface GeminiFunctionCallPart {
  functionCall: { name: string; args: unknown };
}
interface GeminiFunctionResponsePart {
  functionResponse: { name: string; response: unknown };
}
type GeminiPart = GeminiTextPart | GeminiFunctionCallPart | GeminiFunctionResponsePart;

interface GeminiContent {
  role: "user" | "model";
  parts: GeminiPart[];
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[]; role?: string };
  finishReason?: string;
}

interface GeminiResponseChunk {
  candidates?: GeminiCandidate[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
}

function isFunctionCallPart(part: GeminiPart): part is GeminiFunctionCallPart {
  return "functionCall" in part;
}

/** Maps our synthetic tool-call ids (Gemini itself has no id concept for function calls) back to the function name Gemini needs in a functionResponse part — built by scanning every assistant message's toolCalls as they're converted. */
function buildToolCallIdToName(messages: NeutralMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && m.toolCalls) {
      for (const call of m.toolCalls) map.set(call.id, call.name);
    }
  }
  return map;
}

export function toGeminiContents(messages: NeutralMessage[]): GeminiContent[] {
  const idToName = buildToolCallIdToName(messages);
  const out: GeminiContent[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      const parts: GeminiPart[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      // Images: Gemini expects inline_data with base64 — not carried
      // through here since NeutralImage handling would need a part shape
      // this pass doesn't add test coverage for; a user turn with no
      // text and only images would produce an empty parts array, which
      // the caller should avoid sending (matches this project's existing
      // "images are handled by whichever provider actually needs them"
      // scoping elsewhere).
      out.push({ role: "user", parts });
    } else if (m.role === "assistant") {
      const parts: GeminiPart[] = [];
      if (m.content.length > 0) parts.push({ text: m.content });
      for (const call of m.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: call.input ?? {} } });
      out.push({ role: "model", parts });
    } else {
      const parts: GeminiPart[] = m.results.map((r) => ({
        functionResponse: {
          name: idToName.get(r.toolCallId) ?? "unknown",
          response: r.isError ? { error: r.content } : { result: r.content },
        },
      }));
      out.push({ role: "user", parts });
    }
  }
  return out;
}

export function toGeminiTools(tools: ToolDefinition[]) {
  if (tools.length === 0) return undefined;
  return [{ functionDeclarations: tools.map((t) => ({ name: t.name, description: t.description, parameters: t.inputSchema })) }];
}

function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): StopReason {
  if (hasToolCalls) return "tool_use";
  if (reason === "STOP") return "end_turn";
  return "other";
}

/**
 * A minimal, spec-correct SSE event parser (not a naive per-line "data:"
 * split): Gemini's own streaming responses are known to sometimes
 * pretty-print a single event's JSON across multiple physical lines, so
 * per-event `data:` lines must be accumulated and joined until a blank
 * line (the real event boundary) before parsing, exactly as the SSE spec
 * describes — a naive line-by-line split silently truncates/corrupts a
 * multi-line event.
 */
export function parseSseEvents(chunkText: string, dataLineBuffer: string[]): { events: string[]; remainder: string } {
  const events: string[] = [];
  const lines = chunkText.split("\n");
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (line === "") {
      if (dataLineBuffer.length > 0) {
        events.push(dataLineBuffer.join("\n"));
        dataLineBuffer.length = 0;
      }
    } else if (line.startsWith("data:")) {
      dataLineBuffer.push(line.slice(5).trimStart());
    }
    // Any other SSE field (event:, id:, comments starting with ':') is ignored — this API only ever sends `data:`.
  }
  return { events, remainder };
}

export interface GeminiProviderOptions {
  apiKey: string;
  baseUrl?: string; // for tests — defaults to the real API
}

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const REQUEST_TIMEOUT_MS = 60_000;

export class GeminiProvider implements LlmProvider {
  constructor(private readonly opts: GeminiProviderOptions) {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const baseUrl = (this.opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    const url = `${baseUrl}/v1beta/models/${encodeURIComponent(params.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.opts.apiKey)}`;

    const body = {
      systemInstruction: { parts: [{ text: params.systemPrompt }] },
      contents: toGeminiContents(params.messages),
      tools: toGeminiTools(params.tools),
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: params.signal ? AbortSignal.any([AbortSignal.timeout(REQUEST_TIMEOUT_MS), params.signal]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      throw new Error(`Gemini API error (${response.status}): ${text}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const dataLineBuffer: string[] = [];
    let buffer = "";
    let content = "";
    let finishReason: string | undefined;
    let promptTokens = 0;
    let candidateTokens = 0;
    const toolCalls: NeutralToolCall[] = [];

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, remainder } = parseSseEvents(buffer, dataLineBuffer);
      buffer = remainder;

      for (const eventData of events) {
        if (eventData.length === 0) continue;
        let chunk: GeminiResponseChunk;
        try {
          chunk = JSON.parse(eventData) as GeminiResponseChunk;
        } catch {
          continue;
        }
        if (chunk.usageMetadata) {
          promptTokens = chunk.usageMetadata.promptTokenCount ?? promptTokens;
          candidateTokens = chunk.usageMetadata.candidatesTokenCount ?? candidateTokens;
        }
        const candidate = chunk.candidates?.[0];
        if (!candidate) continue;
        if (candidate.finishReason) finishReason = candidate.finishReason;
        for (const part of candidate.content?.parts ?? []) {
          if ("text" in part && part.text.length > 0) {
            content += part.text;
            params.onTextDelta(part.text);
          } else if (isFunctionCallPart(part)) {
            toolCalls.push({ id: randomUUID(), name: part.functionCall.name, input: part.functionCall.args });
          }
        }
      }
    }

    return {
      assistantMessage: { role: "assistant", content, toolCalls: toolCalls.length > 0 ? toolCalls : undefined },
      usage: { inputTokens: promptTokens, outputTokens: candidateTokens },
      stopReason: mapFinishReason(finishReason, toolCalls.length > 0),
    };
  }
}
