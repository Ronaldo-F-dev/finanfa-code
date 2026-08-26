import type Anthropic from "@anthropic-ai/sdk";

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
}

export interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
}

export type AnthropicMessageParam = Anthropic.MessageParam;
