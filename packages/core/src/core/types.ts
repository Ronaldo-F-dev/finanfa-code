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
  /** Called by exit_plan_mode's handler once its plan is approved, turning plan mode off for the rest of the session. */
  exitPlanMode?: () => void;
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

/**
 * Anthropic extended-thinking content, carried through opaquely — no other
 * provider produces or reads these, but Anthropic (direct, Bedrock, or
 * Vertex — all three funnel through streamAnthropicTurn) requires its own
 * thinking block(s) to be replayed back verbatim, in original order,
 * ahead of any text/tool_use content, on the very next request that
 * continues this same assistant turn (e.g. submitting a tool_result).
 * Dropping or reordering them makes that next call a 400. `signature`
 * cryptographically ties a real "thinking" block to the request that
 * produced it; a "redacted_thinking" block's `data` is opaque (flagged
 * content Anthropic itself withheld) and is never meant to be human-readable.
 */
export type NeutralThinkingBlock = { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string };

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
  | { role: "assistant"; content: string; toolCalls?: NeutralToolCall[]; thinkingBlocks?: NeutralThinkingBlock[] }
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
  /** Overrides the provider's default max_tokens — used by the effort-tier picker to cap output on small/local models where a large response is itself part of what exhausts a tiny context window. Falls back to each provider's own default when unset. */
  maxTokens?: number;
  /** Enables Anthropic extended thinking with this token budget (undefined disables it — the default, zero behavior change). Ignored by every provider except streamAnthropicTurn (direct/Bedrock/Vertex); see NeutralThinkingBlock for why the resulting content has to round-trip through session history unmodified. */
  thinkingBudgetTokens?: number;
  /** Streamed thinking-content deltas, mirroring onTextDelta — optional, since only extended thinking (and only some providers) ever calls it. */
  onThinkingDelta?: (text: string) => void;
  /**
   * Fires the moment a tool call's *name* is known, well before its
   * arguments finish streaming (and long before the rest of the turn
   * does) — a long turn that ends in one or more tool calls previously
   * looked frozen behind a generic "thinking..." spinner for its entire
   * duration, since the UI only ever learned about a tool call from
   * `assistantMessage.toolCalls` after `streamTurn` resolved. Best-effort:
   * a provider whose wire format never streams a tool call incrementally
   * (Gemini's function-call parts arrive whole) simply never calls it —
   * the tool still runs correctly, this is purely an earlier UI signal.
   */
  onToolCallStart?: (call: { name: string }) => void;
}

export interface StreamTurnResult {
  assistantMessage: Extract<NeutralMessage, { role: "assistant" }>;
  usage: UsageTotals;
  stopReason: StopReason;
}

export interface LlmProvider {
  streamTurn(params: StreamTurnParams): Promise<StreamTurnResult>;
}
