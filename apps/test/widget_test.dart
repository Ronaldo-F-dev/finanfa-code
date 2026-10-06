import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:finanfa/core/server_connection.dart';
import 'package:finanfa/main.dart';
import 'package:finanfa/state/language_provider.dart';
import 'package:finanfa/state/server_connection_provider.dart';

/// In-memory stand-in for FlutterSecureStorage — the real plugin talks to a
/// platform channel that doesn't exist in a widget test's environment, so
/// exercising ServerConnectionStore for real here would throw
/// MissingPluginException on every read/write.
class _FakeConnectionStore implements ServerConnectionStore {
  ServerConnection? _saved;
  @override
  Future<ServerConnection?> load() async => _saved;
  @override
  Future<void> save(ServerConnection connection) async => _saved = connection;
  @override
  Future<void> clear() async => _saved = null;
}

/// Pins the UI to English. The real notifier reads the device locale, so on
/// a French machine the label asserted below rendered "URL du serveur" and
/// the test failed for a reason that had nothing to do with what it checks.
/// Skipping `build()`'s async SharedPreferences load also keeps this test
/// free of the platform channel no widget test registers.
class _EnglishLanguage extends LanguageNotifier {
  @override
  String build() => 'en';
}

void main() {
  testWidgets('shows the connect screen when no server is configured yet', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          languageProvider.overrideWith(_EnglishLanguage.new),
          serverConnectionStoreProvider.overrideWithValue(
            _FakeConnectionStore(),
          ),
        ],
        child: const FinanfaApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('finanfa'), findsOneWidget);
    // The label sits above the field, uppercased (LabeledField), rather than
    // as a Material floating label inside it — the old
    // widgetWithText(TextField, ...) finder dates from before that widget
    // existed and could never match again.
    expect(find.text('SERVER URL'), findsOneWidget);
    expect(find.byType(TextField), findsOneWidget);
  });
}
