import type { TodoItem, TodoStatus } from "../hooks/useAgentSocket";
import { useLanguage } from "../i18n/LanguageContext";

const COLUMNS: { status: TodoStatus; labelKey: string }[] = [
  { status: "pending", labelKey: "todos.pending" },
  { status: "in_progress", labelKey: "todos.inProgress" },
  { status: "completed", labelKey: "todos.completed" },
];

/**
 * A real visual board for the current todo_write checklist — previously
 * only ever shown as a plain "[ ]/[~]/[x]" text line in the chat log,
 * gone the moment it scrolled out of view. Purely a live mirror of
 * session.todos (see AgentSession/TodoStore): the agent is still the
 * only writer (via todo_write), this panel has no edit controls of its
 * own — a real board would let a human drag a card between columns too,
 * but that would need a new tool call round-trip back to the agent for
 * something the agent itself already tracks turn to turn.
 */
export function TodoPanel({ todos, onClose }: { todos: TodoItem[]; onClose: () => void }) {
  const { t } = useLanguage();

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal" onClick={(e) => e.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-icon">🗂️</span>
          <span className="panel-header-title">{t("todos.title")}</span>
          <button className="panel-header-close" onClick={onClose} aria-label={t("settings.close")}>
            ×
          </button>
        </div>

        {todos.length === 0 ? (
          <div className="sidebar-empty">{t("todos.empty")}</div>
        ) : (
          <div className="todo-board">
            {COLUMNS.map((col) => {
              const items = todos.filter((td) => td.status === col.status);
              return (
                <div className="todo-column" key={col.status}>
                  <div className="todo-column-header">
                    <span>{t(col.labelKey)}</span>
                    <span className="todo-column-count">{items.length}</span>
                  </div>
                  <div className="todo-column-body">
                    {items.map((td, i) => (
                      <div className="todo-card" key={i}>
                        {td.content}
                      </div>
                    ))}
                    {items.length === 0 && <div className="todo-column-empty">—</div>}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
