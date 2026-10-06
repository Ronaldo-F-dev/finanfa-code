import 'package:flutter/material.dart';

import '../core/models/session_models.dart';
import '../theme.dart';

/// A compact, collapsible checklist of the agent's own todo_write tasks.
///
/// The app already received and stored them (AgentSessionController.todos,
/// fed by the socket's "todos" event) but nothing ever rendered them — the
/// user could not see the plan the agent was following. Mirrors the web
/// client's TodoPanel in spirit, sized for a phone: it sits above the
/// conversation and only takes space while there is at least one task.
class TodoBoard extends StatefulWidget {
  final List<TodoItem> todos;

  /// Passed in (rather than read from a provider here) so this stays a
  /// plain widget, directly testable without a ProviderScope.
  final String title;

  const TodoBoard({super.key, required this.todos, required this.title});

  @override
  State<TodoBoard> createState() => _TodoBoardState();
}

class _TodoBoardState extends State<TodoBoard> {
  // Open while work is happening is the useful default — seeing what the
  // agent is doing is the whole point; the header still lets a user reclaim
  // the screen space with one tap.
  bool _expanded = true;

  @override
  Widget build(BuildContext context) {
    if (widget.todos.isEmpty) return const SizedBox.shrink();
    final c = context.colors;
    final done = widget.todos
        .where((todo) => todo.status == TodoStatus.completed)
        .length;
    final header = '${widget.title} · $done/${widget.todos.length}';
    return Container(
      margin: const EdgeInsets.fromLTRB(16, 8, 16, 0),
      decoration: BoxDecoration(
        color: c.bgElevated,
        borderRadius: BorderRadius.circular(FinanfaRadii.md),
        border: Border.all(color: c.border),
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          InkWell(
            borderRadius: BorderRadius.circular(FinanfaRadii.md),
            onTap: () => setState(() => _expanded = !_expanded),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
              child: Row(
                children: [
                  Icon(Icons.checklist_rounded, size: 16, color: c.accent),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      header,
                      style: TextStyle(
                        color: c.text,
                        fontWeight: FontWeight.w600,
                        fontSize: 13,
                      ),
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: c.textMuted,
                  ),
                ],
              ),
            ),
          ),
          if (_expanded)
            Padding(
              padding: const EdgeInsets.fromLTRB(12, 0, 12, 10),
              child: Column(
                children: [
                  for (final todo in widget.todos)
                    Padding(
                      padding: const EdgeInsets.symmetric(vertical: 2),
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Icon(
                            switch (todo.status) {
                              TodoStatus.completed => Icons.check_circle,
                              TodoStatus.inProgress => Icons.autorenew,
                              TodoStatus.pending =>
                                Icons.radio_button_unchecked,
                            },
                            size: 15,
                            color: switch (todo.status) {
                              TodoStatus.completed => c.success,
                              TodoStatus.inProgress => c.accent,
                              TodoStatus.pending => c.textMuted,
                            },
                          ),
                          const SizedBox(width: 8),
                          Expanded(
                            child: Text(
                              todo.content,
                              style: TextStyle(
                                fontSize: 13,
                                color: todo.status == TodoStatus.completed
                                    ? c.textMuted
                                    : c.text,
                                decoration: todo.status == TodoStatus.completed
                                    ? TextDecoration.lineThrough
                                    : null,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                ],
              ),
            ),
        ],
      ),
    );
  }
}
