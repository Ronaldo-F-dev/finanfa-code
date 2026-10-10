import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/project_provider.dart';
import '../theme.dart';
import '../widgets/content_width.dart';

/// Mirrors packages/web-client/src/components/MemoryPanel.tsx: the same
/// /api/memory and /api/skills stores the agent reads through its own
/// memory/skill tools, editable here. Entries carry their own scope, so a
/// global note and a project note with the same name can coexist.
class MemoryScreen extends ConsumerStatefulWidget {
  const MemoryScreen({super.key});

  @override
  ConsumerState<MemoryScreen> createState() => _MemoryScreenState();
}

class _MemoryScreenState extends ConsumerState<MemoryScreen>
    with SingleTickerProviderStateMixin {
  late final TabController _tabs = TabController(length: 2, vsync: this);
  List<MemoryEntry> _memories = const [];
  List<SkillEntry> _skills = const [];
  bool _loading = true;
  String? _error;
  // "scope/name" of the card whose content is expanded — one at a time,
  // since two stores can hold an entry with the same name.
  String? _expandedKey;

  @override
  void initState() {
    super.initState();
    _tabs.addListener(_onTabChanged);
    _refresh();
  }

  @override
  void dispose() {
    _tabs.removeListener(_onTabChanged);
    _tabs.dispose();
    super.dispose();
  }

  void _onTabChanged() => setState(() {});

  String? get _projectId => ref.read(currentProjectProvider);

  Future<void> _refresh() async {
    final client = ref.read(apiClientProvider);
    if (client == null) {
      setState(() => _loading = false);
      return;
    }
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final projectId = _projectId;
      final results = await Future.wait([
        client.fetchMemory(projectId: projectId),
        client.fetchSkills(projectId: projectId),
      ]);
      if (!mounted) return;
      setState(() {
        _memories = results[0] as List<MemoryEntry>;
        _skills = results[1] as List<SkillEntry>;
        _loading = false;
      });
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _loading = false;
        _error = err.toString();
      });
    }
  }

  void _snack(String text) {
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(text)));
  }

  Future<void> _delete({
    required String name,
    required String scope,
    required bool isSkill,
  }) async {
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(
          t(ref, 'memory.deleteConfirm').replaceFirst('{name}', name),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(ctx).pop(false),
            child: Text(t(ref, 'memory.cancel')),
          ),
          FilledButton(
            style: FilledButton.styleFrom(
              backgroundColor: context.colors.danger,
            ),
            onPressed: () => Navigator.of(ctx).pop(true),
            child: Text(t(ref, 'memory.delete')),
          ),
        ],
      ),
    );
    if (confirmed != true) return;
    final client = ref.read(apiClientProvider);
    if (client == null) return;
    try {
      if (isSkill) {
        await client.deleteSkill(name, scope, projectId: _projectId);
      } else {
        await client.deleteMemory(name, scope, projectId: _projectId);
      }
      await _refresh();
    } catch (_) {
      if (mounted) _snack(t(ref, 'memory.failed'));
    }
  }

  Future<void> _openForm({MemoryEntry? memory, SkillEntry? skill}) async {
    final isSkill = skill != null || _tabs.index == 1;
    final saved = await showModalBottomSheet<Object>(
      context: context,
      isScrollControlled: true,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _EntryForm(
        isSkill: isSkill,
        name: memory?.name ?? skill?.name,
        description: memory?.description ?? skill?.description,
        content: memory?.content ?? skill?.content,
        type: memory?.type,
        scope: memory?.scope ?? skill?.scope ?? 'global',
      ),
    );
    if (saved == null) return;
    final client = ref.read(apiClientProvider);
    if (client == null) return;
    try {
      if (saved is SkillEntry) {
        await client.saveSkill(saved, projectId: _projectId);
      } else if (saved is MemoryEntry) {
        await client.saveMemory(saved, projectId: _projectId);
      }
      await _refresh();
      if (mounted) _snack(t(ref, 'memory.saved'));
    } catch (_) {
      if (mounted) _snack(t(ref, 'memory.failed'));
    }
  }

  Widget _entryCard({
    required String name,
    required String description,
    required String scope,
    required String content,
    required bool isSkill,
    required MemoryEntry? memory,
    required SkillEntry? skill,
  }) {
    final c = context.colors;
    final expanded = _expandedKey == '$scope/$name';
    return Card(
      margin: const EdgeInsets.only(bottom: FinanfaSpace.sm),
      child: InkWell(
        borderRadius: BorderRadius.circular(FinanfaRadii.lg),
        onTap: () => setState(
          () => _expandedKey = expanded ? null : '$scope/$name',
        ),
        child: Padding(
          padding: const EdgeInsets.all(FinanfaSpace.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      name,
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                  ),
                  _ScopePill(scope: scope),
                  IconButton(
                    icon: const Icon(Icons.edit_outlined, size: 18),
                    tooltip: t(ref, 'memory.edit'),
                    onPressed: () =>
                        _openForm(memory: memory, skill: skill),
                  ),
                  IconButton(
                    icon: const Icon(Icons.delete_outline, size: 18),
                    tooltip: t(ref, 'memory.delete'),
                    onPressed: () => _delete(
                      name: name,
                      scope: scope,
                      isSkill: isSkill,
                    ),
                  ),
                ],
              ),
              if (description.isNotEmpty)
                Text(description, style: context.textStyles.caption),
              if (expanded) ...[
                const SizedBox(height: FinanfaSpace.sm),
                Container(
                  width: double.infinity,
                  padding: const EdgeInsets.all(FinanfaSpace.sm),
                  decoration: BoxDecoration(
                    color: c.bgCard,
                    borderRadius: BorderRadius.circular(FinanfaRadii.md),
                    border: Border.all(color: c.border),
                  ),
                  child: SelectableText(
                    content,
                    style: context.textStyles.caption.copyWith(
                      color: c.text,
                    ),
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  Widget _list({required bool isSkill}) {
    final entries = isSkill ? _skills : _memories;
    if (entries.isEmpty) {
      return Center(
        child: Text(
          t(ref, isSkill ? 'memory.noSkills' : 'memory.nothingSaved'),
          style: TextStyle(color: context.colors.textMuted),
        ),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.builder(
        padding: const EdgeInsets.symmetric(
          horizontal: FinanfaSpace.md,
          vertical: FinanfaSpace.sm,
        ),
        itemCount: entries.length,
        itemBuilder: (context, i) {
          if (isSkill) {
            final skill = _skills[i];
            return _entryCard(
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              content: skill.content,
              isSkill: true,
              memory: null,
              skill: skill,
            );
          }
          final memory = _memories[i];
          return _entryCard(
            name: memory.name,
            description: memory.description,
            scope: memory.scope,
            content: memory.content,
            isSkill: false,
            memory: memory,
            skill: null,
          );
        },
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final skillsCount = t(
      ref,
      'memory.skillsCount',
    ).replaceFirst('{count}', '${_skills.length}');
    final memoryCount = t(
      ref,
      'memory.memoryCount',
    ).replaceFirst('{count}', '${_memories.length}');
    return Scaffold(
      appBar: AppBar(
        title: Text(t(ref, 'memory.title')),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: t(ref, 'memory.title'),
            onPressed: _refresh,
          ),
        ],
        bottom: TabBar(
          controller: _tabs,
          tabs: [Tab(text: skillsCount), Tab(text: memoryCount)],
        ),
      ),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => _openForm(),
        icon: const Icon(Icons.add),
        label: Text(t(ref, 'memory.new')),
      ),
      body: ContentWidth(
        child: _loading
            ? const Center(child: CircularProgressIndicator())
            : _error != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Text(
                    t(ref, 'memory.failed'),
                    style: TextStyle(color: c.danger),
                  ),
                ),
              )
            : Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      FinanfaSpace.md,
                      FinanfaSpace.md,
                      FinanfaSpace.md,
                      0,
                    ),
                    child: Text(
                      t(ref, 'memory.hint'),
                      style: context.textStyles.caption,
                    ),
                  ),
                  Expanded(
                    child: TabBarView(
                      controller: _tabs,
                      children: [
                        _list(isSkill: true),
                        _list(isSkill: false),
                      ],
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _ScopePill extends StatelessWidget {
  final String scope;
  const _ScopePill({required this.scope});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final global = scope == 'global';
    final color = global ? c.accent : c.success;
    return Container(
      margin: const EdgeInsets.only(right: 4),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(FinanfaRadii.sm),
      ),
      child: Text(
        global ? 'global' : 'project',
        style: TextStyle(
          color: color,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }
}

/// The add/edit sheet — returns the built entry on save (the caller talks to
/// the API), or null when dismissed.
class _EntryForm extends ConsumerStatefulWidget {
  final bool isSkill;
  final String? name;
  final String? description;
  final String? content;
  final String? type;
  final String scope;
  const _EntryForm({
    required this.isSkill,
    this.name,
    this.description,
    this.content,
    this.type,
    required this.scope,
  });

  @override
  ConsumerState<_EntryForm> createState() => _EntryFormState();
}

class _EntryFormState extends ConsumerState<_EntryForm> {
  late final _name = TextEditingController(text: widget.name ?? '');
  late final _description = TextEditingController(
    text: widget.description ?? '',
  );
  late final _content = TextEditingController(text: widget.content ?? '');
  late String _type = widget.type ?? 'user';
  late String _scope = widget.scope;

  static const _memoryTypes = ['user', 'feedback', 'project', 'reference'];

  @override
  void dispose() {
    _name.dispose();
    _description.dispose();
    _content.dispose();
    super.dispose();
  }

  void _save() {
    final name = _name.text.trim();
    final content = _content.text.trim();
    if (name.isEmpty || content.isEmpty) return;
    final description = _description.text.trim();
    Navigator.of(context).pop(
      widget.isSkill
          ? SkillEntry(
              name: name,
              description: description,
              content: content,
              scope: _scope,
            )
          : MemoryEntry(
              name: name,
              description: description,
              type: _type,
              content: content,
              scope: _scope,
            ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: EdgeInsets.only(
        left: 20,
        right: 20,
        top: 16,
        bottom: MediaQuery.viewInsetsOf(context).bottom + 16,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              t(
                ref,
                widget.isSkill ? 'memory.saveSkill' : 'memory.saveMemory',
              ),
              style: TextStyle(
                fontSize: 16,
                fontWeight: FontWeight.w700,
                color: c.text,
              ),
            ),
            const SizedBox(height: FinanfaSpace.md),
            TextField(
              controller: _name,
              enabled: widget.name == null,
              decoration: InputDecoration(
                labelText: t(ref, 'memory.nameSlug'),
                isDense: true,
              ),
            ),
            const SizedBox(height: FinanfaSpace.sm),
            TextField(
              controller: _description,
              decoration: InputDecoration(
                labelText: t(ref, 'memory.description'),
                isDense: true,
              ),
            ),
            if (!widget.isSkill) ...[
              const SizedBox(height: FinanfaSpace.sm),
              DropdownButtonFormField<String>(
                initialValue: _type,
                decoration: InputDecoration(
                  labelText: t(ref, 'memory.type'),
                  isDense: true,
                ),
                items: [
                  for (final type in _memoryTypes)
                    DropdownMenuItem(value: type, child: Text(type)),
                ],
                onChanged: (value) => setState(() => _type = value ?? 'user'),
              ),
            ],
            const SizedBox(height: FinanfaSpace.sm),
            SegmentedButton<String>(
              segments: [
                ButtonSegment(
                  value: 'project',
                  label: Text(t(ref, 'memory.scopeProject')),
                ),
                ButtonSegment(
                  value: 'global',
                  label: Text(t(ref, 'memory.scopeGlobal')),
                ),
              ],
              selected: {_scope},
              onSelectionChanged: (selection) =>
                  setState(() => _scope = selection.first),
            ),
            const SizedBox(height: FinanfaSpace.sm),
            TextField(
              controller: _content,
              minLines: 4,
              maxLines: 10,
              decoration: InputDecoration(
                labelText: t(
                  ref,
                  widget.isSkill
                      ? 'memory.contentMarkdown'
                      : 'memory.content',
                ),
                alignLabelWithHint: true,
              ),
            ),
            const SizedBox(height: FinanfaSpace.md),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => Navigator.of(context).pop(),
                    child: Text(t(ref, 'memory.cancel')),
                  ),
                ),
                const SizedBox(width: FinanfaSpace.sm),
                Expanded(
                  child: FilledButton(
                    onPressed: _save,
                    child: Text(
                      t(
                        ref,
                        widget.isSkill
                            ? 'memory.saveSkill'
                            : 'memory.saveMemory',
                      ),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
