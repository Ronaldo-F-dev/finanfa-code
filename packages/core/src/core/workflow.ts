import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { sessionDir } from "./session.js";

// Durable, checkpointed multi-step execution — the real gap this project
// had relative to LangGraph's checkpointing/resume: `task` (task.ts)
// already runs one independent sub-agent to completion and reports back,
// but a MULTI-step pipeline had no persisted progress, so a crash (or an
// interrupt) partway through meant starting over from step one, however
// many steps had already genuinely finished.
//
// Disclosed scope reduction vs a full LangGraph-style state graph: steps
// run strictly in sequence (no conditional branching/routing based on a
// step's own output, no parallel steps) — a linear pipeline covers the
// common case (plan -> implement -> test -> review) and is what most
// real multi-step agent work actually needs; a full graph engine with
// conditional edges is a separate, larger undertaking than this pass.
export interface WorkflowStepDefinition {
  name: string;
  /** May reference {{previousResult}}, substituted with the prior step's full report text — simple sequential data flow between steps. */
  prompt: string;
}

export interface WorkflowStepResult {
  name: string;
  report: string;
  isError: boolean;
}

export type WorkflowStatus = "running" | "completed" | "failed";

export interface WorkflowState {
  id: string;
  cwd: string;
  steps: WorkflowStepDefinition[];
  /** Index of the next step to run — steps before this index have already completed. */
  currentStepIndex: number;
  results: WorkflowStepResult[];
  status: WorkflowStatus;
  createdAt: string;
  updatedAt: string;
}

function workflowsDir(cwd: string): string {
  // Reuses the same per-project directory convention as sessions
  // (~/.finanfa-code/sessions/<project-hash>/) rather than inventing a
  // separate root, since a workflow is conceptually as session-scoped as
  // a conversation transcript is.
  return path.join(sessionDir(cwd), "workflows");
}

export function workflowFilePath(cwd: string, id: string): string {
  return path.join(workflowsDir(cwd), `${id}.json`);
}

export function newWorkflowState(cwd: string, steps: WorkflowStepDefinition[]): WorkflowState {
  const now = new Date().toISOString();
  return { id: randomUUID(), cwd, steps, currentStepIndex: 0, results: [], status: "running", createdAt: now, updatedAt: now };
}

export async function saveWorkflowState(state: WorkflowState): Promise<void> {
  const dir = workflowsDir(state.cwd);
  await mkdir(dir, { recursive: true });
  const file = workflowFilePath(state.cwd, state.id);
  const tmp = `${file}.tmp`;
  state.updatedAt = new Date().toISOString();
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
  await rename(tmp, file);
}

export async function loadWorkflowState(cwd: string, id: string): Promise<WorkflowState | undefined> {
  try {
    return JSON.parse(await readFile(workflowFilePath(cwd, id), "utf-8")) as WorkflowState;
  } catch {
    return undefined;
  }
}

export async function listWorkflows(cwd: string): Promise<WorkflowState[]> {
  try {
    const entries = await readdir(workflowsDir(cwd));
    const states = await Promise.all(
      entries.filter((e) => e.endsWith(".json")).map((e) => loadWorkflowState(cwd, e.replace(/\.json$/, ""))),
    );
    return states.filter((s): s is WorkflowState => s !== undefined).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  } catch {
    return [];
  }
}

export async function deleteWorkflow(cwd: string, id: string): Promise<void> {
  await rm(workflowFilePath(cwd, id), { force: true });
}

export function substitutePreviousResult(prompt: string, previousResult: string | undefined): string {
  return prompt.replaceAll("{{previousResult}}", previousResult ?? "");
}
