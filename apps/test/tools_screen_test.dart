import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/models/session_models.dart';
import 'package:finanfa/screens/tools_screen.dart';
import 'package:finanfa/state/agent_session_controller.dart';
import 'package:finanfa/state/agent_session_provider.dart';
import 'package:finanfa/state/language_provider.dart';

/// Pins the UI to English, like the connect-screen test — the real notifier
/// reads the device locale and skips its async preferences load this way.
class _EnglishLanguage extends LanguageNotifier {
  @override
  String build() => 'en';
}

void main() {
  testWidgets("lists the session's tools, then narrows by risk tab and search", (
    tester,
  ) async {
    final controller = AgentSessionController();
    controller.toolsStatus = const [
      ToolStatus(name: "read_file", riskLevel: "safe", enabled: true),
      ToolStatus(name: "write_file", riskLevel: "ask", enabled: true),
      ToolStatus(name: "bash", riskLevel: "dangerous", enabled: false),
    ];
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          agentSessionProvider.overrideWith((ref) => controller),
          languageProvider.overrideWith(_EnglishLanguage.new),
        ],
        child: const MaterialApp(home: ToolsScreen()),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("read_file"), findsOneWidget);
    expect(find.text("bash"), findsOneWidget);
    expect(find.text("2 of 3 enabled."), findsOneWidget);

    // A risk tab narrows the list to that level only.
    await tester.tap(find.text("Dangerous · 1"));
    await tester.pumpAndSettle();
    expect(find.text("bash"), findsOneWidget);
    expect(find.text("read_file"), findsNothing);

    // Back to all, then the search narrows further on its own.
    await tester.tap(find.text("All · 3"));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), "write");
    await tester.pumpAndSettle();
    expect(find.text("write_file"), findsOneWidget);
    expect(find.text("read_file"), findsNothing);
  });
}
