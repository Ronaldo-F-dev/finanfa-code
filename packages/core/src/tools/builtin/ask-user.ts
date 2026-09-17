import type { ToolDefinition } from "../../core/types.js";

// Lets the model pause mid-turn and ask the human directly, when it needs
// information only they can provide (a choice between ambiguous options,
// a value it has no way to infer) — without this, the only way to get an
// answer was ending the whole turn on a text question and waiting for
// the next message, losing the tight "ask, get the answer, immediately
// keep using it in the same tool-calling loop" flow a real interactive
// terminal session offers. Uses the same askUser("input") path every
// front-end (CLI/web/VS Code/headless channels) already implements for
// its own prompts, so no new UI plumbing was needed.
interface AskUserInput {
  question: string;
}

export const askUserTool: ToolDefinition<AskUserInput> = {
  name: "ask_user",
  description:
    "Pause and ask the user a direct question when you genuinely need information only they can provide to " +
    "continue correctly — a choice between real options, a value you can't infer or find yourself, clarification " +
    "on ambiguous instructions. The answer becomes this tool's result, so you can keep working with it right " +
    "away in this same turn. Don't use this for anything you could reasonably figure out yourself (reading a " +
    "file, checking docs, trying a sensible default) — that just wastes the user's time.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question to ask, phrased clearly and completely — the user sees only this text, no other context" },
    },
    required: ["question"],
  },
  describeCall: (input) => `ask: ${input.question}`,
  async handler(input, ctx) {
    if (!ctx.ui) {
      return { content: "ask_user requires an interactive session and is not available here (e.g. a headless/non-interactive run).", isError: true };
    }
    const answer = await ctx.ui.askUser(input.question, "input");
    return { content: answer, isError: false };
  },
};
