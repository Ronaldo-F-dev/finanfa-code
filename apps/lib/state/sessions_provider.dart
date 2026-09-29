import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import 'api_client_provider.dart';
import 'project_provider.dart';

/// The session list for the drawer (see App.tsx's Sidebar) — refetched via
/// `ref.invalidate(sessionListProvider)` after sending the first message of
/// a new chat or deleting a session, and automatically on a project switch
/// (it watches currentProjectProvider), same "no polling, just refresh on
/// the actions that could have changed it" shape Sidebar.tsx uses (its own
/// refreshToken prop).
final sessionListProvider = FutureProvider.autoDispose<List<SessionListItem>>((
  ref,
) async {
  final client = ref.watch(apiClientProvider);
  if (client == null) return [];
  final projectId = ref.watch(currentProjectProvider);
  return client.fetchSessions(projectId: projectId);
});
