import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/project_provider.dart';
import '../theme.dart';

/// Mirrors packages/web-client/src/components/ProjectsListView.tsx — every
/// project is a real separate workspace (its own directory/cwd on the
/// server), not just a label; switching one changes which files/sessions
/// the agent actually sees.
class ProjectsScreen extends ConsumerStatefulWidget {
  const ProjectsScreen({super.key});
  @override
  ConsumerState<ProjectsScreen> createState() => _ProjectsScreenState();
}

class _ProjectsScreenState extends ConsumerState<ProjectsScreen> {
  final _newNameController = TextEditingController();
  bool _creating = false;

  @override
  void dispose() {
    _newNameController.dispose();
    super.dispose();
  }

  Future<void> _create() async {
    // Real, reported bug: submitting via the Enter key isn't gated by the
    // FilledButton's disabled state, so hitting Enter while a create is
    // already in flight (or Enter immediately followed by a tap) fired this
    // twice and created two projects with the same name.
    if (_creating) return;
    final name = _newNameController.text.trim();
    if (name.isEmpty) return;
    final client = ref.read(apiClientProvider);
    if (client == null) return;
    setState(() => _creating = true);
    try {
      final project = await client.createProject(name);
      _newNameController.clear();
      ref.invalidate(projectListProvider);
      await ref.read(currentProjectProvider.notifier).setProject(project.id);
      if (mounted) Navigator.of(context).pop();
    } finally {
      if (mounted) setState(() => _creating = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final projectsAsync = ref.watch(projectListProvider);
    final currentProjectId = ref.watch(currentProjectProvider);

    return Scaffold(
      appBar: AppBar(title: Text(t(ref, 'projects.title'))),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.all(16),
            child: Row(
              children: [
                Expanded(
                  child: TextField(
                    controller: _newNameController,
                    decoration: InputDecoration(
                      hintText: t(ref, 'projects.newNameHint'),
                    ),
                    onSubmitted: (_) => _create(),
                  ),
                ),
                const SizedBox(width: 8),
                FilledButton(
                  onPressed: _creating ? null : _create,
                  child: _creating
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : Text(t(ref, 'projects.create')),
                ),
              ],
            ),
          ),
          Expanded(
            child: projectsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (err, _) =>
                  Center(child: Text(t(ref, 'projects.failedToLoad'))),
              data: (projects) {
                return ListView(
                  children: [
                    ListTile(
                      leading: Icon(Icons.home_outlined, color: c.accent),
                      title: Text(t(ref, 'projects.defaultWorkspace')),
                      selected: currentProjectId == null,
                      selectedTileColor: c.accent.withValues(alpha: 0.12),
                      onTap: () async {
                        await ref
                            .read(currentProjectProvider.notifier)
                            .setProject(null);
                        if (context.mounted) Navigator.of(context).pop();
                      },
                    ),
                    const Divider(height: 1),
                    for (final p in projects)
                      ListTile(
                        leading: Icon(
                          Icons.folder_outlined,
                          color: c.textMuted,
                        ),
                        title: Text(p.name),
                        subtitle: Text(
                          t(
                            ref,
                            'projects.fileCount',
                          ).replaceFirst('{count}', '${p.fileCount}'),
                        ),
                        selected: p.id == currentProjectId,
                        selectedTileColor: c.accent.withValues(alpha: 0.12),
                        onTap: () async {
                          await ref
                              .read(currentProjectProvider.notifier)
                              .setProject(p.id);
                          if (context.mounted) Navigator.of(context).pop();
                        },
                        trailing: IconButton(
                          icon: Icon(Icons.delete_outline, color: c.danger),
                          onPressed: () async {
                            await ref
                                .read(apiClientProvider)
                                ?.deleteProject(p.id);
                            if (currentProjectId == p.id) {
                              await ref
                                  .read(currentProjectProvider.notifier)
                                  .setProject(null);
                            }
                            ref.invalidate(projectListProvider);
                          },
                        ),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}
