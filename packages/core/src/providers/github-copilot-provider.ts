import type { LlmProvider, StopReason, StreamTurnParams, StreamTurnResult } from "../core/types.js";
import { streamChatCompletion, toOpenAiMessages, toOpenAiTools } from "./openai-compatible-provider.js";

// GitHub Copilot's own chat-completions endpoint (api.githubcopilot.com) —
// an OpenAI-compatible wire format underneath (confirmed against every
// public, non-Microsoft-IDE Copilot client — copilot.vim, several open
// terminal-based Copilot clients — since GitHub itself doesn't publish a
// REST reference for it the way it does for the regular GitHub API), so
// this reuses OpenAiCompatibleProvider's own message/tool conversion and
// SSE-streaming primitives rather than duplicating them. The
// authentication is the genuinely different part: a GitHub OAuth token
// (obtained via github-copilot-auth.ts's device flow, never a raw personal
// access token) has to be exchanged for a short-lived Copilot API token
// before every request, refreshed automatically once it's close to
// expiring.
export interface GithubCopilotProviderOptions {
  /** A GitHub OAuth token with Copilot access — see github-copilot-auth.ts. Never sent to api.githubcopilot.com directly; only ever used to fetch a Copilot API token. */
  githubToken: string;
  /** Test-only override for the token-exchange endpoint (real default: https://api.github.com). */
  githubApiBaseUrl?: string;
  /** Test-only override for the chat-completions endpoint (real default: https://api.githubcopilot.com). */
  apiBaseUrl?: string;
}

interface CachedCopilotToken {
  token: string;
  expiresAtMs: number;
}

interface CopilotTokenResponse {
  token: string;
  expires_at: number;
}

function mapFinishReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_calls") return "tool_use";
  if (reason === "stop") return "end_turn";
  return "other";
}

export class GithubCopilotProvider implements LlmProvider {
  private cached?: CachedCopilotToken;

  constructor(private readonly opts: GithubCopilotProviderOptions) {}

  /** Exchanges the persisted GitHub token for a Copilot API token, reusing a cached one until shortly before it expires. */
  private async getCopilotToken(): Promise<string> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAtMs - 60_000 > now) return this.cached.token;

    const githubApiBaseUrl = this.opts.githubApiBaseUrl ?? "https://api.github.com";
    const response = await fetch(`${githubApiBaseUrl}/copilot_internal/v2/token`, {
      headers: { Authorization: `token ${this.opts.githubToken}`, "user-agent": "finanfa-code" },
    });
    if (!response.ok) {
      throw new Error(
        `Failed to exchange the GitHub token for a Copilot API token (HTTP ${response.status}) — the token may be expired or lack Copilot access.`,
      );
    }
    const data = (await response.json()) as CopilotTokenResponse;
    this.cached = { token: data.token, expiresAtMs: data.expires_at * 1000 };
    return data.token;
  }

  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const copilotToken = await this.getCopilotToken();
    const apiBaseUrl = (this.opts.apiBaseUrl ?? "https://api.githubcopilot.com").replace(/\/$/, "");

    const result = await streamChatCompletion(
      `${apiBaseUrl}/chat/completions`,
      {
        Authorization: `Bearer ${copilotToken}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "finanfa-code/1.0.0",
      },
      {
        model: params.model,
        messages: toOpenAiMessages(params.systemPrompt, params.messages),
        tools: params.tools.length > 0 ? toOpenAiTools(params.tools) : undefined,
        max_tokens: params.maxTokens ?? 8192,
      },
      params.onTextDelta,
      params.signal,
      true,
      params.onToolCallStart,
    );

    return {
      assistantMessage: { role: "assistant", content: result.content, toolCalls: result.toolCalls.length > 0 ? result.toolCalls : undefined },
      usage: { inputTokens: result.usage?.prompt_tokens ?? 0, outputTokens: result.usage?.completion_tokens ?? 0 },
      stopReason: result.toolCalls.length > 0 ? "tool_use" : mapFinishReason(result.finishReason),
    };
  }
}
