import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import 'api_client_provider.dart';
import 'project_provider.dart';

// Deliberately NOT .autoDispose — the model/effort picker sheets are opened
// and closed repeatedly in a single chat session, and autoDispose meant a
// fresh network round trip (and a real, reported flash of a loading
// spinner) every single time either sheet reopened, instead of the cached
// list from moments ago. These live for the app's lifetime and are cheap
// enough (a couple of small JSON payloads) that never disposing them costs
// nothing worth avoiding autoDispose for. Both still watch
// currentProjectProvider, so switching projects (a project can have its own
// .finanfa-code/config.json) does refetch.
final modelListProvider = FutureProvider<List<ModelOption>>((ref) async {
  final client = ref.watch(apiClientProvider);
  if (client == null) return [];
  final projectId = ref.watch(currentProjectProvider);
  final result = await client.fetchModels(projectId: projectId);
  return result.models;
});

final effortTierListProvider = FutureProvider<List<EffortTierOption>>((
  ref,
) async {
  final client = ref.watch(apiClientProvider);
  if (client == null) return [];
  final projectId = ref.watch(currentProjectProvider);
  return client.fetchEffortTiers(projectId: projectId);
});
