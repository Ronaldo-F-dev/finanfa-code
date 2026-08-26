import type { LlmProvider, ToolDefinition } from "../../core/types.js";
import { AgentSession } from "../../core/session.js";
import { runTurn } from "../../core/loop.js";
import { ToolRegistry } from "../registry.js";
import type { PermissionManager } from "../../permissions/manager.js";
import type { UIAdapter } from "../../ui/adapter.js";

export interface TaskToolDeps {
  provider: LlmProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  ui: UIAdapter;
  model: string;
  cwd: string;
}

interface TaskInput {
  prompt: string;
  description?: string;
}

export const SUBAGENT_SYSTEM_PROMPT =
  "You are a sub-agent completing a single delegated task, working autonomously. " +
  "Use the available tools as needed, then finish with a concise final report of what you did and the result.";

/** Wraps the real UIAdapter so a sub-agent's activity is visibly tagged but doesn't spam live token deltas. */
function wrapUiForSubagent(ui: UIAdapter, label: string): UIAdapter {
  const prefix = `[task:${label}]`;
  return {
    writeAssistantDelta: () => {}, // the sub-agent's final report comes back as the tool result instead
    writeSystem: (text) => ui.writeSystem(`${prefix} ${text}`),
    writeError: (text) => ui.writeError(`${prefix} ${text}`),
    setStatus: () => {}, // don't clobber the parent's status bar with sub-agent token counts
    getStatus: () => ui.getStatus(),
    setBusy: (busy, subLabel) => ui.setBusy(busy, busy ? `${prefix} ${subLabel ?? "working"}` : undefined),
    setCommands: () => {},
    askUser: (prompt, kind) => ui.askUser(`${prefix} ${prompt}`, kind),
    close: () => {},
  };
}

/**
 * Delegated sub-agent tool ("co-work"): runs an independent conversation with
 * its own session but the same tools/permissions/provider as the parent, to
 * completion, and returns its final report as the tool result. Multiple
 * `task` calls within one assistant turn are run concurrently by the agent
 * loop (see core/loop.ts) for real parallelism.
 */
export function createTaskTool(deps: TaskToolDeps): ToolDefinition<TaskInput> {
  return {
    name: "task",
    description:
      "Delegate a self-contained piece of work to a sub-agent that runs independently (same tools and " +
      "permissions as you) and reports back a final summary. Good for parallelizable or isolated work — " +
      "e.g. researching one thing while you do another. Multiple task calls in the same turn run concurrently.",
    riskLevel: "safe", // the sub-agent's own tool calls are each individually permission-checked as usual
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full instructions for the sub-agent" },
        description: { type: "string", description: "Short label for this task, shown in logs" },
      },
      required: ["prompt"],
    },
    describeCall: (input) => `task: ${input.description ?? input.prompt.slice(0, 60)}`,
    async handler(input) {
      // Fresh registry sharing the same tool instances as the parent, minus
      // "task" itself, so a sub-agent can't spawn further sub-agents.
      const subTools = new ToolRegistry();
      for (const tool of deps.tools.list()) {
        if (tool.name !== "task") subTools.register(tool);
      }

      const session = new AgentSession({ cwd: deps.cwd, model: deps.model, systemPrompt: SUBAGENT_SYSTEM_PROMPT });
      const label = input.description ?? "subagent";
      const ui = wrapUiForSubagent(deps.ui, label);

      await runTurn(session, deps.provider, ui, subTools, deps.permissions, input.prompt);

      const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
      const finalText = lastAssistant?.role === "assistant" && lastAssistant.content.length > 0
        ? lastAssistant.content
        : "(sub-agent finished with no final text)";

      return { content: finalText, isError: false };
    },
  };
}
