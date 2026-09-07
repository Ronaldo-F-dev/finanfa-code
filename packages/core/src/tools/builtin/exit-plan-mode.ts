import type { ToolDefinition } from "../../core/types.js";

// Real Claude Code's plan mode: while active (toggled via /plan), the
// agent can freely use read-only tools to research but every mutating
// tool is auto-denied without even prompting (see loop.ts's runOneToolCall)
// — the whole point is forcing "look before you act" on a task big enough
// to warrant it. This tool is the only way out: present the plan, and if
// the user approves (an ordinary "ask"-risk permission prompt, previewing
// the plan text itself), plan mode turns off and the agent can proceed. A
// decline leaves plan mode on with no side effect beyond the tool result
// telling the model to revise and call this again — the same "deny"
// codepath every other tool already goes through, not a special case.
interface ExitPlanModeInput {
  plan: string;
}

export const exitPlanModeTool: ToolDefinition<ExitPlanModeInput> = {
  name: "exit_plan_mode",
  description:
    "Call this once you've finished researching and are ready to present your implementation plan for approval, " +
    "before making any changes. Only relevant while in plan mode: while active, every tool except read-only " +
    "ones and this one is blocked automatically. Pass the full plan as markdown in `plan` — the user sees it and " +
    "either approves (plan mode turns off, proceed with the implementation) or declines (plan mode stays on — " +
    "revise the plan based on their feedback and call this again).",
  riskLevel: "ask",
  inputSchema: {
    type: "object",
    properties: {
      plan: { type: "string", description: "The full plan, as markdown, for the user to review before approving" },
    },
    required: ["plan"],
  },
  describeCall: () => "present a plan for approval, to exit plan mode",
  async preview(input) {
    return input.plan;
  },
  async handler(input, ctx) {
    ctx.exitPlanMode?.();
    return { content: "Plan approved — plan mode is now off. Proceed with the implementation.", isError: false };
  },
};
