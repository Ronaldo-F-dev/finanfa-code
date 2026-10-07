import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/timeline_item.dart';
import 'package:finanfa/widgets/timeline_tile.dart';

// The app showed a tool call as a one-line chip and dropped the
// "tool_result" event entirely, so the agent's real output was invisible.
// These cover the chip's two states: running (inert, muted "…") and
// finished (collapsed by default, reveals the output on tap).
ToolCallItem _item({ToolResult? result}) => ToolCallItem(
  id: 't1',
  toolCallId: 'call-1',
  toolName: 'bash',
  description: 'ls',
  riskLevel: ToolRiskLevel.safe,
  result: result,
);

Widget _wrap(TimelineItem item) => ProviderScope(
  child: MaterialApp(home: Scaffold(body: TimelineTile(item: item))),
);

void main() {
  testWidgets('a running tool call shows the chip and a muted ellipsis', (
    tester,
  ) async {
    await tester.pumpWidget(_wrap(_item()));

    expect(find.text('Bash'), findsOneWidget);
    expect(find.text('ls'), findsOneWidget);
    expect(find.text('…'), findsOneWidget);
  });

  testWidgets('a finished tool call keeps its output collapsed until tapped', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        _item(
          result: const ToolResult(isError: false, content: 'file1\nfile2'),
        ),
      ),
    );

    expect(find.text('file1\nfile2'), findsNothing);

    await tester.tap(find.text('Bash'));
    await tester.pumpAndSettle();

    expect(find.text('file1\nfile2'), findsOneWidget);
  });

  testWidgets('an errored tool call renders its message instead of hiding it', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        _item(
          result: const ToolResult(
            isError: true,
            content: 'ENOENT: no such file',
          ),
        ),
      ),
    );

    await tester.tap(find.text('Bash'));
    await tester.pumpAndSettle();

    expect(find.text('ENOENT: no such file'), findsOneWidget);
  });
}
