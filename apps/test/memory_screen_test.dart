import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/api/finanfa_api_client.dart';
import 'package:finanfa/core/models/session_models.dart';
import 'package:finanfa/core/server_connection.dart';
import 'package:finanfa/screens/memory_screen.dart';
import 'package:finanfa/state/api_client_provider.dart';
import 'package:finanfa/state/language_provider.dart';
import 'package:finanfa/state/project_provider.dart';

/// Pins the UI to English, like the other screen tests.
class _EnglishLanguage extends LanguageNotifier {
  @override
  String build() => 'en';
}

/// No project selected — the default workspace, as on a fresh install.
class _NoProject extends CurrentProjectNotifier {
  @override
  String? build() => null;
}

/// A real FinanfaApiClient subclass with its network methods replaced, so
/// the screen's own wiring (fetch on open, expand, delete → refresh) is
/// exercised without a server.
class _FakeClient extends FinanfaApiClient {
  _FakeClient() : super(const ServerConnection(baseUrl: "http://127.0.0.1:1"));

  final List<String> deleted = [];
  List<MemoryEntry> memories = [
    const MemoryEntry(
      name: "stack",
      description: "tech stack",
      type: "project",
      content: "Flutter + Riverpod",
      scope: "global",
    ),
  ];
  List<SkillEntry> skills = [
    const SkillEntry(
      name: "review",
      description: "",
      content: "# Steps",
      scope: "project",
    ),
  ];

  @override
  Future<List<MemoryEntry>> fetchMemory({String? projectId}) async =>
      memories;

  @override
  Future<List<SkillEntry>> fetchSkills({String? projectId}) async => skills;

  @override
  Future<void> deleteMemory(
    String name,
    String scope, {
    String? projectId,
  }) async {
    deleted.add("memory:$scope/$name");
    memories = memories.where((m) => m.name != name).toList();
  }

  @override
  Future<void> deleteSkill(
    String name,
    String scope, {
    String? projectId,
  }) async {
    deleted.add("skill:$scope/$name");
    skills = skills.where((s) => s.name != name).toList();
  }

  @override
  Future<void> saveMemory(MemoryEntry memory, {String? projectId}) async {}

  @override
  Future<void> saveSkill(SkillEntry skill, {String? projectId}) async {}
}

void main() {
  testWidgets(
    "lists both stores, expands a card's content, and deletes after confirmation",
    (tester) async {
      final client = _FakeClient();
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            apiClientProvider.overrideWithValue(client),
            currentProjectProvider.overrideWith(_NoProject.new),
            languageProvider.overrideWith(_EnglishLanguage.new),
          ],
          child: const MaterialApp(home: MemoryScreen()),
        ),
      );
      await tester.pumpAndSettle();

      // The skills tab opens first.
      expect(find.text("review"), findsOneWidget);
      expect(find.text("Skills (1)"), findsOneWidget);

      // Content stays hidden until the card is tapped.
      expect(find.text("# Steps"), findsNothing);
      await tester.tap(find.text("review"));
      await tester.pumpAndSettle();
      expect(find.text("# Steps"), findsOneWidget);

      // The memory tab shows the other store.
      await tester.tap(find.text("Memory (1)"));
      await tester.pumpAndSettle();
      expect(find.text("stack"), findsOneWidget);

      // Delete asks first, then goes through the client and refreshes.
      await tester.tap(find.byIcon(Icons.delete_outline).first);
      await tester.pumpAndSettle();
      expect(find.text('Delete "stack"?'), findsOneWidget);
      await tester.tap(find.text("Delete"));
      await tester.pumpAndSettle();

      expect(client.deleted, ["memory:global/stack"]);
      expect(find.text("stack"), findsNothing);
    },
  );
}
