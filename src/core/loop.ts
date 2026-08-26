import Anthropic from "@anthropic-ai/sdk";
import type { AgentSession } from "./session.js";
import type { UIAdapter } from "../ui/adapter.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { PermissionManager } from "../permissions/manager.js";
import type { ToolContext } from "./types.js";

const client = new Anthropic();

export async function runTurn(
  session: AgentSession,
  ui: UIAdapter,
  tools: ToolRegistry,
  permissions: PermissionManager,
  userInput: string,
): Promise<void> {
  session.messages.push({ role: "user", content: userInput });
  const toolList = tools.toAnthropicToolList();

  for (;;) {
    const stream = client.messages.stream({
      model: session.model,
      max_tokens: 8192,
      system: session.systemPrompt,
      messages: session.messages,
      tools: toolList.length > 0 ? toolList : undefined,
    });

    stream.on("text", (delta) => ui.writeAssistantDelta(delta));

    const message = await stream.finalMessage();
    session.messages.push({ role: "assistant", content: message.content });
    session.recordUsage(message.usage.input_tokens, message.usage.output_tokens);

    ui.setStatus({
      tokens: session.usage.inputTokens + session.usage.outputTokens,
      costUsd: session.costUsd,
      model: session.model,
    });
    await session.persist();

    if (message.stop_reason !== "tool_use") {
      if (message.stop_reason === "refusal") {
        ui.writeSystem("(the model declined to continue this turn)");
      }
      return;
    }

    const toolUses = message.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );
    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const call of toolUses) {
      const tool = tools.get(call.name);
      if (!tool) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: `Unknown tool "${call.name}"`,
        });
        continue;
      }

      const controller = new AbortController();
      const ctx: ToolContext = { cwd: session.cwd, sessionId: session.id, signal: controller.signal };

      const decision = await permissions.check(tool, call.input, ctx);
      if (decision === "deny") {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: "User declined to run this tool.",
        });
        continue;
      }

      ui.writeSystem(`→ ${tool.name}: ${tool.describeCall ? tool.describeCall(call.input) : ""}`);
      try {
        const result = await tool.handler(call.input, ctx);
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: result.isError,
          content: result.content,
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          is_error: true,
          content: err instanceof Error ? err.message : String(err),
        });
      }
    }

    session.messages.push({ role: "user", content: results });
    await session.persist();
  }
}
