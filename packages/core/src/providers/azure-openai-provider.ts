import type { LlmProvider, StreamTurnResult, StreamTurnParams } from "../core/types.js";
import { toOpenAiMessages, toOpenAiTools, streamChatCompletion } from "./openai-compatible-provider.js";

// Azure OpenAI Service — speaks the same chat-completions wire format and
// SSE framing as OpenAiCompatibleProvider (reused directly, see that
// file's streamChatCompletion export), differing only in how the request
// is addressed: a per-deployment URL path instead of a flat /chat/
// completions, an explicit api-version query param, and an `api-key`
// auth header instead of `Authorization: Bearer` — genuinely not the
// same as Mistral (already OpenAI-compatible enough to just use
// OpenAiCompatibleProvider directly with no new code) or worth a full
// separate provider the way Gemini's actually-different API needed.
//
// `params.model` (the same field every other provider in this project
// uses as its own model identifier) is used directly as the Azure
// deployment name — Azure's routing is deployment-based, not model-name
// based, so whatever deployment the user configured/named is what
// belongs there.
export interface AzureOpenAiProviderOptions {
  apiKey: string;
  /** e.g. "https://my-resource.openai.azure.com" — no trailing path. */
  endpoint: string;
  /** Defaults to a recent stable Azure OpenAI API version. */
  apiVersion?: string;
}

const DEFAULT_API_VERSION = "2024-10-21";

export class AzureOpenAiProvider implements LlmProvider {
  constructor(private readonly opts: AzureOpenAiProviderOptions) {}

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const endpoint = this.opts.endpoint.replace(/\/$/, "");
    const apiVersion = this.opts.apiVersion ?? DEFAULT_API_VERSION;
    const url = `${endpoint}/openai/deployments/${encodeURIComponent(params.model)}/chat/completions?api-version=${encodeURIComponent(apiVersion)}`;

    const result = await streamChatCompletion(
      url,
      { "api-key": this.opts.apiKey },
      {
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
      stopReason: result.toolCalls.length > 0 ? "tool_use" : result.finishReason === "stop" ? "end_turn" : "other",
    };
  }
}
