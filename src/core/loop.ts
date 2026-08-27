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
    return {
      result: { toolCallId: call.id, isError: result.isError, content: result.content },
      images: result.images,
    };
  } catch (err) {
    return {
      result: { toolCallId: call.id, isError: true, content: err instanceof Error ? err.message : String(err) },
    };
  } finally {
    ui.setBusy(false);
  }
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
      `(stopped after ${MAX_ITERATIONS} steps without finishing — the task may be stuck or too large; ` +
      "try breaking it into smaller requests)"
    );
  }

  /** A message to show and stop on, once the exact same tool call batch repeats REPEAT_LIMIT times — else undefined. */
  checkRepetition(toolCalls: NeutralToolCall[]): string | undefined {
    const signature = toolCallBatchSignature(toolCalls);
    this.repeatCount = signature === this.lastSignature ? this.repeatCount + 1 : 1;
    this.lastSignature = signature;
    if (this.repeatCount < REPEAT_LIMIT) return undefined;
    return (
      `(stopped — the same tool call${toolCalls.length > 1 ? "s" : ""} repeated ${REPEAT_LIMIT} times in a ` +
      "row with no apparent progress)"
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
      return;
    }

    // Route only the one call right after a tool produced an image — not
    // every later call in the session, even though that image message stays
    // in history (compactForProvider never strips it). Otherwise a single
    // screenshot early in a long session would pin every future turn onto
    // the (likely pricier/slower) vision model long after it's relevant.
    const active = nextCallNeedsVision && visionRoute ? visionRoute : { provider, model: session.model };
    const sendingImageWithoutVisionRoute = nextCallNeedsVision && !visionRoute;
    nextCallNeedsVision = false;

    ui.setBusy(true, "thinking");
    let result: StreamTurnResult;
    try {
      result = await active.provider.streamTurn({
        model: active.model,
        systemPrompt: session.systemPrompt,
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
      const message = err instanceof Error ? err.message : String(err);
      if (sendingImageWithoutVisionRoute) {
        ui.writeSystem(
          `(the model call failed — ${active.model} likely doesn't support image input, and no vision route is ` +
            'configured for this session; see "Vision routing" in the README, or /config set visionModel. ' +
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
