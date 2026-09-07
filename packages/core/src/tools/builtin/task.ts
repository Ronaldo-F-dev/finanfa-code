import type { LlmProvider, ToolDefinition } from "../../core/types.js";
import { AgentSession } from "../../core/session.js";
import { runTurn, isLoopGuardStopMessage } from "../../core/loop.js";
import { ToolRegistry } from "../registry.js";
import type { PermissionManager } from "../../permissions/manager.js";
import type { UIAdapter } from "../../ui/adapter.js";
import type { SubagentType } from "../../agents/loader.js";

export interface TaskToolDeps {
  provider: LlmProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  ui: UIAdapter;
  model: string;
  cwd: string;
  /** Custom subagent types loaded from .finanfa-code/agents/ (see agents/loader.ts) — selectable via TaskInput.agentType. */
  agentTypes?: SubagentType[];
}

interface TaskInput {
  prompt: string;
  description?: string;
  /** Name of a custom subagent type (see .finanfa-code/agents/) to delegate to instead of the generic default — its own system prompt and, if it sets one, a restricted tool whitelist. */
  agentType?: string;
}

export const SUBAGENT_SYSTEM_PROMPT =
  "You are a sub-agent completing a single delegated task, working autonomously. " +
  "Use the available tools as needed, then finish with a concise final report of what you did and the result.";

/** Wraps the real UIAdapter so a sub-agent's activity is visibly tagged but doesn't spam live token deltas. */
function wrapUiForSubagent(ui: UIAdapter, label: string): UIAdapter {
  const prefix = `[task:${label}]`;
  return {
    writeAssistantDelta: () => {}, // the sub-agent's final report comes back as the tool result instead
    endAssistantMessage: () => {},
    writeBanner: () => {},
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
  const agentTypesByName = new Map((deps.agentTypes ?? []).map((a) => [a.name, a]));
  const agentTypeSummaries = [...agentTypesByName.values()].map((a) => a.name + " (" + a.description + ")");
  const agentTypeNote =
    agentTypeSummaries.length > 0
      ? " Available agentType values (each with its own system prompt, and sometimes a restricted tool set): " + agentTypeSummaries.join("; ") + "."
      : "";

  return {
    name: "task",
    description:
      "Delegate a self-contained piece of work to a sub-agent that runs independently (same tools and " +
      "permissions as you, unless agentType restricts them) and reports back a final summary. Good for " +
      "parallelizable or isolated work — e.g. researching one thing while you do another. Multiple task calls " +
      "in the same turn run concurrently." +
      agentTypeNote,
    riskLevel: "safe", // the sub-agent's own tool calls are each individually permission-checked as usual
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "Full instructions for the sub-agent" },
        description: { type: "string", description: "Short label for this task, shown in logs" },
        agentType: { type: "string", description: "Name of a custom subagent type to delegate to instead of the generic default (see the tool description for available values)" },
      },
      required: ["prompt"],
    },
    describeCall: (input) => {
      const typeSuffix = input.agentType ? ` (${input.agentType})` : "";
      return `task${typeSuffix}: ${input.description ?? input.prompt.slice(0, 60)}`;
    },
    async handler(input) {
      const agentType = input.agentType ? agentTypesByName.get(input.agentType) : undefined;

      // Fresh registry sharing the same tool instances as the parent, minus
      // "task" itself (so a sub-agent can't spawn further sub-agents), and
      // further restricted to agentType's own tool whitelist when it set one.
      const subTools = new ToolRegistry();
      for (const tool of deps.tools.list()) {
        if (tool.name === "task") continue;
        if (agentType?.tools && !agentType.tools.includes(tool.name)) continue;
        subTools.register(tool);
      }

      const systemPrompt = agentType?.systemPrompt || SUBAGENT_SYSTEM_PROMPT;
      const session = new AgentSession({ cwd: deps.cwd, model: deps.model, systemPrompt });
      const label = input.description ?? agentType?.name ?? "subagent";
      const ui = wrapUiForSubagent(deps.ui, label);

      await runTurn(session, deps.provider, ui, subTools, deps.permissions, input.prompt);

      const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
      const finalText = lastAssistant?.role === "assistant" && lastAssistant.content.length > 0
        ? lastAssistant.content
        : "(sub-agent finished with no final text)";

      // Used to hardcode isError: false unconditionally — a sub-agent that
      // silently ran out of budget (hit LoopGuard's iteration/repetition
      // cap) was indistinguishable from one that actually finished, so
      // nothing downstream (e.g. the system prompt's own "implement, test,
      // push, open PR" pattern) could reliably branch on whether a
      // delegated step actually completed.
      return { content: finalText, isError: isLoopGuardStopMessage(finalText) };
    },
  };
}
