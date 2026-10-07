import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/timeline_item.dart';
import 'package:finanfa/widgets/timeline_tile.dart';

// The app dropped "thinking_delta" entirely, so the model's reasoning never
// reached the screen while the web and the CLI have shown it for a while.
// These cover the tile's two states: still streaming ("…", collapsed) and
// finished (chevron, reveals the reasoning on tap).
Widget _wrap(TimelineItem item) => ProviderScope(
  child: MaterialApp(home: Scaffold(body: TimelineTile(item: item))),
);

void main() {
  testWidgets('a streaming reasoning block shows its label and a muted …', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(const ThinkingItem(id: 't1', text: 'weighing options', streaming: true)),
    );

    expect(find.text('Reasoning'), findsOneWidget);
    expect(find.text('…'), findsOneWidget);
    // Collapsed by default, even while streaming.
    expect(find.text('weighing options'), findsNothing);
  });

  testWidgets('a finished reasoning block reveals its text on tap', (
    tester,
  ) async {
    await tester.pumpWidget(
      _wrap(
        const ThinkingItem(
          id: 't1',
          text: 'weighing the options carefully',
          streaming: false,
        ),
      ),
    );

    expect(find.text('weighing the options carefully'), findsNothing);

    await tester.tap(find.text('Reasoning'));
    await tester.pumpAndSettle();

    expect(find.text('weighing the options carefully'), findsOneWidget);
  });
}
