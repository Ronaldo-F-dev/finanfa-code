import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { LlmProvider, NeutralImage, NeutralToolCall, NeutralToolResult, ToolContext } from "./types.js";
import { compactForProvider } from "./context.js";

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
 * Runs a batch of tool calls. Regular tools run sequentially (order and
 * one-at-a-time permission prompts matter for file/shell operations); "task"
 * sub-agent calls are explicitly independent, so any of those in the same
 * batch run concurrently for real parallelism ("co-work"). Any images
 * returned by tools (e.g. a screenshot) are collected separately — most
 * providers don't support images inside tool-result content itself, so the
 * caller surfaces them as a follow-up user message instead.
 */
async function runToolCallBatch(
  toolCalls: NeutralToolCall[],
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<ToolBatchOutcome> {
  const outcomes = new Array<ToolCallOutcome>(toolCalls.length);
  const taskIndices: number[] = [];

  for (const [i, call] of toolCalls.entries()) {
    if (call.name === "task") {
      taskIndices.push(i);
      continue;
    }
    outcomes[i] = await runOneToolCall(call, session, ui, tools, permissions);
  }

  await Promise.all(
    taskIndices.map(async (i) => {
      outcomes[i] = await runOneToolCall(toolCalls[i], session, ui, tools, permissions);
    }),
  );

  return {
    results: outcomes.map((o) => o.result),
    images: outcomes.flatMap((o) => o.images ?? []),
  };
}

export async function runTurn(
  session: AgentSession,
  provider: LlmProvider,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
  userInput: string,
): Promise<void> {
  session.messages.push({ role: "user", content: userInput });

  for (;;) {
    ui.setBusy(true, "thinking");
    const result = await provider.streamTurn({
      model: session.model,
      systemPrompt: session.systemPrompt,
      messages: compactForProvider(session.messages),
      tools: tools.list(),
      onTextDelta: (text) => ui.writeAssistantDelta(text),
    });

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

    const { results, images } = await runToolCallBatch(toolCalls, session, ui, tools, permissions);

    session.messages.push({ role: "tool", results });
    if (images.length > 0) {
      session.messages.push({ role: "user", content: "(image result from the tool call above)", images });
    }
    await session.persist();
  }
}
