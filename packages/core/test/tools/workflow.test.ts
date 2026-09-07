import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ToolRegistry } from "../../src/tools/registry.js";
import { createWorkflowTools } from "../../src/tools/builtin/workflow.js";
import { SUBAGENT_SYSTEM_PROMPT } from "../../src/tools/builtin/task.js";
import { PermissionManager } from "../../src/permissions/manager.js";
import { DEFAULT_PERMISSION_CONFIG } from "../../src/permissions/config.js";
import type { LlmProvider, StreamTurnParams, StreamTurnResult } from "../../src/core/types.js";
import type { UIAdapter } from "../../src/ui/adapter.js";
import { loadWorkflowState, saveWorkflowState, newWorkflowState } from "../../src/core/workflow.js";

function makeStubUi(): UIAdapter {
  return {
    writeAssistantDelta: vi.fn(),
    endAssistantMessage: vi.fn(),
    writeBanner: vi.fn(),
    writeSystem: vi.fn(),
    writeError: vi.fn(),
    setStatus: vi.fn(),
    getStatus: vi.fn().mockReturnValue(undefined),
    setCommands: vi.fn(),
    setBusy: vi.fn(),
    askUser: vi.fn().mockResolvedValue(""),
    close: vi.fn(),
  };
}

/** Every step's sub-agent just echoes its own (post-substitution) prompt back as its final report. */
class EchoProvider implements LlmProvider {
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    const userPrompt = params.messages.find((m) => m.role === "user")?.content ?? "";
    return { assistantMessage: { role: "assistant", content: `echo: ${userPrompt}` }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
  }
}

/** Every step's sub-agent gets stuck calling the same tool forever — trips the repetition guard, never finishes. */
class StuckProvider implements LlmProvider {
  async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
    void params;
    return {
      assistantMessage: { role: "assistant", content: "", toolCalls: [{ id: "x", name: "noop", input: {} }] },
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: "tool_use",
    };
  }
}

describe("run_workflow / list_workflows (checkpointed multi-step execution)", () => {
  let cwd: string;
  let homeDir: string;
  let originalHome: string | undefined;
  let tools: ToolRegistry;
  let ui: UIAdapter;
  let permissions: PermissionManager;

  beforeEach(async () => {
    cwd = await mkdtemp(path.join(tmpdir(), "finanfa-workflow-project-"));
    homeDir = await mkdtemp(path.join(tmpdir(), "finanfa-workflow-home-"));
    originalHome = process.env.HOME;
    process.env.HOME = homeDir;

    tools = new ToolRegistry();
    tools.register({ name: "noop", description: "", riskLevel: "safe", inputSchema: { type: "object" }, handler: async () => ({ content: "ok", isError: false }) });
    ui = makeStubUi();
    permissions = new PermissionManager({ config: DEFAULT_PERMISSION_CONFIG, ui, yolo: true });
  });

  afterEach(async () => {
    process.env.HOME = originalHome;
    await rm(cwd, { recursive: true, force: true });
    await rm(homeDir, { recursive: true, force: true });
  });

  it("runs steps in sequence, substituting {{previousResult}} between them", async () => {
    const provider = new EchoProvider();
    const [runWorkflow] = createWorkflowTools({ provider, tools, permissions, ui, model: "m", cwd });

    const result = await runWorkflow.handler(
      {
        steps: [
          { name: "plan", prompt: "make a plan" },
          { name: "implement", prompt: "implement this plan: {{previousResult}}" },
        ],
      },
      undefined as never,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("completed");
    expect(result.content).toContain("echo: make a plan");
    expect(result.content).toContain("echo: implement this plan: echo: make a plan");
  });

  it("checkpoints state to disk after every step", async () => {
    let stepsRun = 0;
    class CountingProvider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        void params;
        stepsRun++;
        return { assistantMessage: { role: "assistant", content: `step ${stepsRun} done` }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }
    const provider = new CountingProvider();
    const [runWorkflow] = createWorkflowTools({ provider, tools, permissions, ui, model: "m", cwd });

    const result = await runWorkflow.handler({ steps: [{ name: "one", prompt: "a" }, { name: "two", prompt: "b" }] }, undefined as never);
    const workflowId = result.content.match(/Workflow ([0-9a-f-]{36})/)![1]!;

    const saved = await loadWorkflowState(cwd, workflowId);
    expect(saved?.status).toBe("completed");
    expect(saved?.currentStepIndex).toBe(2);
    expect(saved?.results.map((r) => r.name)).toEqual(["one", "two"]);
  });

  it("resumes from the next step after a simulated crash, instead of re-running completed steps", async () => {
    let stepInvocations: string[] = [];
    class TrackingProvider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        const userPrompt = params.messages.find((m) => m.role === "user")?.content ?? "";
        stepInvocations.push(userPrompt);
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }
    const provider = new TrackingProvider();
    const [runWorkflow] = createWorkflowTools({ provider, tools, permissions, ui, model: "m", cwd });

    // Simulate a crash after step "one" already completed: hand-craft the
    // checkpoint a real first step would have produced, rather than
    // actually running it — isolates the resume path itself.
    const state = newWorkflowState(cwd, [
      { name: "one", prompt: "do one" },
      { name: "two", prompt: "do two" },
      { name: "three", prompt: "do three" },
    ]);
    state.currentStepIndex = 1;
    state.results = [{ name: "one", report: "one's real result", isError: false }];
    await saveWorkflowState(state);

    const result = await runWorkflow.handler({ workflowId: state.id }, undefined as never);

    expect(result.isError).toBe(false);
    expect(stepInvocations).toEqual(["do two", "do three"]); // step "one" was NOT re-run
    expect(result.content).toContain("one's real result"); // the checkpointed result is still in the final report

    const saved = await loadWorkflowState(cwd, state.id);
    expect(saved?.status).toBe("completed");
    expect(saved?.results).toHaveLength(3);
  });

  it("marks the workflow 'failed' and stops when a step's sub-agent hits the repetition guard, without running later steps", async () => {
    const provider = new StuckProvider();
    const [runWorkflow] = createWorkflowTools({ provider, tools, permissions, ui, model: "m", cwd });

    const result = await runWorkflow.handler({ steps: [{ name: "stuck-step", prompt: "get stuck" }, { name: "never-runs", prompt: "x" }] }, undefined as never);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("failed");
    expect(result.content).toContain("FAILED] stuck-step");
    expect(result.content).not.toContain("never-runs:");
  });

  it("rejects run_workflow with neither steps nor workflowId", async () => {
    const [runWorkflow] = createWorkflowTools({ provider: new EchoProvider(), tools, permissions, ui, model: "m", cwd });
    const result = await runWorkflow.handler({}, undefined as never);
    expect(result.isError).toBe(true);
  });

  it("reports an error for an unknown workflowId instead of silently creating a new workflow", async () => {
    const [runWorkflow] = createWorkflowTools({ provider: new EchoProvider(), tools, permissions, ui, model: "m", cwd });
    const result = await runWorkflow.handler({ workflowId: "00000000-0000-0000-0000-000000000000" }, undefined as never);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("No workflow found");
  });

  it("list_workflows reports every saved workflow with its status and progress", async () => {
    const provider = new EchoProvider();
    const [runWorkflow, listWorkflowsTool] = createWorkflowTools({ provider, tools, permissions, ui, model: "m", cwd });
    await runWorkflow.handler({ steps: [{ name: "only-step", prompt: "hi" }] }, undefined as never);

    const list = await listWorkflowsTool.handler({}, undefined as never);
    expect(list.isError).toBe(false);
    expect(list.content).toContain("completed");
    expect(list.content).toContain("only-step");
  });

  it("has 'safe' risk level for both tools (each step's own tool calls are individually permission-checked)", () => {
    const [runWorkflow, listWorkflowsTool] = createWorkflowTools({ provider: new EchoProvider(), tools, permissions, ui, model: "m", cwd });
    expect(runWorkflow.riskLevel).toBe("safe");
    expect(listWorkflowsTool.riskLevel).toBe("safe");
  });

  it("excludes 'run_workflow' itself from a step's sub-agent tools (can't recursively spawn another workflow)", async () => {
    let capturedTools: string[] | undefined;
    class CapturingProvider implements LlmProvider {
      async streamTurn(params: StreamTurnParams): Promise<StreamTurnResult> {
        if (params.systemPrompt.startsWith(SUBAGENT_SYSTEM_PROMPT)) capturedTools = params.tools.map((t) => t.name);
        return { assistantMessage: { role: "assistant", content: "done" }, usage: { inputTokens: 1, outputTokens: 1 }, stopReason: "end_turn" };
      }
    }
    const workflowTools = createWorkflowTools({ provider: new CapturingProvider(), tools, permissions, ui, model: "m", cwd });
    tools.register(workflowTools[0]!);
    const [runWorkflow] = workflowTools;

    await runWorkflow.handler({ steps: [{ name: "step", prompt: "x" }] }, undefined as never);
    expect(capturedTools).toBeDefined();
    expect(capturedTools).not.toContain("run_workflow");
  });
});
