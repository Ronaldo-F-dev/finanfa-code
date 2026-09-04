import type { EditHistory } from "./edit-history.js";
import type { TodoStore } from "./todo-store.js";
import type { FileFreshnessTracker } from "./file-freshness.js";
import type { UIAdapter } from "../ui/adapter.js";

export type ToolRiskLevel = "safe" | "ask" | "dangerous";

export interface JsonSchema {
  type: string;
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

export interface ToolImage {
  mimeType: string;
  /** Raw base64-encoded image bytes (no "data:" prefix). */
  base64: string;
}

export interface ToolResult {
  content: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  /** Images the model should see (e.g. a screenshot just taken) — surfaced as a follow-up multimodal message, not part of `content`. */
  images?: ToolImage[];
  /** A file the *human* (not the model) should be able to play/view inline in the UI — e.g. text_to_speech's output MP3. Purely a UI hint; unrelated to `images` above. */
  media?: { kind: "audio" | "image"; path: string; mimeType: string };
}

export interface ToolContext {
  cwd: string;
  sessionId: string;
  signal: AbortSignal;
  /** Per-session edit history, for /undo. Populated by the real agent loop; optional so direct unit tests don't need it. */
  history?: EditHistory;
  /** Per-session checklist, set by the todo_write tool and read by /todos. */
  todos?: TodoStore;
  /** Per-session record of last-seen file content, so write_file/edit_file can warn on an unexpected concurrent change. */
  fileFreshness?: FileFreshnessTracker;
  /** The active UI adapter, for tools that want to show live feedback (e.g. todo_write). */
  ui?: UIAdapter;
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
  /** Carried through from ToolResult.media (see below) so it survives into session.messages/persistence, not just the live WS event — a page reload can still show it. */
  media?: { kind: "audio" | "image"; path: string; mimeType: string };
}

export interface NeutralImage {
  mimeType: string;
  base64: string;
}

export type NeutralMessage =
  | { role: "user"; content: string; images?: NeutralImage[] }
  | { role: "assistant"; content: string; toolCalls?: NeutralToolCall[] }
  | { role: "tool"; results: NeutralToolResult[] };

export type StopReason = "tool_use" | "end_turn" | "other";

export interface StreamTurnParams {
  model: string;
  systemPrompt: string;
  messages: NeutralMessage[];
  tools: ToolDefinition[];
  onTextDelta: (text: string) => void;
  /** Aborts the in-flight request when the user interrupts mid-stream (Ctrl+C, the web UI's Stop) — unlike a tool call, nothing else guards this network call, so without this a Stop during "model is thinking" does nothing. */
  signal?: AbortSignal;
}

export interface StreamTurnResult {
  assistantMessage: Extract<NeutralMessage, { role: "assistant" }>;
  usage: UsageTotals;
  stopReason: StopReason;
}

export interface LlmProvider {
  streamTurn(params: StreamTurnParams): Promise<StreamTurnResult>;
}
