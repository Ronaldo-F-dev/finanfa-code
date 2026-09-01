import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type {
  LlmProvider,
  NeutralImage,
  NeutralToolCall,
  NeutralToolResult,
  StreamTurnResult,
  ToolContext,
  ToolDefinition,
} from "./types.js";
import { compactForProvider } from "./context.js";
import { mcpToolServerName } from "../mcp/client-manager.js";

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
  return `${session.systemPrompt}\n\nToday's date is ${today}. Use it for anything time-sensitive — judging ` +
    "whether information might be outdated, or answering questions about the current date — instead of " +
    "guessing or assuming your training cutoff is current. When a web_search query is time-sensitive (asking " +
    `who currently holds a role, the latest version of something, recent events), derive the year from ${today} ` +
    "rather than a remembered or habitual one — a wrong year in the query can silently return stale results.";
}

/**
 * Tools to actually offer the model this call — every registered MCP tool
 * whose server is in `session.disabledMcpServers` (toggled via /mcp disable,
 * without disconnecting the server) is left out, so a session juggling many
 * connected servers doesn't pay the token cost of every tool schema from
 * every server on every single call regardless of task relevance. Built-in
 * tools are never filtered.
 */
function toolsForProvider(tools: ToolRegistry, session: AgentSession): ToolDefinition[] {
  if (session.disabledMcpServers.size === 0) return tools.list();
  return tools.list().filter((tool) => {
    const server = mcpToolServerName(tool.name);
    return !server || !session.disabledMcpServers.has(server);
  });
}

interface ToolCallOutcome {
  result: NeutralToolResult;
  images?: NeutralImage[];
}

async function runOneToolCall(
  call: NeutralToolCall,
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<ToolCallOutcome> {
  const tool = tools.get(call.name);
  if (!tool) {
    return { result: { toolCallId: call.id, isError: true, content: `Unknown tool "${call.name}"` } };
  }

  const ctx: ToolContext = {
    cwd: session.cwd,
    sessionId: session.id,
    signal: new AbortController().signal,
    history: session.history,
    todos: session.todos,
    fileFreshness: session.fileFreshness,
    ui,
  };

  const decision = await permissions.check(tool, call.input, ctx);
  if (decision === "deny") {
    return { result: { toolCallId: call.id, isError: true, content: "User declined to run this tool." } };
  }

  ui.writeSystem(`→ ${tool.name}: ${tool.describeCall ? tool.describeCall(call.input) : ""}`);
  ui.setBusy(true, tool.name);
  try {
    const result = await tool.handler(call.input, ctx);
    // The full content always reaches the model via the tool_result message
    // regardless — this is a compact echo for the human. Without it, once a
    // tool is session-allowlisted (no more preview/confirmation), the only
    // thing shown for e.g. every later `npm test`/`npm run build` was the
    // one-line invocation — no exit code, no stderr — until the model chose
    // to paraphrase it, so a failure it glossed over had no direct
    // visibility short of asking it to repeat itself or re-running by hand.
    echoToolOutput(ui, result.content, result.isError);
    return {
      result: { toolCallId: call.id, isError: result.isError, content: result.content },
      images: result.images,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    echoToolOutput(ui, message, true);
    return {
      result: { toolCallId: call.id, isError: true, content: message },
    };
  } finally {
    ui.setBusy(false);
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
  const outcomes = new Array<ToolCallOutcome>(toolCalls.length);
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
const MAX_ITERATIONS = 50;
const REPEAT_LIMIT = 3;

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

  /** A message to show and stop on, once the exact same tool call batch repeats REPEAT_LIMIT times — else undefined. */
  checkRepetition(toolCalls: NeutralToolCall[]): string | undefined {
    const signature = toolCallBatchSignature(toolCalls);
    this.repeatCount = signature === this.lastSignature ? this.repeatCount + 1 : 1;
    this.lastSignature = signature;
    if (this.repeatCount < REPEAT_LIMIT) return undefined;
    return (
      `${LOOP_GUARD_MESSAGE_PREFIX} — the same tool call${toolCalls.length > 1 ? "s" : ""} repeated ${REPEAT_LIMIT} ` +
      "times in a row with no apparent progress)"
    );
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
): Promise<void> {
  session.messages.push({ role: "user", content: userInput });
  let nextCallNeedsVision = false;
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

    ui.setBusy(true, "thinking");
    let result: StreamTurnResult;
    try {
      result = await active.provider.streamTurn({
        model: active.model,
        systemPrompt: systemPromptWithDate(session),
        messages: compactForProvider(session.messages),
        tools: toolsForProvider(tools, session),
        onTextDelta: (text) => ui.writeAssistantDelta(text),
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
      const message = describeError(err);
      if (sendingImageWithoutVisionRoute) {
        consumeImageMessage(session, `not shown — ${active.model} doesn't support image input`);
        await session.persist();
        ui.writeSystem(
          `(the model call failed — ${active.model} likely doesn't support image input, and no vision route is ` +
            'configured for this session; see "Vision routing" in the README, or /config set visionModel. The ' +
            "image has been dropped from this conversation so it won't keep failing every later turn too. " +
            `Original error: ${message})`,
        );
      } else {
        ui.writeSystem(`(the model call failed: ${message})`);
      }
      return;
    }

    ui.setBusy(false);
    ui.endAssistantMessage();
    session.messages.push(result.assistantMessage);
    session.recordUsage(result.usage.inputTokens, result.usage.outputTokens);
    if (wasShowingImage) consumeImageMessage(session, "already shown to the model above");

    ui.setStatus({
      tokens: session.usage.inputTokens + session.usage.outputTokens,
      costUsd: session.costUsd,
      model: session.model,
    });
    await session.persist();

    const toolCalls = result.assistantMessage.toolCalls;
    if (result.stopReason !== "tool_use" || !toolCalls?.length) {
      if (result.assistantMessage.content.trim() === "") {
        ui.writeSystem("(the model returned an empty response — try rephrasing, or check /cost for context size)");
      }
      return;
    }

    const repeatStop = guard.checkRepetition(toolCalls);
    if (repeatStop) {
      ui.writeSystem(repeatStop);
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
      session.messages.push({ role: "assistant", content: repeatStop });
      await session.persist();
      return;
    }

    const { results, images } = await runToolCallBatch(toolCalls, session, ui, tools, permissions);

    session.messages.push({ role: "tool", results });
    if (images.length > 0) {
      nextCallNeedsVision = true;
      session.messages.push({ role: "user", content: "(image result from the tool call above)", images });
    }
    await session.persist();
  }
}
