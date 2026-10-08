import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import '../state/agent_session_provider.dart';
import '../state/language_provider.dart';
import '../theme.dart';
import '../widgets/content_width.dart';

/// The tools every turn can call, by risk level — mirrors
/// packages/web-client/src/components/ToolsPanel.tsx over the same
/// WebSocket messages (tools_status / set_tool_enabled) this session's
/// AgentSessionController already wires up. Disabling tools shrinks what is
/// sent to the model on every turn, which matters most for a small-context
/// local model that would otherwise overflow before a single message.
///
/// Pure and public so it is directly testable: no provider, no widget.
List<ToolStatus> filterTools(
  List<ToolStatus> tools, {
  required String query,
  String? risk,
}) {
  final q = query.trim().toLowerCase();
  return tools
      .where((tool) => risk == null || tool.riskLevel == risk)
      .where((tool) => q.isEmpty || tool.name.toLowerCase().contains(q))
      .toList();
}

String _riskKey(String risk) => switch (risk) {
  "dangerous" => 'tools.riskDangerous',
  "ask" => 'tools.riskAsk',
  _ => 'tools.riskSafe',
};

Color _riskColor(BuildContext context, String risk) => switch (risk) {
  "dangerous" => context.colors.danger,
  "ask" => context.colors.warning,
  _ => context.colors.success,
};

class ToolsScreen extends ConsumerStatefulWidget {
  const ToolsScreen({super.key});

  @override
  ConsumerState<ToolsScreen> createState() => _ToolsScreenState();
}

class _ToolsScreenState extends ConsumerState<ToolsScreen> {
  final _searchController = TextEditingController();
  String _query = "";
  String? _risk; // null = every risk level

  @override
  void initState() {
    super.initState();
    // tools_status is pushed on every connection, but this screen can be
    // opened late in a long session — asking again is the only way to be
    // sure it reflects the server right now.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(agentSessionProvider).requestToolsStatus();
    });
  }

  @override
  void dispose() {
    _searchController.dispose();
    super.dispose();
  }

  void _setAll(List<ToolStatus> tools, bool enabled) {
    final controller = ref.read(agentSessionProvider);
    for (final tool in tools) {
      if (tool.enabled != enabled) controller.setToolEnabled(tool.name, enabled);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final controller = ref.watch(agentSessionProvider);
    final tools = controller.toolsStatus;
    final visible = filterTools(tools, query: _query, risk: _risk);
    final enabledCount = tools.where((tool) => tool.enabled).length;

    return Scaffold(
      appBar: AppBar(
        title: Text(t(ref, 'tools.title')),
        actions: [
          IconButton(
            icon: const Icon(Icons.done_all),
            tooltip: t(ref, 'tools.enableAll'),
            onPressed: tools.isEmpty ? null : () => _setAll(tools, true),
          ),
          IconButton(
            icon: const Icon(Icons.remove_done),
            tooltip: t(ref, 'tools.disableAll'),
            onPressed: tools.isEmpty ? null : () => _setAll(tools, false),
          ),
        ],
      ),
      body: ContentWidth(
        child: tools.isEmpty
            ? const Center(child: CircularProgressIndicator())
            : Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.fromLTRB(
                      FinanfaSpace.md,
                      FinanfaSpace.md,
                      FinanfaSpace.md,
                      FinanfaSpace.xs,
                    ),
                    child: TextField(
                      controller: _searchController,
                      decoration: InputDecoration(
                        prefixIcon: const Icon(Icons.search, size: 20),
                        hintText: t(ref, 'tools.searchPlaceholder'),
                        isDense: true,
                      ),
                      onChanged: (value) => setState(() => _query = value),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FinanfaSpace.md,
                    ),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          t(ref, 'tools.hintCount')
                              .replaceFirst('{enabled}', '$enabledCount')
                              .replaceFirst('{total}', '${tools.length}'),
                          style: context.textStyles.caption.copyWith(
                            color: c.text,
                          ),
                        ),
                        const SizedBox(height: FinanfaSpace.xs),
                        Text(
                          t(ref, 'tools.hintExplain'),
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: context.textStyles.caption,
                        ),
                      ],
                    ),
                  ),
                  const SizedBox(height: FinanfaSpace.sm),
                  SingleChildScrollView(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.symmetric(
                      horizontal: FinanfaSpace.md,
                    ),
                    child: Row(
                      children: [
                        _RiskTab(
                          label:
                              '${t(ref, 'tools.riskAll')} · ${tools.length}',
                          selected: _risk == null,
                          onTap: () => setState(() => _risk = null),
                        ),
                        for (final risk in const [
                          "safe",
                          "ask",
                          "dangerous",
                        ]) ...[
                          const SizedBox(width: 8),
                          _RiskTab(
                            label:
                                '${t(ref, _riskKey(risk))}'
                                ' · ${tools.where((tool) => tool.riskLevel == risk).length}',
                            selected: _risk == risk,
                            onTap: () => setState(() => _risk = risk),
                          ),
                        ],
                      ],
                    ),
                  ),
                  Expanded(
                    child: ListView.builder(
                      padding: const EdgeInsets.symmetric(
                        horizontal: FinanfaSpace.md,
                        vertical: FinanfaSpace.sm,
                      ),
                      itemCount: visible.length,
                      itemBuilder: (context, i) {
                        final tool = visible[i];
                        return Card(
                          margin: const EdgeInsets.only(
                            bottom: FinanfaSpace.sm,
                          ),
                          child: ListTile(
                            title: Text(
                              tool.name,
                              style: Theme.of(context).textTheme.labelMedium,
                            ),
                            subtitle: _RiskPill(
                              label: t(ref, _riskKey(tool.riskLevel)),
                              color: _riskColor(context, tool.riskLevel),
                            ),
                            trailing: Switch(
                              value: tool.enabled,
                              onChanged: (value) => controller.setToolEnabled(
                                tool.name,
                                value,
                              ),
                            ),
                            onTap: () => controller.setToolEnabled(
                              tool.name,
                              !tool.enabled,
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                ],
              ),
      ),
    );
  }
}

class _RiskTab extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _RiskTab({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(FinanfaRadii.sm),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        decoration: BoxDecoration(
          color: selected ? c.accentFill : c.bgElevated,
          borderRadius: BorderRadius.circular(FinanfaRadii.sm),
          border: Border.all(color: selected ? c.accent : c.border),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: selected ? c.accent : c.textMuted,
            fontSize: 12,
            fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
          ),
        ),
      ),
    );
  }
}

class _RiskPill extends StatelessWidget {
  final String label;
  final Color color;
  const _RiskPill({required this.label, required this.color});

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.centerLeft,
      child: Container(
        margin: const EdgeInsets.only(top: 4),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.12),
          borderRadius: BorderRadius.circular(FinanfaRadii.sm),
        ),
        child: Text(
          label,
          style: TextStyle(
            color: color,
            fontSize: 11,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    );
  }
}
