import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/session_models.dart';
import 'package:finanfa/widgets/todo_board.dart';

// The app stored the agent's todo_write checklist all along
// (AgentSessionController.todos) but never rendered it; this covers the
// widget that finally does, with no provider/scope needed — the title is
// passed in, so the test drives it directly.
void main() {
  testWidgets('renders nothing while there are no tasks', (tester) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: TodoBoard(todos: [], title: 'Tasks')),
      ),
    );

    expect(find.textContaining('Tasks'), findsNothing);
  });

  testWidgets('shows the progress count and every task, and collapses on tap', (
    tester,
  ) async {
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: TodoBoard(
            title: 'Tasks',
            todos: [
              TodoItem(content: 'Write the plan', status: TodoStatus.completed),
              TodoItem(content: 'Implement it', status: TodoStatus.inProgress),
              TodoItem(content: 'Ship it', status: TodoStatus.pending),
            ],
          ),
        ),
      ),
    );

    expect(find.text('Tasks · 1/3'), findsOneWidget);
    expect(find.text('Write the plan'), findsOneWidget);
    expect(find.text('Implement it'), findsOneWidget);
    expect(find.text('Ship it'), findsOneWidget);

    await tester.tap(find.text('Tasks · 1/3'));
    await tester.pumpAndSettle();

    expect(find.text('Write the plan'), findsNothing);
    expect(find.text('Tasks · 1/3'), findsOneWidget);
  });
}
