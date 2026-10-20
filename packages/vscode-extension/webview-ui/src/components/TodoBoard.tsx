import type { TodoItem, TodoStatus } from "../hooks/useAgentBridge";

const COLUMNS: { status: TodoStatus; label: string }[] = [
  { status: "pending", label: "À faire" },
  { status: "in_progress", label: "En cours" },
  { status: "completed", label: "Terminé" },
];

/**
 * The webview's view of the agent's own todo_write checklist — the last
 * agent-state panel web-client and the Flutter app already had. Purely a
 * live mirror of session.todos (see core's TodoStore): the agent is still
 * the only writer, so this board has no edit controls, same as the web one.
 *
 * It matters most on long turns: the checklist used to scroll out of the
 * timeline as plain [ ]/[~]/[x] lines, leaving no visible progress.
 */
export function TodoBoard({ todos, onClose }: { todos: TodoItem[]; onClose: () => void }) {
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal panel-modal todo-modal" onClick={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <span className="panel-header-title">Tâches</span>
          <button className="panel-header-close" onClick={onClose} aria-label="Fermer">
            ×
          </button>
        </div>
        {todos.length === 0 ? (
          <div className="sidebar-empty">Aucune tâche pour l'instant. L'agent remplit cette liste avec l'outil todo_write.</div>
        ) : (
          <div className="todo-board">
            {COLUMNS.map((column) => (
              <TodoColumn key={column.status} label={column.label} items={todos.filter((todo) => todo.status === column.status)} />
            ))}
          </div>
        )}
        <p className="settings-hint">Ce tableau reflète la liste tenue par l'agent. Il n'est pas modifiable ici.</p>
      </div>
    </div>
  );
}

function TodoColumn({ label, items }: { label: string; items: TodoItem[] }) {
  return (
    <section className="todo-column">
      <div className="todo-column-header">
        <span>{label}</span>
        <span className="todo-column-count">{items.length}</span>
      </div>
      <div className="todo-column-body">
        {items.map((todo, index) => (
          <div className="todo-card" key={index}>
            {todo.content}
          </div>
        ))}
        {items.length === 0 && <div className="todo-column-empty">-</div>}
      </div>
    </section>
  );
}
