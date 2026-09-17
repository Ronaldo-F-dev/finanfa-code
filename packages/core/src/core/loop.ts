import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type {
  LlmProvider,
  NeutralImage,
  NeutralMessage,
  NeutralToolCall,
  NeutralToolResult,
  StreamTurnResult,
  ToolContext,
  ToolDefinition,
} from "./types.js";
import { compactForProvider, CHARS_PER_TOKEN_ESTIMATE } from "./context.js";
import { mcpToolServerName } from "../mcp/client-manager.js";
import { withSpan } from "../observability/tracing.js";
import { CALL_TOOL_NAME, SEARCH_TOOLS_NAME, DESCRIBE_TOOL_NAME, createToolSearchMetaTools, createCallToolMetaTool } from "./tool-search.js";

/**
 * The model otherwise has no idea what "today" is — nothing in this
 * codebase ever told it, so it either guesses from its training data (a
 * real, observed case: searching "... 2025" when the actual date was well
 * into 2026) or, asked directly, correctly says it doesn't know. Computed
 * fresh per call rather than baked into the static session.systemPrompt, so
 * a session left running for hours or days (a real, repeated occurrence in
 * this project) doesn't end up with a stale date baked in from startup.
 */
function systemPromptWithDate(session: AgentSession): string {
  const today = new Date().toISOString().slice(0, 10);
  let prompt =
    `${session.systemPrompt}\n\nToday's date is ${today}. Use it for anything time-sensitive — judging ` +
    "whether information might be outdated, or answering questions about the current date — instead of " +
    "guessing or assuming your training cutoff is current. When a web_search query is time-sensitive (asking " +
    `who currently holds a role, the latest version of something, recent events), derive the year from ${today} ` +
    "rather than a remembered or habitual one — a wrong year in the query can silently return stale results.";
  // Real reported bug: nothing ever told the model its own project root, so
  // when asked to create a new project it guessed at absolute paths (the
  // real repo's own directory, a random spot under the user's home) instead
  // of just writing into the directory it's actually confined to — each
  // wrong guess burned a step second-guessing the sandbox instead of doing
  // real work. cwd was already used internally everywhere (path-guard,
  // session bucketing) but never surfaced in the text the model reads.
  prompt +=
    `\n\nYour project root for this session is ${session.cwd} — write and read files relative to it (or with ` +
    "this absolute path), don't guess at a different location. Tool calls that try to write outside it (or " +
    "outside your home directory) are rejected by a sandbox, not a hint to try somewhere else at random.";
  // Set via /goal, cleared via /goal clear — re-read fresh every call
  // (like the date above) since it can change mid-session, unlike the
  // static session.systemPrompt baked in at startup.
  if (session.goal) {
    prompt +=
      `\n\nThe user has set a standing goal for this session: "${session.goal}". Keep working toward it across ` +
      "turns unless a message clearly changes direction — don't silently drop it after a few exchanges, and " +
      "don't ask the user to repeat it. If something they ask for conflicts with it, say so rather than quietly " +
      "picking one.";
  }
  return prompt;
}

/**
 * Every tool this session is actually allowed to use — every registered
 * MCP tool whose server is in `session.disabledMcpServers` (toggled via
 * /mcp disable, without disconnecting the server) is left out, and any
 * built-in tool explicitly disabled via `session.disabledTools`. This is
 * the real authority on "what's available right now" — both a direct
 * send (toolsForProvider below) and Tool Search's search_tools/call_tool
 * (tool-search.ts) resolve against exactly this, so a disabled tool stays
 * unreachable either way, not just hidden from the schema list.
 */
function availableTools(tools: ToolRegistry, session: AgentSession): ToolDefinition[] {
  if (session.disabledMcpServers.size === 0 && session.disabledTools.size === 0) return tools.list();
  return tools.list().filter((tool) => {
    if (session.disabledTools.has(tool.name)) return false;
    const server = mcpToolServerName(tool.name);
    return !server || !session.disabledMcpServers.has(server);
  });
}

/**
 * Tools to actually send to the provider this call. Normally the full
 * availableTools() list; when Tool Search is enabled for this session
 * (session.toolSearchEnabled — see tool-search.ts's own header comment
 * for the real, measured problem this closes), just the 3 meta-tools
 * instead, so the per-turn request stays small regardless of how many
 * tools are actually available — full schemas are deferred until the
 * model asks for one via describe_tool.
 */
function toolsForProvider(tools: ToolRegistry, session: AgentSession): ToolDefinition[] {
  if (!session.toolSearchEnabled) return availableTools(tools, session);
  return [...createToolSearchMetaTools(() => availableTools(tools, session)), createCallToolMetaTool()];
}

interface ToolCallOutcome {
  result: NeutralToolResult;
  images?: NeutralImage[];
}

/**
 * Real reported bug: when a provider's tool-call arguments fail to parse
 * (truncated/malformed JSON — typically a huge string argument like a bash
 * heredoc), the provider layer logs a warning and falls back to `input = {}`
 * for that call. Nothing between there and the tool's own handler ever
 * checked `inputSchema.required` against that fallback, so e.g. bash ran
 * with `command` undefined — producing a literal "undefined: command not
 * found" shell error, which then repeated identically (same malformed call,
 * same fallback) until the loop guard gave up entirely. This is a generic,
 * schema-driven check (not bash-specific) so any tool with a `required`
 * field is covered.
 */
function findMissingRequiredFields(tool: ToolDefinition, input: unknown): string[] {
  const required = (tool.inputSchema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  const record = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  return required.filter((field): field is string => typeof field === "string" && (record[field] === undefined || record[field] === null));
}

async function runOneToolCall(
  call: NeutralToolCall,
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<ToolCallOutcome> {
  let tool = tools.get(call.name);

  // search_tools/describe_tool are, like call_tool below, never actually
  // registered on the real ToolRegistry — they only ever exist in the
  // synthesized list toolsForProvider sends to the model (see
  // tool-search.ts). Without this, a real, observed bug: the model calls
  // search_tools exactly as instructed, tools.get returns undefined, this
  // function reports "Unknown tool", and the model retries with a
  // slightly different query indefinitely (never actually broken, just
  // never able to make progress) — confirmed directly against a real
  // local model. Both are safe/read-only, so they're just constructed
  // fresh and dispatched normally, no special remapping needed like
  // call_tool's own interception below.
  if (!tool && (call.name === SEARCH_TOOLS_NAME || call.name === DESCRIBE_TOOL_NAME)) {
    const [searchTools, describeTool] = createToolSearchMetaTools(() => availableTools(tools, session));
    tool = call.name === SEARCH_TOOLS_NAME ? searchTools : describeTool;
  }

  // Tool Search's call_tool is never actually invoked as itself (see
  // tool-search.ts's own header comment on why) — remap `call` onto the
  // REAL target tool/input right here, before anything else (missing-
  // fields check, permission check, handler dispatch) runs, so every one
  // of those applies to the target exactly the same way a direct call to
  // it would have triggered. Resolved against availableTools (not
  // tools.get directly) so call_tool can only reach a tool search_tools
  // could actually have surfaced — not a way for the model to blind-guess
  // the name of something this session has explicitly disabled just
  // because it isn't offered a schema for it.
  if (call.name === CALL_TOOL_NAME) {
    const raw = call.input as Record<string, unknown> | undefined;
    const targetName = typeof raw?.name === "string" ? raw.name : undefined;
    if (!targetName) {
      return { result: { toolCallId: call.id, isError: true, content: `${CALL_TOOL_NAME} requires "name" — the real tool to call (see ${SEARCH_TOOLS_NAME}).` } };
    }
    const target = availableTools(tools, session).find((t) => t.name === targetName);
    if (!target) {
      return { result: { toolCallId: call.id, isError: true, content: `No tool named "${targetName}" is currently available (unknown, or disabled for this session) — use ${SEARCH_TOOLS_NAME} to find the right name.` } };
    }
    const targetInput = raw?.input && typeof raw.input === "object" ? raw.input : {};
    call = { id: call.id, name: target.name, input: targetInput };
    tool = target;
  }

  if (!tool) {
    return { result: { toolCallId: call.id, isError: true, content: `Unknown tool "${call.name}"` } };
  }

  // See openai-compatible-provider.ts's malformed-arguments fallback: this
  // marker means the real cause is known (the response hit its max output
  // token limit mid-argument, e.g. one huge file's contents in a single
  // bash heredoc), not just "arguments failed to parse" in general — worth
  // telling the model directly so it can actually recover instead of
  // regenerating the same oversized call and tripping the loop guard again.
  if (call.input && typeof call.input === "object" && (call.input as Record<string, unknown>).__toolCallTruncated) {
    return {
      result: {
        toolCallId: call.id,
        isError: true,
        content:
          `This "${tool.name}" call's arguments were cut off because the response hit its max output token limit ` +
          "before the arguments finished — it was too large to complete in one call. Split the work into multiple " +
          "smaller calls instead (e.g. write a large file in several appended chunks, or make separate calls per file).",
      },
    };
  }

  // See openai-compatible-provider.ts's malformed-arguments fallback: this
  // marker means the arguments genuinely failed to parse as JSON (not a
  // token-limit truncation — see __toolCallTruncated above) — usually a
  // large/complex string argument (a write_file call's `content`) with a
  // real escaping mistake (an unescaped quote or control character). Real
  // reported bug: without the actual parse error surfaced, the model saw
  // only the generic "missing required fields" message below, which reads
  // as "you forgot the fields" rather than "your JSON was malformed" — it
  // retried the identical broken call 3 times per turn, across 3 separate
  // turns, never correcting it, because nothing ever told it what was
  // actually wrong with the JSON it generated.
  if (call.input && typeof call.input === "object" && typeof (call.input as Record<string, unknown>).__toolCallParseError === "string") {
    const parseError = (call.input as Record<string, unknown>).__toolCallParseError as string;
    return {
      result: {
        toolCallId: call.id,
        isError: true,
        content:
          `This "${tool.name}" call's arguments were not valid JSON (${parseError}). This usually means a string ` +
          "argument wasn't properly escaped — unescaped double quotes, backslashes, or literal newlines inside a " +
          "JSON string value need escaping (\\\", \\\\, \\n). Regenerate the call with correctly escaped JSON, not " +
          "the same arguments again.",
      },
    };
  }

  const missingFields = findMissingRequiredFields(tool, call.input);
  if (missingFields.length > 0) {
    return {
      result: {
        toolCallId: call.id,
        isError: true,
        content: `Missing required field(s) for "${tool.name}": ${missingFields.join(", ")} (the arguments for this call could not be parsed — try again with complete, valid arguments)`,
      },
    };
  }

  // Plan mode (/plan): only read-only tools and exit_plan_mode itself get
  // through — everything else is denied without even reaching the normal
  // permission flow (no prompt, no hook), since the whole point is that
  // NOTHING can mutate anything until a plan is presented and approved.
  if (session.planMode && tool.riskLevel !== "safe" && tool.name !== "exit_plan_mode") {
    return {
      result: {
        toolCallId: call.id,
        isError: true,
        content: `"${tool.name}" is unavailable while in plan mode. Keep researching with read-only tools, then call exit_plan_mode with your plan once ready.`,
      },
    };
  }

  // Registered on the session (not just held locally) so Ctrl+C — handled in
  // cli.ts's registerShutdownHandlers, far from this call stack — can abort
  // whichever tool call(s) are actually running right now. Without this, the
  // signal every tool receives was permanently un-abortable: created fresh
  // here with nothing ever calling .abort() on it, so interrupting during a
  // long bash/run_tests call let the subprocess survive as an orphan after
  // this process exited.
  const controller = new AbortController();
  session.activeAbortControllers.add(controller);

  const ctx: ToolContext = {
    cwd: session.cwd,
    sessionId: session.id,
    signal: controller.signal,
    history: session.history,
    todos: session.todos,
    fileFreshness: session.fileFreshness,
    ui,
    exitPlanMode: () => {
      session.planMode = false;
    },
  };

  try {
    const decision = await permissions.check(tool, call.input, ctx, call.id);
    if (decision === "deny") {
      return { result: { toolCallId: call.id, isError: true, content: "User declined to run this tool." } };
    }

    const callDescription = tool.describeCall ? tool.describeCall(call.input) : "";
    if (ui.writeToolCall) ui.writeToolCall({ toolCallId: call.id, toolName: tool.name, description: callDescription, riskLevel: tool.riskLevel });
    else ui.writeSystem(`→ ${tool.name}: ${callDescription}`);
    ui.setBusy(true, tool.name);
    try {
      const result = await withSpan("tool.call", { "tool.name": tool.name, "tool.risk_level": tool.riskLevel }, async (span) => {
        const r = await tool.handler(call.input, ctx);
        span.setAttribute("tool.is_error", r.isError);
        return r;
      });
      // The full content always reaches the model via the tool_result message
      // regardless — this is a compact echo for the human. Without it, once a
      // tool is session-allowlisted (no more preview/confirmation), the only
      // thing shown for e.g. every later `npm test`/`npm run build` was the
      // one-line invocation — no exit code, no stderr — until the model chose
      // to paraphrase it, so a failure it glossed over had no direct
      // visibility short of asking it to repeat itself or re-running by hand.
      echoToolOutput(ui, result.content, result.isError);
      ui.writeToolResult?.({ toolCallId: call.id, toolName: tool.name, isError: result.isError, content: result.content });
      if (!result.isError && result.media) ui.writeMedia?.(result.media);
      await permissions.runPostToolUseHook(tool, call.input, { isError: result.isError, content: result.content }, ctx);
      return {
        // media is carried into the persisted tool-result message (not just
        // fired as a live UI event above) so a page reload/resumed session
        // can still show the player — see the web server's history replay.
        result: { toolCallId: call.id, isError: result.isError, content: result.content, media: !result.isError ? result.media : undefined },
        images: result.images,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      echoToolOutput(ui, message, true);
      ui.writeToolResult?.({ toolCallId: call.id, toolName: tool.name, isError: true, content: message });
      return {
        result: { toolCallId: call.id, isError: true, content: message },
      };
    } finally {
      ui.setBusy(false);
    }
  } finally {
    session.activeAbortControllers.delete(controller);
  }
}

const TOOL_OUTPUT_ECHO_LIMIT = 2000;

function echoToolOutput(ui: UIAdapter, content: string, isError: boolean): void {
  const trimmed = content.trim();
  if (trimmed.length === 0) return;
  const truncated = trimmed.length > TOOL_OUTPUT_ECHO_LIMIT ? `${trimmed.slice(0, TOOL_OUTPUT_ECHO_LIMIT)}\n... (truncated)` : trimmed;
  if (isError) ui.writeError(truncated);
  else ui.writeSystem(truncated);
}

interface ToolBatchOutcome {
  results: NeutralToolResult[];
  images: NeutralImage[];
}

/**
 * Runs a batch of tool calls. Tools registered with riskLevel "safe" (no side
 * effects — reads, searches, "task" sub-agents which permission-check their
 * own calls individually, etc.) run concurrently via Promise.all: order
 * between them doesn't matter and there's nothing to conflict. Tools that can
 * write or have side effects ("ask"/"dangerous") run strictly sequentially,
 * one at a time — order matters, and each may show an interactive permission
 * prompt. Any images returned by tools (e.g. a screenshot) are collected
 * separately — most providers don't support images inside tool-result
 * content itself, so the caller surfaces them as a follow-up user message.
 */
async function runToolCallBatch(
  toolCalls: NeutralToolCall[],
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<ToolBatchOutcome> {
  const outcomes = Array.from<ToolCallOutcome>({ length: toolCalls.length });
  const parallelIndices: number[] = [];

  for (const [i, call] of toolCalls.entries()) {
    if (tools.get(call.name)?.riskLevel === "safe") {
      parallelIndices.push(i);
      continue;
    }
    outcomes[i] = await runOneToolCall(call, session, ui, tools, permissions);
  }

  await Promise.all(
    parallelIndices.map(async (i) => {
      outcomes[i] = await runOneToolCall(toolCalls[i], session, ui, tools, permissions);
    }),
  );

  return {
    results: outcomes.map((o) => o.result),
    images: outcomes.flatMap((o) => o.images ?? []),
  };
}

export interface VisionRoute {
  provider: LlmProvider;
  model: string;
}

// Backstops for a model that ignores the system prompt's own "stop after ~3
// attempts" guidance (common with smaller/free models) — nothing else in the
// loop enforces either limit.
//
// Real reported case: a genuinely large, legitimate task (a complete Flutter
// e-commerce app — models, controllers, theme, several full screens) hit the
// original 50-step cap well before finishing, with no errors or repeats
// along the way — just real, steady progress cut short. 50 was carried over
// from when this guard was first added as a stuck-loop backstop, not tuned
// against how many steps a big-but-legitimate build actually needs. Raised
// to 150 for more headroom; still finite, and the CLI's own --prompt mode
// now auto-continues past this (see cli.ts) for tasks that need even more.
const MAX_ITERATIONS = 150;
const REPEAT_LIMIT = 3;

// Real reported bug: a long tool-heavy turn (lots of verbose bash/ls/cat
// output, on a "full" tool budget sending all ~130 tool schemas every call)
// grew to 202,917 real input tokens with no compaction ever triggering —
// compactForProvider's own 60k-token budget (context.ts) only ever counts
// session.messages, never the system prompt or the tool list actually sent
// alongside it, so the biggest fixed cost of a "full" tool budget was
// invisible to it. The provider eventually returned a silent empty
// completion (no error, no tool call, no text — handled gracefully by the
// existing "empty response" message, but with real work lost). This adds a
// pre-call estimate covering everything actually sent (system prompt + tool
// schemas + messages) and auto-compacts via compactSession — the same
// LLM-summarization compaction /compact already does manually — before
// a request this large ever goes out, instead of only ever finding out
// after the fact via an empty or failed response.
const AUTO_COMPACT_TOKEN_THRESHOLD = 100_000;

/** Rough token estimate for everything an actual provider call sends — the same char-per-token trust level compactForProvider already uses, but covering the system prompt and tool schemas too, not just messages. */
function estimateRequestTokens(systemPrompt: string, messages: NeutralMessage[], tools: ToolDefinition[]): number {
  const chars = systemPrompt.length + JSON.stringify(compactForProvider(messages)).length + JSON.stringify(tools).length;
  return Math.ceil(chars / CHARS_PER_TOKEN_ESTIMATE);
}

function toolCallBatchSignature(toolCalls: NeutralToolCall[]): string {
  return JSON.stringify(toolCalls.map((c) => ({ name: c.name, input: c.input })));
}

/**
 * Strips the image(s) from the most recent image-bearing user message,
 * replacing them with a short text note. compactForProvider() only ever
 * compacts old *tool* results — an image message is never touched, so
 * without this it gets resent, unchanged, on every later call for the rest
 * of the session. On a model that can't handle multimodal input, that means
 * every subsequent turn — even ones with nothing to do with the image —
 * fails with the same error forever. Called once, right after the one call
 * the image was actually meant for (success or failure), never left in
 * history longer than that.
 */
function consumeImageMessage(session: AgentSession, note: string): void {
  for (let i = session.messages.length - 1; i >= 0; i--) {
    const m = session.messages[i];
    if (m.role === "user" && m.images?.length) {
      m.content = m.content.length > 0 ? `${m.content} (${note})` : `(${note})`;
      delete m.images;
      return;
    }
  }
}

/**
 * Node's fetch (undici) wraps a network-level failure (DNS, connection
 * refused, TLS, ...) in a `TypeError` whose own `.message` is always just
 * "fetch failed" — the actually useful detail sits one level down in
 * `.cause` (verified directly: a real DNS failure surfaces as `cause: Error:
 * getaddrinfo ENOTFOUND ...`, completely absent from `.message`). Without
 * unwrapping it, a transient network blip during a provider call showed the
 * user/model an undiagnosable "(the model call failed: fetch failed)" with
 * no way to tell a DNS problem from a bad URL from the provider being down.
 */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = err.cause instanceof Error ? err.cause.message : undefined;
  return cause ? `${err.message}: ${cause}` : err.message;
}

// compactForProvider only ever shrinks tool results — a long conversation
// dominated by assistant/user text instead (or one with more large tool
// results than it keeps compacted) has no safety net and can still exceed
// the provider's real limit. Matched loosely across the wording different
// OpenAI-compatible/Anthropic-style backends actually use for this, rather
// than one exact string, since it's never been worth depending on a single
// provider's phrasing.
const CONTEXT_LENGTH_ERROR_PATTERN =
  /context.{0,20}(length|window|size)|too (many|long).{0,30}tokens|maximum.{0,30}tokens|tokens.{0,30}maximum|reduce the (length|amount)|exceeds.{0,30}context/i;

function isLikelyContextLengthError(message: string): boolean {
  return CONTEXT_LENGTH_ERROR_PATTERN.test(message);
}

// Real, reported case: a local model (Ollama serving a model with no
// function-calling support, e.g. yi-coder:9b-chat) rejected the request
// outright with "... does not support tools" — this project always sends
// its full tool list on every call, with no way to opt a specific model
// out short of disabling every tool for the whole session (see /tools).
const TOOLS_UNSUPPORTED_ERROR_PATTERN = /does.{0,15}not support tools|calling.{0,20}not.{0,10}support/i;

function isLikelyToolsUnsupportedError(message: string): boolean {
  return TOOLS_UNSUPPORTED_ERROR_PATTERN.test(message);
}

// Both LoopGuard messages below start with this — a distinctive marker so
// callers (task.ts) can tell "the turn was cut off by the guard" apart from
// "the model naturally finished", without runTurn needing a richer return
// type. A real gap this closes: task's tool result used to hardcode
// isError: false unconditionally, so a delegated sub-agent that silently
// ran out of budget (hit the iteration/repetition cap) was indistinguishable
// from one that actually completed — nothing downstream could branch on it.
const LOOP_GUARD_MESSAGE_PREFIX = "(stopped";

/** True if `text` is a stop message LoopGuard itself produced, not the model's own final text. */
export function isLoopGuardStopMessage(text: string): boolean {
  return text.startsWith(LOOP_GUARD_MESSAGE_PREFIX);
}

/** Tracks per-turn iteration/repetition state so runTurn's own control flow stays flat. */
class LoopGuard {
  private iterations = 0;
  private lastSignature: string | undefined;
  private repeatCount = 0;

  /** A message to show and stop on, once MAX_ITERATIONS is exceeded — else undefined. */
  checkIterationLimit(): string | undefined {
    this.iterations++;
    if (this.iterations <= MAX_ITERATIONS) return undefined;
    return (
      `${LOOP_GUARD_MESSAGE_PREFIX} after ${MAX_ITERATIONS} steps without finishing — the task may be stuck or ` +
      "too large; try breaking it into smaller requests)"
    );
  }

  /**
   * "stop" once the exact same tool call batch repeats REPEAT_LIMIT times —
   * same hard backstop as before. "nudge" fires one step earlier (the 2nd
   * repeat, i.e. REPEAT_LIMIT - 1), before the model has burned its last
   * attempt: a short reminder appended to that call's own tool result,
   * giving it one real chance to change approach instead of being cut off
   * with zero warning on attempt 3. Same idea as DeepSeek Harness's
   * repeat-tool-call guard (deepseek-ai/deepseek-harness, packages/guard) —
   * reimplemented independently, no shared code.
   */
  checkRepetition(toolCalls: NeutralToolCall[]): { kind: "nudge" | "stop"; message: string } | undefined {
    const signature = toolCallBatchSignature(toolCalls);
    this.repeatCount = signature === this.lastSignature ? this.repeatCount + 1 : 1;
    this.lastSignature = signature;
    const plural = toolCalls.length > 1 ? "s" : "";
    if (this.repeatCount === REPEAT_LIMIT - 1) {
      return {
        kind: "nudge",
        message: `(loop guard: this exact tool call${plural} — same tool, same arguments — was just repeated. If it didn't produce what you needed, try a different approach now rather than repeating it again)`,
      };
    }
    if (this.repeatCount < REPEAT_LIMIT) return undefined;
    return {
      kind: "stop",
      message: `${LOOP_GUARD_MESSAGE_PREFIX} — the same tool call${plural} repeated ${REPEAT_LIMIT} times in a row with no apparent progress)`,
    };
  }
}

/**
 * Same idea as ChatGPT/Claude.ai auto-titling a new thread: after the first
 * exchange completes, ask the model for a short summary of what the
 * conversation is about, so /sessions can show something more useful than a
 * bare UUID. Uses the session's own model/provider (no separate "title
 * model" wiring) and a minimal, tool-free call — cheap, and never allowed to
 * fail the actual turn: any error here is swallowed, a missing title just
 * means /sessions falls back to showing the id, same as before this existed.
 */
export async function maybeGenerateTitle(session: AgentSession, provider: LlmProvider): Promise<void> {
  if (session.title) return;
  const firstUserMessage = session.messages.find((m) => m.role === "user");
  if (!firstUserMessage || firstUserMessage.role !== "user") return;

  try {
    const result = await provider.streamTurn({
      model: session.model,
      systemPrompt:
        "Reply with ONLY a short title (3-6 words, no punctuation, no quotes, no trailing period) summarizing " +
        "what this conversation is about. Nothing else — just the title, nothing before or after it.",
      messages: [{ role: "user", content: firstUserMessage.content }],
      tools: [],
      onTextDelta: () => {},
    });
    const title = result.assistantMessage.content
      .trim()
      .replace(/^["'“”]+|["'“”]+$/g, "")
      .slice(0, 60);
    if (title.length > 0) {
      session.title = title;
      await session.persist();
    }
  } catch {
    // Best-effort — see docstring.
  }
}

// Just enough of each tool result for the summarizer to know what actually
// happened (e.g. "Wrote speech audio to speech.mp3") — the earlier version
// collapsed every result to a bare "ok"/"error" with zero content, so a
// genuinely successful tool call (verified against a real text_to_speech
// run) still got summarized as "no result was provided, unclear whether it
// succeeded" purely because the summarizer had nothing to go on.
const SUMMARY_RESULT_SNIPPET_LENGTH = 300;

function formatMessageForSummary(m: NeutralMessage): string {
  if (m.role === "user") return `User: ${m.content}`;
  if (m.role === "assistant") {
    const calls = m.toolCalls?.length ? ` [called: ${m.toolCalls.map((c) => c.name).join(", ")}]` : "";
    return `Assistant: ${m.content}${calls}`;
  }
  const results = m.results
    .map((r) => {
      const snippet = r.content.length > SUMMARY_RESULT_SNIPPET_LENGTH ? `${r.content.slice(0, SUMMARY_RESULT_SNIPPET_LENGTH)}...` : r.content;
      return `${r.isError ? "error" : "ok"}: ${snippet}`;
    })
    .join(" | ");
  return `[tool result(s): ${results}]`;
}

export interface CompactResult {
  messagesBefore: number;
}

/**
 * Manual, deliberate compaction — distinct from compactForProvider (which
 * runs automatically on every provider call and only ever shrinks old *tool*
 * results within the size sent to the model, never touching what's actually
 * stored in session.messages). This instead asks the model itself to
 * summarize the WHOLE conversation so far — including long user/assistant
 * text turns compactForProvider never addresses — into a standalone
 * briefing, then replaces session.messages with just that summary. A one-way
 * operation: the original turns are gone from this session once persisted
 * (same trade-off Claude Code's own /compact makes). Returns undefined if
 * there's nothing worth compacting (empty session) or the summarization call
 * itself failed.
 */
export async function compactSession(session: AgentSession, provider: LlmProvider): Promise<CompactResult | undefined> {
  if (session.messages.length === 0) return undefined;

  const messagesBefore = session.messages.length;
  // Re-uses the same old-tool-result shrinking compactForProvider already
  // does for every normal turn, so an already-huge conversation doesn't also
  // blow up the size of *this* summarization request.
  const transcript = compactForProvider(session.messages)
    .map(formatMessageForSummary)
    .join("\n\n");

  try {
    const result = await provider.streamTurn({
      model: session.model,
      systemPrompt:
        "Summarize the conversation transcript below into a concise standalone briefing for whoever continues " +
        "this task next — not a blow-by-blow recap. Cover: what the user is trying to accomplish, key decisions " +
        "and their reasons, specific files/paths/values touched, and the current state of any in-progress work " +
        "(what's done, what's left). Reply with ONLY the briefing text, nothing before or after it.",
      messages: [{ role: "user", content: transcript }],
      tools: [],
      onTextDelta: () => {},
    });

    // Defensive, same reasoning as runTurn's own empty-response check: a
    // malformed provider response with content undefined instead of "" must
    // not crash a compaction that — now that it can trigger automatically
    // mid-turn (see AUTO_COMPACT_TOKEN_THRESHOLD above), not just via the
    // manual /compact command — is exercised far more often than before.
    const summary = (result.assistantMessage.content ?? "").trim();
    if (summary.length === 0) return undefined;

    session.messages = [
      { role: "user", content: "[Earlier conversation compacted to save context — see the summary below]" },
      { role: "assistant", content: summary },
    ];
    await session.persist();
    return { messagesBefore };
  } catch {
    // Best-effort, same as maybeGenerateTitle — a failed summarization call
    // must never lose the original conversation, so session.messages is
    // only ever replaced after a successful, non-empty result above.
    return undefined;
  }
}

export async function runTurn(
  session: AgentSession,
  provider: LlmProvider,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
  userInput: string,
  visionRoute?: VisionRoute,
  images?: NeutralImage[],
): Promise<void> {
  const hookOutcome = await permissions.runUserPromptSubmitHook(userInput, session.cwd, session.id);
  if (hookOutcome.blockedReason) {
    ui.writeError(hookOutcome.blockedReason);
    return;
  }
  session.messages.push({ role: "user", content: hookOutcome.prompt, images });
  // Recorded here, not after the turn finishes — a checkpoint marks "right
  // before this message and anything it caused," so /rewind can restore
  // that state even if the turn itself is later interrupted or errors out.
  session.checkpoints.push({
    messageIndex: session.messages.length,
    historySize: session.history.size,
    preview: hookOutcome.prompt.slice(0, 60),
  });
  // Same as a tool-produced image (browser_screenshot, view_image) — route
  // the very next call through visionRoute if one is configured, since the
  // primary model may not support image input at all.
  let nextCallNeedsVision = Boolean(images?.length);
  const guard = new LoopGuard();

  for (;;) {
    const iterationStop = guard.checkIterationLimit();
    if (iterationStop) {
      ui.writeSystem(iterationStop);
      // Recorded into history, not just shown in the terminal — otherwise
      // the model has no way to know this turn ended because the guard cut
      // it off rather than because it actually finished. A real, observed
      // case: asked "did you finish?" right after a cutoff, the model
      // confidently said yes, since from its own perspective the
      // conversation had just ended cleanly with no sign anything was wrong.
      session.messages.push({ role: "assistant", content: iterationStop });
      await session.persist();
      return;
    }

    // Route only the one call right after a tool produced an image — not
    // every later call in the session. Otherwise a single screenshot early
    // in a long session would pin every future turn onto the (likely
    // pricier/slower) vision model long after it's relevant. The image
    // itself is stripped from history right after this one call, too (see
    // consumeImageMessage) — compactForProvider never touches it, so
    // without that it would get resent, unchanged, on every later call.
    const active = nextCallNeedsVision && visionRoute ? visionRoute : { provider, model: session.model };
    const sendingImageWithoutVisionRoute = nextCallNeedsVision && !visionRoute;
    const wasShowingImage = nextCallNeedsVision;
    nextCallNeedsVision = false;

    const activeTools = toolsForProvider(tools, session);
    const estimatedTokens = estimateRequestTokens(systemPromptWithDate(session), session.messages, activeTools);
    if (estimatedTokens > AUTO_COMPACT_TOKEN_THRESHOLD) {
      ui.writeSystem(`(context is very large — ~${estimatedTokens.toLocaleString()} tokens — compacting automatically before continuing)`);
      const compacted = await compactSession(session, provider);
      if (compacted) ui.writeSystem(`Compacted ${compacted.messagesBefore} earlier messages into a summary to stay within context.`);
    }

    ui.setBusy(true, "thinking");
    // Same mechanism as runOneToolCall's controller below — registered on
    // the session so an interrupt (Ctrl+C, the web UI's Stop) can cancel
    // this specific in-flight call. Without this, "model is thinking" was
    // the one phase of a turn a stop request did literally nothing during:
    // activeAbortControllers was only ever populated while a *tool* call
    // was running, never during the model's own streaming request.
    const streamController = new AbortController();
    session.activeAbortControllers.add(streamController);
    let result: StreamTurnResult;
    try {
      result = await withSpan("llm.turn", { "llm.model": active.model }, async (span) => {
        const r = await active.provider.streamTurn({
          model: active.model,
          systemPrompt: systemPromptWithDate(session),
          messages: compactForProvider(session.messages),
          tools: activeTools,
          onTextDelta: (text) => ui.writeAssistantDelta(text),
          signal: streamController.signal,
          maxTokens: session.maxTokens,
          thinkingBudgetTokens: session.thinkingBudgetTokens,
          onThinkingDelta: (text) => ui.writeThinkingDelta?.(text),
          onToolCallStart: (call) => ui.writeToolCallStarting?.(call),
        });
        span.setAttribute("llm.input_tokens", r.usage.inputTokens);
        span.setAttribute("llm.output_tokens", r.usage.outputTokens);
        span.setAttribute("llm.stop_reason", r.stopReason);
        return r;
      });
    } catch (err) {
      // A provider call can throw outright (not just return an empty/odd
      // result) — e.g. a real case: sending an image to a model that
      // rejects multimodal input with an HTTP 400. Left uncaught, this
      // aborted the whole turn with a raw, scary-looking error dump and no
      // way for the model (or user) to react. Ending the turn cleanly here,
      // with a message tailored to the likely cause, matches how the other
      // "can't continue" cases below already behave.
      ui.setBusy(false);
      if (streamController.signal.aborted) {
        // A deliberate user interrupt (Ctrl+C, the web UI's Stop) throws
        // through the same catch as a genuine provider failure — tell them
        // apart so this doesn't read as "the model call failed" for
        // something the user asked for.
        ui.writeSystem("Interrupted.");
        return;
      }
      const message = describeError(err);
      let displayMessage: string;
      if (sendingImageWithoutVisionRoute) {
        consumeImageMessage(session, `not shown — ${active.model} doesn't support image input`);
        displayMessage =
          `(the model call failed — ${active.model} likely doesn't support image input, and no vision route is ` +
          'configured for this session; see "Vision routing" in the README, or /config set visionModel. The ' +
          "image has been dropped from this conversation so it won't keep failing every later turn too. " +
          `Original error: ${message})`;
      } else if (isLikelyContextLengthError(message)) {
        // compactForProvider already shrinks old tool results, but that's
        // not always enough (a conversation dominated by long assistant/user
        // text has no other safety net) — when the provider itself rejects
        // the request as too large, say so plainly and point at the actual
        // way out instead of leaving this indistinguishable from any other
        // opaque failure.
        displayMessage =
          `(the model call failed — this looks like a context-length error: the conversation is too large for ` +
          `${active.model} even after compaction. Use /clear to start fresh in this session, or /session <id> ` +
          `to switch to a different one — see /sessions for ids. Original error: ${message})`;
      } else if (isLikelyToolsUnsupportedError(message)) {
        // This project always sends its full tool list on every call —
        // there's no per-model "text-only" mode short of disabling every
        // tool for the whole session (/tools disable <name> for each one,
        // or the web UI's Tools panel). Some local models (a smaller
        // fine-tune with no function-calling training) genuinely can't
        // accept a request with tools attached at all, distinct from a
        // model that just doesn't reliably *use* them.
        displayMessage =
          `(the model call failed — ${active.model} doesn't support tool/function calling at all, and every call ` +
          "here includes the full tool list. Pick a model that supports it, or disable every tool for this " +
          "session (/tools, or the web UI's Tools panel) to use this one for plain text chat with no tool use. " +
          `Original error: ${message})`;
      } else {
        displayMessage = `(the model call failed: ${message})`;
      }
      ui.writeSystem(displayMessage);
      // Never sent back to the model (that would mean every later call
      // resends it as if it were part of the actual conversation) — just
      // recorded so a resumed/reopened session can show the user what
      // failed, not just the ordinary chat text. See SessionFile's own
      // doc comment on errorLog for why this needed its own persisted
      // field rather than reusing session.messages.
      session.errorLog.push({ text: displayMessage, afterMessageIndex: session.messages.length });
      await session.persist();
      return;
    } finally {
      session.activeAbortControllers.delete(streamController);
    }

    // Real, reported crash: everything from here to the end of this loop
    // iteration (pushing the assistant message, running its tool calls,
    // persisting) used to have NO try/catch of its own — only the
    // streamTurn call above (already exited via its own catch/return by
    // this point) was protected. Any unexpected bug here — a malformed
    // provider response, a tool's own uncaught edge case slipping past
    // runOneToolCall's handling — escaped all the way to the web server's
    // generic top-level handler as a raw, scary "Unexpected error: Cannot
    // read properties of undefined (reading 'trim')"-style message instead
    // of the same graceful, persisted "(the model call failed...)" pattern
    // every other failure mode in this function already gets. Wrapping it
    // closes that whole class of crash, not just one specific instance of it.
    try {
      ui.setBusy(false);
      ui.endAssistantMessage();
      session.messages.push(result.assistantMessage);
      session.recordUsage(result.usage.inputTokens, result.usage.outputTokens);
      if (wasShowingImage) consumeImageMessage(session, "already shown to the model above");

      ui.setStatus({
        tokens: session.usage.inputTokens + session.usage.outputTokens,
        costUsd: session.costUsd,
        model: session.model,
        planMode: session.planMode,
      });
      await session.persist();

      const toolCalls = result.assistantMessage.toolCalls;
      if (result.stopReason !== "tool_use" || !toolCalls?.length) {
        // Defensive: every provider's own accumulator starts as "" and this
        // has never been observed to be anything but a string in this
        // project's own providers — but a value this function trusted
        // blindly here is exactly what caused the crash this whole
        // try/catch exists to catch, so it isn't trusted blindly either.
        if ((result.assistantMessage.content ?? "").trim() === "") {
          ui.writeSystem("(the model returned an empty response — try rephrasing, or check /cost for context size)");
        }
        return;
      }

      const repeatCheck = guard.checkRepetition(toolCalls);
      if (repeatCheck?.kind === "stop") {
        ui.writeSystem(repeatCheck.message);
        // The assistant message with these tool_calls is already in history
        // (pushed above) but the calls themselves were never run — leaving
        // them unresolved would mean every tool_use block has no matching
        // tool_result, which providers like Anthropic reject outright on the
        // next request, breaking the session from here on. Stub results keep
        // the transcript structurally valid; the follow-up assistant note
        // (same reasoning as the iteration-limit case above) lets the model
        // know on the next turn that this ended via the guard, not naturally.
        session.messages.push({
          role: "tool",
          results: toolCalls.map((call) => ({ toolCallId: call.id, content: "(skipped — repetition guard triggered)", isError: true })),
        });
        session.messages.push({ role: "assistant", content: repeatCheck.message });
        await session.persist();
        return;
      }

      const { results, images } = await runToolCallBatch(toolCalls, session, ui, tools, permissions);

      if (repeatCheck?.kind === "nudge" && results.length > 0) {
        // Appended to the last real tool result rather than pushed as its own
        // message — every tool_use block needs a matching tool_result (same
        // protocol constraint as the "stop" branch above), so there's no valid
        // toolCallId to hang a standalone nudge off of. Piggybacking on a real
        // result keeps the transcript valid and still puts the reminder
        // directly in the model's next-turn context.
        const last = results[results.length - 1];
        results[results.length - 1] = { ...last, content: `${last.content}\n\n${repeatCheck.message}` };
        ui.writeSystem(repeatCheck.message);
      }

      session.messages.push({ role: "tool", results });
      if (images.length > 0) {
        nextCallNeedsVision = true;
        session.messages.push({ role: "user", content: "(image result from the tool call above)", images });
      }
      await session.persist();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const displayMessage = `(an unexpected internal error interrupted this turn: ${message})`;
      ui.setBusy(false);
      ui.writeSystem(displayMessage);
      session.errorLog.push({ text: displayMessage, afterMessageIndex: session.messages.length });
      await session.persist();
      return;
    }
  }
}
