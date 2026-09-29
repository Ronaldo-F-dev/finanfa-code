import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/models/session_models.dart';
import 'api_client_provider.dart';

const _currentProjectKey = 'finanfa.currentProjectId';

/// null = the "default" workspace (the folder the server was started
/// against) — the only workspace that exists before Projects are used at
/// all, same convention as App.tsx's own activeProjectId.
class CurrentProjectNotifier extends Notifier<String?> {
  @override
  String? build() {
    _load();
    return null;
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    state = prefs.getString(_currentProjectKey);
  }

  Future<void> setProject(String? id) async {
    state = id;
    final prefs = await SharedPreferences.getInstance();
    if (id == null) {
      await prefs.remove(_currentProjectKey);
    } else {
      await prefs.setString(_currentProjectKey, id);
    }
  }
}

final currentProjectProvider =
    NotifierProvider<CurrentProjectNotifier, String?>(
      CurrentProjectNotifier.new,
    );

final projectListProvider = FutureProvider.autoDispose<List<ProjectItem>>((
  ref,
) async {
  final client = ref.watch(apiClientProvider);
  if (client == null) return [];
  final projects = await client.fetchProjects();
  // "default" is the folder the server was started against — a dev/ops
  // detail, not something the user ever created, same filter App.tsx's own
  // ProjectsListView applies.
  return projects.where((p) => p.id != 'default').toList();
});
