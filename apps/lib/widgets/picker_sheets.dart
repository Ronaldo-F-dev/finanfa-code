import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/model_groups.dart';
import '../core/models/session_models.dart';
import '../state/agent_session_provider.dart';
import '../state/language_provider.dart';
import '../state/models_provider.dart';
import '../theme.dart';

/// Defense in depth against a real, reported server bug (fixed at the
/// source in packages/web-server/src/index.ts's /api/models: its own
/// dedup only checked `id`, not `localModelId`, so a model that was both
/// live-probed AND still listed in config.localServices came back twice) —
/// two ModelOption entries whose "is this the active one" identity
/// (`localModelId ?? id`) resolve to the same string both showed a
/// checkmark at once. Keeping this dedup here too means a stale/duplicate
/// server response can never show two checked rows in the picker again,
/// regardless of what causes it.
List<ModelOption> _dedupeModels(List<ModelOption> models) {
  final seen = <String>{};
  final result = <ModelOption>[];
  for (final m in models) {
    final key = m.localModelId ?? m.id;
    if (seen.add(key)) result.add(m);
  }
  return result;
}

String _groupTitle(WidgetRef ref, ModelGroup group) {
  if (group.label != null) return group.label!;
  return switch (group.key) {
    'claude' => t(ref, 'picker.groupClaude'),
    'local' => t(ref, 'picker.groupLocal'),
    _ => t(ref, 'picker.groupConfigured'),
  };
}

/// Mirrors packages/web-client/src/components/ModelPicker.tsx: a searchable
/// list grouped by provider (Claude, DeepSeek, Grok, Gemini, the models on
/// this machine, then the rest), with a chip on a model whose provider still
/// needs an API key. [onNeedsKey] takes the user to Settings to add one.
Future<void> showModelPickerSheet(
  BuildContext context,
  WidgetRef ref,
  String? currentModel, {
  VoidCallback? onNeedsKey,
}) {
  return showModalBottomSheet(
    context: context,
    isScrollControlled: true,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => _ModelPickerSheet(
      currentModel: currentModel,
      onNeedsKey: onNeedsKey,
    ),
  );
}

class _ModelPickerSheet extends ConsumerStatefulWidget {
  final String? currentModel;
  final VoidCallback? onNeedsKey;
  const _ModelPickerSheet({required this.currentModel, this.onNeedsKey});

  @override
  ConsumerState<_ModelPickerSheet> createState() => _ModelPickerSheetState();
}

class _ModelPickerSheetState extends ConsumerState<_ModelPickerSheet> {
  String _query = '';

  void _pick(ModelOption m) {
    Navigator.of(context).pop();
    if (!m.configured) {
      // No point sending a switch the server would refuse: go where the key is added.
      widget.onNeedsKey?.call();
      return;
    }
    // For a local runtime (Ollama/LM Studio/...), `id` is only a display label
    // ("Ollama: medgemma:4b"): the real model string the provider expects is
    // `localModelId`. Sending `id` instead is a real 400 from the provider.
    ref
        .read(agentSessionProvider)
        .switchModel(m.localModelId ?? m.id, m.family, baseUrl: m.baseUrl);
  }

  @override
  Widget build(BuildContext context) {
    final modelsAsync = ref.watch(modelListProvider);
    final c = context.colors;
    return SafeArea(
      child: Padding(
        // Keeps the list above the keyboard while searching.
        padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
        child: ConstrainedBox(
          constraints: BoxConstraints(
            minHeight: 240,
            maxHeight: MediaQuery.of(context).size.height * 0.8,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
                child: Text(
                  t(ref, 'picker.modelTitle'),
                  style: TextStyle(
                    fontWeight: FontWeight.w700,
                    fontSize: 16,
                    color: c.text,
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 0, 16, 8),
                child: TextField(
                  onChanged: (value) => setState(() => _query = value),
                  decoration: InputDecoration(
                    hintText: t(ref, 'picker.search'),
                    prefixIcon: const Icon(Icons.search, size: 20),
                    isDense: true,
                  ),
                ),
              ),
              Flexible(
                child: modelsAsync.when(
                  loading: () => const Padding(
                    padding: EdgeInsets.all(24),
                    child: Center(child: CircularProgressIndicator()),
                  ),
                  error: (err, _) => Padding(
                    padding: const EdgeInsets.all(24),
                    child: Text(
                      t(ref, 'picker.failedModels'),
                      style: TextStyle(color: c.textMuted),
                    ),
                  ),
                  data: (rawModels) {
                    final groups = groupModels(_dedupeModels(rawModels), _query);
                    if (groups.isEmpty) {
                      return Padding(
                        padding: const EdgeInsets.all(24),
                        child: Center(
                          child: Text(
                            t(ref, 'picker.noMatch'),
                            style: TextStyle(color: c.textMuted),
                          ),
                        ),
                      );
                    }
                    return ListView(
                      shrinkWrap: true,
                      children: [
                        for (final group in groups) ...[
                          Padding(
                            padding: const EdgeInsets.fromLTRB(20, 12, 20, 4),
                            child: Text(
                              _groupTitle(ref, group).toUpperCase(),
                              style: TextStyle(
                                color: c.textMuted,
                                fontSize: 11,
                                fontWeight: FontWeight.w600,
                                letterSpacing: 0.6,
                              ),
                            ),
                          ),
                          for (final m in group.items) _modelTile(m, c),
                        ],
                      ],
                    );
                  },
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _modelTile(ModelOption m, FinanfaColors c) {
    final active = (m.localModelId ?? m.id) == widget.currentModel;
    return ListTile(
      dense: true,
      title: Text(m.label),
      trailing: !m.configured
          ? _Chip(label: t(ref, 'picker.keyNeeded'), color: c.warning)
          : m.local
          // Only models with a launch command carry a running state: a hosted
          // model has no "will start" concept, so no pill for those.
          ? _ModelStatusPill(running: m.running)
          : (active ? Icon(Icons.check, color: c.accent) : null),
      onTap: () => _pick(m),
    );
  }
}

/// A small outlined label, such as "Key needed".
class _Chip extends StatelessWidget {
  final String label;
  final Color color;
  const _Chip({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        border: Border.all(color: color.withValues(alpha: 0.5)),
        borderRadius: BorderRadius.circular(20),
      ),
      child: Text(
        label,
        style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }
}

/// Same dot+label pill language as connectors_screen.dart's own
/// `_StatusPill` (kept private there too) — a running local model reads as
/// "success" green, one that still needs to auto-start on selection reads
/// as muted/neutral so it doesn't look already-active.
class _ModelStatusPill extends StatelessWidget {
  final bool running;
  const _ModelStatusPill({required this.running});

  @override
  Widget build(BuildContext context) {
    return Consumer(
      builder: (ctx, ref, _) {
        final c = ctx.colors;
        final color = running ? c.success : c.textMuted;
        final label = running
            ? t(ref, 'picker.modelRunning')
            : t(ref, 'picker.modelWillStart');
        return Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: color.withValues(alpha: 0.12),
            borderRadius: BorderRadius.circular(FinanfaRadii.sm),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(color: color, shape: BoxShape.circle),
              ),
              const SizedBox(width: 5),
              Text(
                label,
                style: TextStyle(
                  color: color,
                  fontSize: 11,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}

/// Mirrors packages/web-client/src/components/EffortSelector.tsx: Low, Medium
/// or High is how much the CURRENT model thinks before it answers, applied
/// from the next message on. It never switches the model or the tools.
Future<void> showEffortPickerSheet(
  BuildContext context,
  WidgetRef ref,
  String currentLevel,
) {
  const levels = ['low', 'medium', 'high'];
  return showModalBottomSheet(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => Consumer(
      builder: (ctx, sheetRef, _) {
        final c = ctx.colors;
        return SafeArea(
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 8),
                  child: Text(
                    t(sheetRef, 'picker.effortTitle'),
                    style: TextStyle(
                      fontWeight: FontWeight.w700,
                      fontSize: 16,
                      color: c.text,
                    ),
                  ),
                ),
                for (final level in levels)
                  ListTile(
                    title: Text(t(sheetRef, 'effort.$level')),
                    subtitle: Text(
                      t(sheetRef, 'effort.${level}Desc'),
                      style: TextStyle(color: c.textMuted, fontSize: 12),
                    ),
                    trailing: level == currentLevel
                        ? Icon(Icons.check, color: c.accent)
                        : null,
                    onTap: () {
                      ref.read(agentSessionProvider).setEffortLevel(level);
                      Navigator.of(ctx).pop();
                    },
                  ),
              ],
            ),
          ),
        );
      },
    ),
  );
}
