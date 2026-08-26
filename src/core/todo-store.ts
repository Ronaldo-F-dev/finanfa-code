export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
}

const STATUS_MARKER: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
};

/** Per-session checklist, set by the todo_write tool and shown live to the user. */
export class TodoStore {
  private items: TodoItem[] = [];

  set(items: TodoItem[]): void {
    this.items = items;
  }

  list(): TodoItem[] {
    return this.items;
  }

  format(): string {
    if (this.items.length === 0) return "(no todos)";
    return this.items.map((t) => `${STATUS_MARKER[t.status]} ${t.content}`).join("\n");
  }
}
