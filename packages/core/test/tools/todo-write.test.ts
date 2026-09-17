import { describe, expect, it, vi } from "vitest";
import { todoWriteTool } from "../../src/tools/builtin/todo-write.js";
import { TodoStore } from "../../src/core/todo-store.js";

describe("todo_write tool", () => {
  it("replaces the todo list and formats it as a checklist", async () => {
    const todos = new TodoStore();
    const writeSystem = vi.fn();
    const writeTodos = vi.fn();
    const ctx = {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
      todos,
      ui: { writeSystem, writeTodos } as unknown as import("../../src/ui/adapter.js").UIAdapter,
    };

    const items = [
      { content: "Read the spec", status: "completed" as const },
      { content: "Write the code", status: "in_progress" as const },
      { content: "Ship it", status: "pending" as const },
    ];
    const result = await todoWriteTool.handler({ todos: items }, ctx);

    expect(result.isError).toBe(false);
    expect(todos.format()).toBe("[x] Read the spec\n[~] Write the code\n[ ] Ship it");
    expect(writeSystem).toHaveBeenCalledWith(todos.format());
    expect(writeTodos).toHaveBeenCalledWith(items);
  });

  it("doesn't throw when the UI adapter has no writeTodos hook (e.g. the terminal/ACP adapters)", async () => {
    const todos = new TodoStore();
    const ctx = {
      cwd: "/tmp",
      sessionId: "s",
      signal: new AbortController().signal,
      todos,
      ui: { writeSystem: vi.fn() } as unknown as import("../../src/ui/adapter.js").UIAdapter,
    };
    const result = await todoWriteTool.handler({ todos: [{ content: "x", status: "pending" }] }, ctx);
    expect(result.isError).toBe(false);
  });

  it("returns an error when no session context is available", async () => {
    const ctx = { cwd: "/tmp", sessionId: "s", signal: new AbortController().signal };
    const result = await todoWriteTool.handler({ todos: [{ content: "x", status: "pending" }] }, ctx);
    expect(result.isError).toBe(true);
  });
});
