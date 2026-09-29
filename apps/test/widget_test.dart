import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:finanfa/core/server_connection.dart';
import 'package:finanfa/main.dart';
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

void main() {
  testWidgets('shows the connect screen when no server is configured yet', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          serverConnectionStoreProvider.overrideWithValue(
            _FakeConnectionStore(),
          ),
        ],
        child: const FinanfaApp(),
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text('finanfa'), findsOneWidget);
    expect(find.widgetWithText(TextField, 'Server URL'), findsOneWidget);
  });
}
