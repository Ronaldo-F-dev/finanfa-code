import type { ToolDefinition } from "../../core/types.js";
import type { TodoStatus } from "../../core/todo-store.js";

interface TodoWriteInput {
  todos: { content: string; status: TodoStatus }[];
}

export const todoWriteTool: ToolDefinition<TodoWriteInput> = {
  name: "todo_write",
  description:
    "Replace the current task checklist with the given list, shown live to the user. Use this to plan " +
    "multi-step work up front and update item statuses as you make progress — helps the user track long-running tasks.",
  riskLevel: "safe",
  inputSchema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: { type: "string", enum: ["pending", "in_progress", "completed"] },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["todos"],
  },
  describeCall: (input) => `update todo list (${input.todos.length} items)`,
  async handler(input, ctx) {
    if (!ctx.todos) {
      return { content: "todo_write requires a session context and is not available here.", isError: true };
    }
    ctx.todos.set(input.todos);
    ctx.ui?.writeSystem(ctx.todos.format());
    return { content: "Todo list updated.", isError: false };
  },
};
