import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { LlmProvider, NeutralToolCall, NeutralToolResult, ToolContext } from "./types.js";

async function runOneToolCall(
  call: NeutralToolCall,
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
): Promise<NeutralToolResult> {
  const tool = tools.get(call.name);
  if (!tool) {
    return { toolCallId: call.id, isError: true, content: `Unknown tool "${call.name}"` };
  }

  const ctx: ToolContext = { cwd: session.cwd, sessionId: session.id, signal: new AbortController().signal };

  const decision = await permissions.check(tool, call.input, ctx);
  if (decision === "deny") {
    return { toolCallId: call.id, isError: true, content: "User declined to run this tool." };
  }

  ui.writeSystem(`→ ${tool.name}: ${tool.describeCall ? tool.describeCall(call.input) : ""}`);
  try {
    const result = await tool.handler(call.input, ctx);
    return { toolCallId: call.id, isError: result.isError, content: result.content };
  } catch (err) {
    return { toolCallId: call.id, isError: true, content: err instanceof Error ? err.message : String(err) };
  }
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
    const result = await provider.streamTurn({
      model: session.model,
      systemPrompt: session.systemPrompt,
      messages: session.messages,
      tools: tools.list(),
      onTextDelta: (text) => ui.writeAssistantDelta(text),
    });

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
      return;
    }

    const results: NeutralToolResult[] = [];
    for (const call of toolCalls) {
      results.push(await runOneToolCall(call, session, ui, tools, permissions));
    }

    session.messages.push({ role: "tool", results });
    await session.persist();
  }
}
