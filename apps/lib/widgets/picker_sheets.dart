import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import '../i18n/strings.dart';
import '../state/agent_session_provider.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/models_provider.dart';
import '../theme.dart';

/// Real, reported request: "les efforts doivent concerner le model choisi" —
/// picking a model directly shouldn't be a second, disconnected path from
/// the Effort tiers, which is what actually sets the safe tool budget for a
/// local model (see effort-tiers.ts's own toolBudget per tier). When the
/// model being picked IS one of the known tiers' models, route through
/// set_effort instead of a raw set_model, so the Effort chip stays in sync
/// AND that tier's tool budget actually applies — a raw set_model only
/// applies a tool budget for a local baseUrl via a live Ollama capability
/// lookup, which doesn't recognize every custom/community model tag.
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

EffortTierOption? _matchingTier(
  List<EffortTierOption> tiers,
  ModelOption model,
) {
  final resolvedId = model.localModelId ?? model.id;
  for (final tier in tiers) {
    if (tier.model == resolvedId) return tier;
  }
  return null;
}

/// Mirrors packages/web-client/src/components/ModelPicker.tsx — lists every
/// configured model/family, switching the live session via the same
/// set_model WebSocket message on tap.
Future<void> showModelPickerSheet(
  BuildContext context,
  WidgetRef ref,
  String? currentModel,
) {
  return showModalBottomSheet(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => Consumer(
      builder: (ctx, sheetRef, _) {
        final modelsAsync = sheetRef.watch(modelListProvider);
        // Watched (not read) here purely to kick off/keep alive the same
        // fetch onTap below awaits via .future — no value is used directly
        // in this build, only in the tap handler.
        sheetRef.watch(effortTierListProvider);
        final c = ctx.colors;
        return SafeArea(
          child: ConstrainedBox(
            // A fixed minimum height keeps the sheet from visibly resizing
            // (a real, reported jarring flash) the instant its data arrives
            // and swaps the loading spinner for a real list.
            constraints: const BoxConstraints(minHeight: 240),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 20,
                      vertical: 8,
                    ),
                    child: Text(
                      t(sheetRef, 'picker.modelTitle'),
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                        color: c.text,
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
                          t(sheetRef, 'picker.failedModels'),
                          style: TextStyle(color: c.textMuted),
                        ),
                      ),
                      data: (rawModels) => ListView(
                        shrinkWrap: true,
                        children: [
                          for (final m in _dedupeModels(rawModels))
                            ListTile(
                              title: Text(m.label),
                              subtitle: Row(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  Text(
                                    m.family,
                                    style: TextStyle(
                                      color: c.textMuted,
                                      fontSize: 12,
                                    ),
                                  ),
                                  // Only local models carry a running state at
                                  // all — a hosted/cloud model has no "will
                                  // start" concept, so no pill for those.
                                  if (m.local) ...[
                                    const SizedBox(width: 8),
                                    _ModelStatusPill(running: m.running),
                                  ],
                                ],
                              ),
                              trailing: (m.localModelId ?? m.id) == currentModel
                                  ? Icon(Icons.check, color: c.accent)
                                  : null,
                              onTap: () async {
                                // Real, reported race: the model list and the
                                // effort-tier list are two independent network
                                // calls — reading tiersAsync.valueOrNull here
                                // silently fell back to the raw (unsafe)
                                // switchModel path whenever the effort-tiers
                                // fetch just hadn't resolved yet, even though
                                // the model list (a separate request) already
                                // had. Awaiting the provider's own .future
                                // resolves to the same cached value once
                                // loaded, or waits for the in-flight request
                                // instead of racing it.
                                final tiers = await sheetRef.read(
                                  effortTierListProvider.future,
                                );
                                final tier = _matchingTier(tiers, m);
                                if (tier != null) {
                                  ref
                                      .read(agentSessionProvider)
                                      .setEffort(tier.id);
                                } else {
                                  // For a local runtime (Ollama/LM Studio/...), `id` is only
                                  // a display label ("Ollama: medgemma:4b") — the real model
                                  // string the provider expects is `localModelId`. Sending
                                  // `id` instead is a real 400 from the provider ("invalid
                                  // model name"), confirmed against a real Ollama server.
                                  ref
                                      .read(agentSessionProvider)
                                      .switchModel(
                                        m.localModelId ?? m.id,
                                        m.family,
                                        baseUrl: m.baseUrl,
                                      );
                                }
                                if (ctx.mounted) Navigator.of(ctx).pop();
                              },
                            ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    ),
  );
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

/// Mirrors packages/web-client/src/components/EffortSelector.tsx.
Future<void> showEffortPickerSheet(
  BuildContext context,
  WidgetRef ref,
  String? currentEffort,
) {
  return showModalBottomSheet(
    context: context,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => Consumer(
      builder: (ctx, sheetRef, _) {
        final tiersAsync = sheetRef.watch(effortTierListProvider);
        final c = ctx.colors;
        return SafeArea(
          child: ConstrainedBox(
            constraints: const BoxConstraints(minHeight: 240),
            child: Padding(
              padding: const EdgeInsets.symmetric(vertical: 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 20,
                      vertical: 8,
                    ),
                    child: Text(
                      t(sheetRef, 'picker.effortTitle'),
                      style: TextStyle(
                        fontWeight: FontWeight.w700,
                        fontSize: 16,
                        color: c.text,
                      ),
                    ),
                  ),
                  Flexible(
                    child: tiersAsync.when(
                      loading: () => const Padding(
                        padding: EdgeInsets.all(24),
                        child: Center(child: CircularProgressIndicator()),
                      ),
                      error: (err, _) => Padding(
                        padding: const EdgeInsets.all(24),
                        child: Text(
                          t(sheetRef, 'picker.failedEfforts'),
                          style: TextStyle(color: c.textMuted),
                        ),
                      ),
                      data: (tiers) => _EffortList(
                        tiers: tiers,
                        currentEffort: currentEffort,
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        );
      },
    ),
  );
}

/// The tier list itself, in its own stateful widget so a download in
/// progress (percent, error) survives the surrounding sheet's rebuilds —
/// mirrors the web client's EffortSelector, which keeps the same
/// pulling/pullPercent/pullError state while an uninstalled tier's model
/// downloads through GET /api/ollama-models/pull.
class _EffortList extends ConsumerStatefulWidget {
  final List<EffortTierOption> tiers;
  final String? currentEffort;
  const _EffortList({required this.tiers, required this.currentEffort});

  @override
  ConsumerState<_EffortList> createState() => _EffortListState();
}

class _EffortListState extends ConsumerState<_EffortList> {
  String? _pulling;
  int? _percent;
  String? _error;

  String _t(String key) => tr(ref.read(languageProvider), key);

  Future<void> _pull(String model, String level) async {
    setState(() {
      _pulling = model;
      _percent = 0;
      _error = null;
    });
    final client = ref.read(apiClientProvider);
    if (client == null) {
      setState(() {
        _error = _t('effort.downloadFailed');
        _pulling = null;
      });
      return;
    }
    try {
      await for (final event in client.pullModel(model)) {
        if (!mounted) return;
        if (event is OllamaPullProgress) {
          setState(() => _percent = event.percent);
        } else if (event is OllamaPullDone) {
          ref.invalidate(effortTierListProvider);
          ref.read(agentSessionProvider).clearEffortNeedsDownload();
          ref.read(agentSessionProvider).setEffort(level);
          Navigator.of(context).pop();
          return;
        } else if (event is OllamaPullError) {
          setState(() {
            _error = event.message;
            _pulling = null;
          });
          return;
        }
      }
    } catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.toString();
        _pulling = null;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return StreamBuilder<EffortNeedsDownload?>(
      stream: ref.read(agentSessionProvider).effortNeedsDownload,
      builder: (context, snapshot) {
        final needs = snapshot.data;
        return ListView(
          shrinkWrap: true,
          children: [
            if (_error != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 4,
                ),
                child: Text(
                  '${_t('effort.downloadFailed')} — $_error',
                  style: TextStyle(color: c.danger, fontSize: 12),
                ),
              ),
            for (final tier in widget.tiers)
              ListTile(
                title: Text(tier.label),
                subtitle: Text(
                  tier.model,
                  style: TextStyle(color: c.textMuted, fontSize: 12),
                ),
                trailing: _pulling == tier.model
                    ? Text(
                        '${_t('effort.downloading')} '
                        '${_percent != null ? '$_percent%' : ''}',
                        style: TextStyle(color: c.textMuted, fontSize: 12),
                      )
                    : !tier.installed
                    ? Icon(Icons.download_outlined, color: c.textMuted)
                    : (tier.id == widget.currentEffort
                          ? Icon(Icons.check, color: c.accent)
                          : null),
                onTap: () {
                  if (!tier.installed) {
                    // Keep the sheet open: the server answers set_effort with
                    // effort_needs_download, rendered as the prompt below.
                    // Popping here is what made the tap look like a silent
                    // no-op — the event had no UI left to reach.
                    ref.read(agentSessionProvider).setEffort(tier.id);
                    return;
                  }
                  ref.read(agentSessionProvider).setEffort(tier.id);
                  Navigator.of(context).pop();
                },
              ),
            if (needs != null && _pulling == null)
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 4, 20, 8),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${_t('effort.needsModel')} ${needs.ollamaModel}',
                        style: TextStyle(color: c.text, fontSize: 13),
                      ),
                    ),
                    TextButton(
                      onPressed: () => _pull(needs.ollamaModel, needs.level),
                      child: Text(_t('effort.download')),
                    ),
                  ],
                ),
              ),
          ],
        );
      },
    );
  }
}
