import 'models/session_models.dart';

/// One titled block of the model picker: Claude, a cloud provider, the models
/// on this machine, or whatever else is configured. Mirrors
/// packages/web-client/src/modelGroups.ts.
class ModelGroup {
  /// Stable key; the built-in groups ("claude", "local", "configured") also
  /// name their translated title.
  final String key;

  /// Set for a cloud provider, whose name is not translated.
  final String? label;
  final List<ModelOption> items;
  const ModelGroup({required this.key, this.label, required this.items});
}

final _localUrl = RegExp(r'^https?://(localhost|127\.0\.0\.1|\[::1\])', caseSensitive: false);

/// Claude first, then each cloud provider in the order it appears, then the
/// models on this machine, then whatever else is configured. A [query]
/// filters on the model's name or provider; groups left empty are dropped.
List<ModelGroup> groupModels(List<ModelOption> models, [String query = '']) {
  final q = query.trim().toLowerCase();
  final visible = q.isEmpty
      ? models
      : models
            .where((m) => '${m.id} ${m.provider ?? ''}'.toLowerCase().contains(q))
            .toList();
  final claude = <ModelOption>[];
  final cloud = <String, List<ModelOption>>{};
  final local = <ModelOption>[];
  final configured = <ModelOption>[];
  for (final m in visible) {
    if (m.family == 'anthropic') {
      claude.add(m);
    } else if (m.provider != null) {
      cloud.putIfAbsent(m.provider!, () => []).add(m);
    } else if (m.localModelId != null || m.local || _localUrl.hasMatch(m.baseUrl ?? '')) {
      local.add(m);
    } else {
      configured.add(m);
    }
  }
  return [
    if (claude.isNotEmpty) ModelGroup(key: 'claude', items: claude),
    for (final entry in cloud.entries)
      ModelGroup(key: 'cloud:${entry.key}', label: entry.key, items: entry.value),
    if (local.isNotEmpty) ModelGroup(key: 'local', items: local),
    if (configured.isNotEmpty) ModelGroup(key: 'configured', items: configured),
  ];
}
