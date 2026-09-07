import type { LlmProvider, ToolDefinition } from "../../core/types.js";
import { AgentSession } from "../../core/session.js";
import { runTurn, isLoopGuardStopMessage } from "../../core/loop.js";
import { ToolRegistry } from "../registry.js";
import type { PermissionManager } from "../../permissions/manager.js";
import type { UIAdapter } from "../../ui/adapter.js";
import { SUBAGENT_SYSTEM_PROMPT } from "./task.js";
import {
  newWorkflowState,
  loadWorkflowState,
  saveWorkflowState,
  listWorkflows,
  substitutePreviousResult,
  type WorkflowState,
  type WorkflowStepDefinition,
} from "../../core/workflow.js";

export interface WorkflowToolDeps {
  provider: LlmProvider;
  tools: ToolRegistry;
  permissions: PermissionManager;
  ui: UIAdapter;
  model: string;
  cwd: string;
}

/** Wraps the real UIAdapter so a workflow step's activity is visibly tagged but doesn't spam live token deltas — same approach as task.ts's wrapUiForSubagent. */
function wrapUiForStep(ui: UIAdapter, label: string): UIAdapter {
  const prefix = `[workflow:${label}]`;
  return {
    writeAssistantDelta: () => {},
    endAssistantMessage: () => {},
    writeBanner: () => {},
    writeSystem: (text) => ui.writeSystem(`${prefix} ${text}`),
    writeError: (text) => ui.writeError(`${prefix} ${text}`),
    setStatus: () => {},
    getStatus: () => ui.getStatus(),
    setBusy: (busy, subLabel) => ui.setBusy(busy, busy ? `${prefix} ${subLabel ?? "working"}` : undefined),
    setCommands: () => {},
    askUser: (prompt, kind) => ui.askUser(`${prefix} ${prompt}`, kind),
    close: () => {},
  };
}

async function runStep(deps: WorkflowToolDeps, step: WorkflowStepDefinition, previousResult: string | undefined): Promise<{ report: string; isError: boolean }> {
  const subTools = new ToolRegistry();
  for (const tool of deps.tools.list()) {
    if (tool.name !== "run_workflow") subTools.register(tool); // a workflow step can't recursively spawn another workflow
  }

  const session = new AgentSession({ cwd: deps.cwd, model: deps.model, systemPrompt: SUBAGENT_SYSTEM_PROMPT });
  const ui = wrapUiForStep(deps.ui, step.name);
  const prompt = substitutePreviousResult(step.prompt, previousResult);

  await runTurn(session, deps.provider, ui, subTools, deps.permissions, prompt);

  const lastAssistant = [...session.messages].reverse().find((m) => m.role === "assistant");
  const report = lastAssistant?.role === "assistant" && lastAssistant.content.length > 0 ? lastAssistant.content : "(step finished with no final text)";
  return { report, isError: isLoopGuardStopMessage(report) };
}

async function runWorkflowFromCurrentStep(deps: WorkflowToolDeps, state: WorkflowState): Promise<WorkflowState> {
  while (state.currentStepIndex < state.steps.length) {
    const step = state.steps[state.currentStepIndex]!;
    const previousResult = state.results.at(-1)?.report;
    const { report, isError } = await runStep(deps, step, previousResult);

    state.results.push({ name: step.name, report, isError });
    state.currentStepIndex++;
    state.status = isError ? "failed" : state.currentStepIndex >= state.steps.length ? "completed" : "running";
    // Checkpointed after EVERY step, not just at the end — this is the
    // actual point of the feature: a crash/interrupt here resumes from
    // the next step, not step zero, however many already genuinely
    // finished.
    await saveWorkflowState(state);

    if (isError) break;
  }
  return state;
}

function formatWorkflowState(state: WorkflowState): string {
  const lines = [`Workflow ${state.id} — ${state.status} (${state.currentStepIndex}/${state.steps.length} step(s) done):`, ""];
  for (const result of state.results) {
    lines.push(`[${result.isError ? "FAILED" : "done"}] ${result.name}:`);
    lines.push(result.report);
    lines.push("");
  }
  if (state.status === "running") lines.push(`Next step: ${state.steps[state.currentStepIndex]?.name}`);
  if (state.status === "failed") lines.push(`Workflow stopped after a failed step. Resume with run_workflow's workflowId "${state.id}" after addressing the failure, or start a new one.`);
  return lines.join("\n").trimEnd();
}

interface RunWorkflowInput {
  steps?: { name: string; prompt: string }[];
  workflowId?: string;
}

interface ListWorkflowsInput {
  status?: "running" | "completed" | "failed";
}

export function createWorkflowTools(deps: WorkflowToolDeps): ToolDefinition[] {
  const runWorkflow: ToolDefinition<RunWorkflowInput> = {
    name: "run_workflow",
    description:
      "Run a sequence of named steps, each as an independent sub-agent (same tools/permissions as you), " +
      "checkpointed to disk after every step — a crash or interrupt resumes from the next step, not the " +
      "beginning. A step's prompt may reference {{previousResult}}, substituted with the prior step's full " +
      "report, for simple sequential data flow (e.g. plan -> implement -> test -> review). Pass `steps` to " +
      "start a new workflow, or `workflowId` alone (from a previous run_workflow/list_workflows call) to " +
      "resume one that's still 'running' or retry one that's 'failed' from where it left off. Stops (status " +
      "'failed') if a step's own turn hits the loop guard (repetition/iteration cap) — does not attempt " +
      "conditional branching between steps; steps always run in the given order.",
    riskLevel: "safe", // each step's own tool calls are individually permission-checked as usual, same as `task`
    inputSchema: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: { type: "object", properties: { name: { type: "string" }, prompt: { type: "string" } }, required: ["name", "prompt"] },
          description: "Ordered list of steps to run (required to start a new workflow)",
        },
        workflowId: { type: "string", description: "Resume/retry an existing workflow by id instead of starting a new one" },
      },
    },
    describeCall: (input) => (input.workflowId ? `resume workflow ${input.workflowId}` : `run workflow: ${(input.steps ?? []).map((s) => s.name).join(" -> ")}`),
    async handler(input) {
      let state: WorkflowState;
      if (input.workflowId) {
        const existing = await loadWorkflowState(deps.cwd, input.workflowId);
        if (!existing) return { content: `No workflow found with id "${input.workflowId}" in this project.`, isError: true };
        if (existing.status === "completed") return { content: formatWorkflowState(existing), isError: false };
        state = existing.status === "failed" ? { ...existing, status: "running" } : existing;
      } else {
        if (!input.steps || input.steps.length === 0) return { content: "Provide `steps` to start a new workflow, or `workflowId` to resume/retry an existing one.", isError: true };
        state = newWorkflowState(deps.cwd, input.steps);
        await saveWorkflowState(state);
      }

      const finalState = await runWorkflowFromCurrentStep(deps, state);
      return { content: formatWorkflowState(finalState), isError: finalState.status === "failed" };
    },
  };

  const listWorkflowsTool: ToolDefinition<ListWorkflowsInput> = {
    name: "list_workflows",
    description: "List workflows started via run_workflow in this project, with their id/status/progress.",
    riskLevel: "safe",
    inputSchema: { type: "object", properties: { status: { type: "string", enum: ["running", "completed", "failed"], description: "Filter to only this status" } } },
    describeCall: (input) => `list workflows${input.status ? ` (${input.status})` : ""}`,
    async handler(input) {
      const all = await listWorkflows(deps.cwd);
      const filtered = input.status ? all.filter((w) => w.status === input.status) : all;
      if (filtered.length === 0) return { content: "No workflows found.", isError: false };
      const lines = filtered.map((w) => `${w.id}: ${w.status} (${w.currentStepIndex}/${w.steps.length}) — steps: ${w.steps.map((s) => s.name).join(" -> ")}`);
      return { content: lines.join("\n"), isError: false };
    },
  };

  return [runWorkflow, listWorkflowsTool];
}
