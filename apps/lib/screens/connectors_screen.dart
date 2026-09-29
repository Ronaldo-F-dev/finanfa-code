import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/timeline_item.dart';
import '../state/agent_session_provider.dart';
import '../state/language_provider.dart';
import '../theme.dart';

/// Mirrors packages/web-client/src/components/McpPanel.tsx — live over the
/// same WebSocket messages (mcp_connect/mcp_enable/mcp_disable/mcp_reload)
/// this session's AgentSessionController already wires up.
class ConnectorsScreen extends ConsumerStatefulWidget {
  const ConnectorsScreen({super.key});
  @override
  ConsumerState<ConnectorsScreen> createState() => _ConnectorsScreenState();
}

enum _Filter { all, connected, needsSetup }

class _ConnectorsScreenState extends ConsumerState<ConnectorsScreen> {
  _Filter _filter = _Filter.all;
  // Real, reported bug: tapping "Add" on a connector that fails to connect
  // (e.g. github's MCP server needs Docker running, which it wasn't) gave
  // no feedback at all — the server's real error (writeError) only ever
  // landed in the CHAT timeline, invisible while looking at this screen.
  // Tracked here so a tap shows a spinner immediately and any new
  // system/error message that arrives while this screen is open — not
  // just ones about MCP — gets surfaced as a snackbar too.
  final Set<String> _connecting = {};
  int _seenTimelineLength = 0;

  @override
  void initState() {
    super.initState();
    _seenTimelineLength = ref.read(agentSessionProvider).timeline.length;
  }

  void _connect(String name) {
    setState(() => _connecting.add(name));
    ref.read(agentSessionProvider).mcpConnect(name);
    // The server always answers with a fresh mcp_status (success or not)
    // right after attempting the connection — clearing the spinner once
    // enough time has passed for that round trip covers both outcomes,
    // since the real feedback (success or the real error) comes via the
    // snackbar listener below, not from watching mcpServers directly.
    Future.delayed(const Duration(seconds: 6), () {
      if (mounted) setState(() => _connecting.remove(name));
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final controller = ref.watch(agentSessionProvider);
    final servers = controller.mcpServers;

    ref.listen(agentSessionProvider, (previous, next) {
      if (next.timeline.length <= _seenTimelineLength) return;
      final newItems = next.timeline.sublist(_seenTimelineLength);
      _seenTimelineLength = next.timeline.length;
      for (final item in newItems) {
        if (item is! LogItem) continue;
        if (!mounted) continue;
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(item.text),
            backgroundColor: item.variant == LogVariant.error ? c.danger : null,
          ),
        );
      }
    });

    final connectedCount = servers.where((s) => s.connected).length;
    final needsSetupCount = servers.length - connectedCount;
    final visibleServers = switch (_filter) {
      _Filter.all => servers,
      _Filter.connected => servers.where((s) => s.connected).toList(),
      _Filter.needsSetup => servers.where((s) => !s.connected).toList(),
    };

    return Scaffold(
      appBar: AppBar(
        title: Text(t(ref, 'connectors.title')),
        actions: [
          IconButton(
            icon: const Icon(Icons.refresh),
            tooltip: t(ref, 'connectors.reload'),
            onPressed: controller.mcpReload,
          ),
        ],
      ),
      body: !controller.mcpLoaded
          ? const Center(child: CircularProgressIndicator())
          : servers.isEmpty
          ? Center(
              child: Text(
                t(ref, 'connectors.none'),
                style: TextStyle(color: c.textMuted),
              ),
            )
          : Column(
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    FinanfaSpace.md,
                    FinanfaSpace.md,
                    FinanfaSpace.md,
                    FinanfaSpace.sm,
                  ),
                  child: Row(
                    children: [
                      _FilterTab(
                        label: '${t(ref, 'connectors.filterAll')} · ${servers.length}',
                        selected: _filter == _Filter.all,
                        onTap: () => setState(() => _filter = _Filter.all),
                      ),
                      const SizedBox(width: 8),
                      _FilterTab(
                        label: '${t(ref, 'connectors.filterConnected')} · $connectedCount',
                        selected: _filter == _Filter.connected,
                        onTap: () => setState(() => _filter = _Filter.connected),
                      ),
                      const SizedBox(width: 8),
                      _FilterTab(
                        label: '${t(ref, 'connectors.filterNeedsSetup')} · $needsSetupCount',
                        selected: _filter == _Filter.needsSetup,
                        onTap: () => setState(() => _filter = _Filter.needsSetup),
                      ),
                    ],
                  ),
                ),
                Expanded(
                  child: ListView.builder(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FinanfaSpace.md,
                      vertical: FinanfaSpace.sm,
                    ),
                    itemCount: visibleServers.length,
                    itemBuilder: (context, i) {
                      final s = visibleServers[i];
                      final connecting = _connecting.contains(s.name);
                      final statusLabel = s.connected
                          ? (s.disabled ? t(ref, 'connectors.disabled') : t(ref, 'connectors.connected'))
                          : (s.needsAuth ? t(ref, 'connectors.needsAuth') : t(ref, 'connectors.notAdded'));
                      final statusColor = s.connected && !s.disabled
                          ? c.success
                          : (s.needsAuth ? const Color(0xFFCE9B2E) : c.textMuted);
                      return Card(
                        margin: const EdgeInsets.only(bottom: FinanfaSpace.md),
                        child: Padding(
                          padding: const EdgeInsets.all(FinanfaSpace.lg),
                          child: Row(
                            children: [
                              _ConnectorAvatar(name: s.name),
                              const SizedBox(width: FinanfaSpace.md),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    // The connector's own name is the most
                                    // important thing in this row — it used
                                    // to share the same mono/13px treatment
                                    // as the transport line under it, so
                                    // nothing visually dominated. itemTitle
                                    // is deliberately bigger/heavier/non-mono
                                    // (mono is for tool/code names, not this).
                                    Text(s.name, style: context.textStyles.itemTitle),
                                    const SizedBox(height: FinanfaSpace.xs),
                                    Text(s.transport, style: context.textStyles.caption),
                                    const SizedBox(height: FinanfaSpace.sm),
                                    _StatusPill(label: statusLabel, color: statusColor),
                                  ],
                                ),
                              ),
                              const SizedBox(width: FinanfaSpace.sm),
                              !s.connected
                                  ? FilledButton(
                                      onPressed: connecting ? null : () => _connect(s.name),
                                      child: connecting
                                          ? const SizedBox(
                                              width: 16,
                                              height: 16,
                                              child: CircularProgressIndicator(
                                                strokeWidth: 2,
                                                color: Colors.white,
                                              ),
                                            )
                                          : Text(t(ref, 'connectors.add')),
                                    )
                                  : OutlinedButton(
                                      onPressed: () => ref
                                          .read(agentSessionProvider)
                                          .mcpToggle(s.name, s.disabled),
                                      child: Text(
                                        s.disabled
                                            ? t(ref, 'connectors.enable')
                                            : t(ref, 'connectors.disable'),
                                      ),
                                    ),
                            ],
                          ),
                        ),
                      );
                    },
                  ),
                ),
              ],
            ),
    );
  }
}

class _FilterTab extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _FilterTab({required this.label, required this.selected, required this.onTap});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: selected ? c.text : Colors.transparent,
      borderRadius: BorderRadius.circular(FinanfaRadii.sm),
      child: InkWell(
        borderRadius: BorderRadius.circular(FinanfaRadii.sm),
        onTap: onTap,
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(FinanfaRadii.sm),
            border: selected ? null : Border.all(color: c.border),
          ),
          child: Text(
            label,
            style: TextStyle(
              color: selected ? c.bg : c.textMuted,
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

/// A colored two-letter avatar per connector — same idea as the design
/// export's connector cards (export/mockups/), deterministic per name so
/// the same server always gets the same color instead of a random one.
class _ConnectorAvatar extends StatelessWidget {
  final String name;
  const _ConnectorAvatar({required this.name});

  static const _palette = [
    Color(0xFF3652E0),
    Color(0xFF0F9D6E),
    Color(0xFFB7791F),
    Color(0xFF9B4FDE),
    Color(0xFFDE4F7A),
    Color(0xFF2E9BCE),
  ];

  @override
  Widget build(BuildContext context) {
    final initials = name.length >= 2 ? name.substring(0, 2) : name;
    final color = _palette[name.hashCode.abs() % _palette.length];
    return CircleAvatar(
      radius: 18,
      backgroundColor: color.withValues(alpha: 0.15),
      child: Text(
        initials,
        style: Theme.of(context).textTheme.labelMedium?.copyWith(color: color, fontSize: 12.5),
      ),
    );
  }
}

class _StatusPill extends StatelessWidget {
  final String label;
  final Color color;
  const _StatusPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.12),
        borderRadius: BorderRadius.circular(FinanfaRadii.sm),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(width: 6, height: 6, decoration: BoxDecoration(color: color, shape: BoxShape.circle)),
          const SizedBox(width: 5),
          Text(label, style: TextStyle(color: color, fontSize: 11, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}
