import 'package:finanfa/core/models/timeline_item.dart';
import 'package:finanfa/widgets/timeline_tile.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

Widget _wrap(TimelineItem item) => ProviderScope(
  child: MaterialApp(home: Scaffold(body: SingleChildScrollView(child: TimelineTile(item: item)))),
);

void main() {
  testWidgets('an assistant reply never shows the long dash, but a code block keeps its text as written', (tester) async {
    const dash = '—';
    await tester.pumpWidget(
      _wrap(
        AssistantMessageItem(
          id: 'a1',
          text: 'Voici le Dockerfile $dash prêt à l\'emploi.\n```dockerfile\nFROM node:22-alpine\n# a $dash b\n```\n',
          streaming: false,
        ),
      ),
    );

    expect(find.textContaining("Voici le Dockerfile, prêt à l'emploi."), findsOneWidget);
    expect(find.textContaining('Dockerfile $dash'), findsNothing);
    // The block is shown with its language and its text unchanged (rich text: look at the plain text of every selectable).
    final plain = tester
        .widgetList<SelectableText>(find.byType(SelectableText))
        .map((w) => w.textSpan?.toPlainText() ?? w.data ?? '')
        .join('\n');
    expect(plain, contains('FROM node:22-alpine'));
    expect(plain, contains('# a $dash b'));
    expect(find.text('dockerfile'), findsOneWidget);
  });
}
