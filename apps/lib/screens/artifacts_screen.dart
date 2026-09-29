import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/timeline_item.dart';
import '../state/agent_session_provider.dart';
import '../state/language_provider.dart';
import '../theme.dart';

final _writeOrEditPattern = RegExp(r'^(write|edit) (.+?)(?: \(|$)');

/// A file this conversation's agent actually created or modified — derived
/// from the timeline's own ToolCallItem entries (write_file/edit_file),
/// not a separate server concept. There's no dedicated "artifacts" API on
/// finanfa-code's server (unlike, say, a generated-image tool result),
/// so this reads the same real tool-call descriptions already rendered in
/// the chat transcript instead of inventing a new endpoint.
class _Artifact {
  final String path;
  final String action;
  const _Artifact({required this.path, required this.action});
}

List<_Artifact> _extractArtifacts(List<TimelineItem> timeline) {
  final byPath = <String, _Artifact>{};
  for (final item in timeline) {
    if (item is! ToolCallItem) continue;
    if (item.toolName != 'write_file' && item.toolName != 'edit_file') {
      continue;
    }
    final match = _writeOrEditPattern.firstMatch(item.description);
    if (match == null) continue;
    final action = match.group(1)!;
    final path = match.group(2)!;
    // Last write/edit wins for the action label (created vs. modified since),
    // insertion order otherwise preserved so the list reads oldest-first.
    byPath[path] = _Artifact(path: path, action: action);
  }
  return byPath.values.toList();
}

class ArtifactsScreen extends ConsumerWidget {
  const ArtifactsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final controller = ref.watch(agentSessionProvider);
    final artifacts = _extractArtifacts(controller.timeline);

    return Scaffold(
      appBar: AppBar(title: Text(t(ref, 'artifacts.title'))),
      body: artifacts.isEmpty
          ? Center(
              child: Text(
                t(ref, 'artifacts.none'),
                style: TextStyle(color: c.textMuted),
              ),
            )
          : ListView.builder(
              itemCount: artifacts.length,
              itemBuilder: (context, i) {
                final a = artifacts[i];
                return ListTile(
                  leading: Icon(
                    a.action == 'write'
                        ? Icons.note_add_outlined
                        : Icons.edit_note,
                    color: c.textMuted,
                  ),
                  title: Text(
                    a.path.split('/').last,
                    overflow: TextOverflow.ellipsis,
                  ),
                  subtitle: Text(
                    a.path,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(color: c.textMuted, fontSize: 12),
                  ),
                  trailing: IconButton(
                    icon: const Icon(Icons.copy_outlined, size: 18),
                    tooltip: t(ref, 'artifacts.copyPath'),
                    onPressed: () =>
                        Clipboard.setData(ClipboardData(text: a.path)),
                  ),
                );
              },
            ),
    );
  }
}
