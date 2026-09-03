import { describe, expect, it, vi } from "vitest";
import { todoWriteTool } from "../../src/tools/builtin/todo-write.js";
import { TodoStore } from "../../src/core/todo-store.js";

describe("todo_write tool", () => {
  it("replaces the todo list and formats it as a checklist", async () => {
    const todos = new TodoStore();
    const writeSystem = vi.fn();
    const ctx = {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
      todos,
      ui: { writeSystem } as unknown as import("../../src/ui/adapter.js").UIAdapter,
    };

    const result = await todoWriteTool.handler(
      {
        todos: [
          { content: "Read the spec", status: "completed" },
          { content: "Write the code", status: "in_progress" },
          { content: "Ship it", status: "pending" },
        ],
      },
      ctx,
    );

    expect(result.isError).toBe(false);
    expect(todos.format()).toBe("[x] Read the spec\n[~] Write the code\n[ ] Ship it");
    expect(writeSystem).toHaveBeenCalledWith(todos.format());
  });

  it("returns an error when no session context is available", async () => {
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
    const result = await todoWriteTool.handler({ todos: [{ content: "x", status: "pending" }] }, ctx);
    expect(result.isError).toBe(true);
  });
});
