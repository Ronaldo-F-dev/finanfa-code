export type ToolRiskLevel = "safe" | "ask" | "dangerous";

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
}

export interface ToolDefinition<TInput = any> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  riskLevel: ToolRiskLevel;
  handler: (input: TInput, ctx: ToolContext) => Promise<ToolResult>;
  /**
   * Derives a fine-grained permission key from the tool input (e.g. a bash
   * command prefix, or a file path) so "always allow" can scope narrower
   * than the whole tool. Defaults to the tool name if omitted.
   */
  riskKey?: (input: TInput) => string;
  /** Human-readable one-line summary of the action, shown in permission prompts. */
  describeCall?: (input: TInput) => string;
  /** Optional richer preview (e.g. a diff) shown above the permission prompt. */
  preview?: (input: TInput, ctx: ToolContext) => Promise<string>;
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

// --- Provider-agnostic conversation model -----------------------------
// Every LlmProvider speaks its own wire format (Anthropic content blocks,
// OpenAI-style tool_calls, ...). Sessions are persisted and the agent loop
// operates on this neutral shape instead, so swapping providers doesn't
// touch session storage or the loop itself.

export interface NeutralToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface NeutralToolResult {
  toolCallId: string;
  content: string;
  isError: boolean;
}

export type NeutralMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: NeutralToolCall[] }
  | { role: "tool"; results: NeutralToolResult[] };

export type StopReason = "tool_use" | "end_turn" | "other";

export interface StreamTurnParams {
  model: string;
  systemPrompt: string;
  messages: NeutralMessage[];
  tools: ToolDefinition[];
  onTextDelta: (text: string) => void;
}

export interface StreamTurnResult {
  assistantMessage: Extract<NeutralMessage, { role: "assistant" }>;
  usage: UsageTotals;
  stopReason: StopReason;
}

export interface LlmProvider {
  streamTurn(params: StreamTurnParams): Promise<StreamTurnResult>;
}
