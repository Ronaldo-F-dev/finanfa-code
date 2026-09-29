import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/server_connection.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/server_connection_provider.dart';
import '../state/theme_provider.dart';
import '../theme.dart';
import '../widgets/content_width.dart';
import '../widgets/labeled_field.dart';
import 'about_screen.dart';

const _languageNames = {'en': 'English', 'fr': 'Français'};

class SettingsScreen extends ConsumerStatefulWidget {
  final ServerConnection connection;
  const SettingsScreen({super.key, required this.connection});
  @override
  ConsumerState<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends ConsumerState<SettingsScreen> {
  final _anthropicKeyController = TextEditingController();
  final _baseUrlController = TextEditingController();
  final _modelController = TextEditingController();
  final _apiKeyController = TextEditingController();

  Map<String, String?> _saved = const {};
  String? _status;
  bool _loaded = false;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  @override
  void dispose() {
    _anthropicKeyController.dispose();
    _baseUrlController.dispose();
    _modelController.dispose();
    _apiKeyController.dispose();
    super.dispose();
  }

  Future<void> _refresh() async {
    final client = ref.read(apiClientProvider);
    if (client == null) return;
    final result = await client.fetchConfig();
    if (!mounted) return;
    setState(() {
      _saved = result.config;
      _loaded = true;
    });
  }

  Future<void> _saveAnthropic() async {
    final key = _anthropicKeyController.text.trim();
    if (key.isEmpty) return;
    setState(() => _status = t(ref, 'settings.saving'));
    final client = ref.read(apiClientProvider);
    final note = await client?.saveConfig({'anthropicApiKey': key});
    _anthropicKeyController.clear();
    await _refresh();
    if (mounted) setState(() => _status = note ?? t(ref, 'settings.saved'));
  }

  Future<void> _saveOther() async {
    setState(() => _status = t(ref, 'settings.saving'));
    final client = ref.read(apiClientProvider);
    final note = await client?.saveConfig({
      'provider': 'openai-compatible',
      if (_baseUrlController.text.trim().isNotEmpty)
        'baseUrl': _baseUrlController.text.trim(),
      if (_modelController.text.trim().isNotEmpty)
        'model': _modelController.text.trim(),
      if (_apiKeyController.text.trim().isNotEmpty)
        'apiKey': _apiKeyController.text.trim(),
    });
    _baseUrlController.clear();
    _modelController.clear();
    _apiKeyController.clear();
    await _refresh();
    if (mounted) setState(() => _status = note ?? t(ref, 'settings.saved'));
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final themeMode = ref.watch(themeModeProvider);
    final language = ref.watch(languageProvider);

    return Scaffold(
      appBar: AppBar(title: Text(t(ref, 'settings.title'))),
      body: ContentWidth(
        child: ListView(
          padding: const EdgeInsets.all(FinanfaSpace.lg),
          children: [
            _SettingsSection(
              title: t(ref, 'settings.appearance'),
              child: _OptionGroup<ThemeMode>(
                value: themeMode,
                onChanged: (mode) =>
                    ref.read(themeModeProvider.notifier).setMode(mode),
                options: [
                  (ThemeMode.system, t(ref, 'settings.system')),
                  (ThemeMode.light, t(ref, 'settings.light')),
                  (ThemeMode.dark, t(ref, 'settings.dark')),
                ],
              ),
            ),
            const SizedBox(height: FinanfaSpace.lg),
            _SettingsSection(
              title: t(ref, 'settings.language'),
              child: _OptionGroup<String>(
                value: language,
                onChanged: (code) =>
                    ref.read(languageProvider.notifier).setLanguage(code),
                options: [
                  for (final code in supportedLanguages)
                    (code, _languageNames[code] ?? code),
                ],
              ),
            ),
            const SizedBox(height: FinanfaSpace.lg),
            _SettingsSection(
              title: t(ref, 'settings.providers'),
              padded: false,
              child: !_loaded
                  ? const Padding(
                      padding: EdgeInsets.all(24),
                      child: Center(child: CircularProgressIndicator()),
                    )
                  : Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        _ProviderTile(
                          title: t(ref, 'settings.anthropicTitle'),
                          configured: _saved['anthropicApiKey'] != null,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              if (_saved['anthropicApiKey'] != null)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 8),
                                  child: Text(
                                    _saved['anthropicApiKey']!,
                                    style: TextStyle(
                                      color: c.textMuted,
                                      fontSize: 12,
                                    ),
                                  ),
                                ),
                              Row(
                                children: [
                                  Expanded(
                                    child: TextField(
                                      controller: _anthropicKeyController,
                                      obscureText: true,
                                      decoration: const InputDecoration(
                                        hintText: 'sk-ant-…',
                                      ),
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  FilledButton(
                                    onPressed: _saveAnthropic,
                                    child: Text(t(ref, 'settings.save')),
                                  ),
                                ],
                              ),
                            ],
                          ),
                        ),
                        Divider(height: 1, color: c.border),
                        _ProviderTile(
                          title: t(ref, 'settings.otherProviderTitle'),
                          configured: _saved['baseUrl'] != null,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              LabeledField(
                                label: t(ref, 'settings.baseUrl'),
                                child: TextField(
                                  controller: _baseUrlController,
                                  decoration: InputDecoration(
                                    hintText:
                                        _saved['baseUrl'] ?? 'https://…/v1',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 8),
                              LabeledField(
                                label: t(ref, 'settings.model'),
                                child: TextField(
                                  controller: _modelController,
                                  decoration: InputDecoration(
                                    hintText:
                                        _saved['model'] ?? 'e.g. llama3.1',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 8),
                              LabeledField(
                                label: t(ref, 'settings.apiKeyOptional'),
                                child: TextField(
                                  controller: _apiKeyController,
                                  obscureText: true,
                                  decoration: InputDecoration(
                                    hintText: _saved['apiKey'] ?? '',
                                  ),
                                ),
                              ),
                              const SizedBox(height: 8),
                              FilledButton(
                                onPressed: _saveOther,
                                child: Text(t(ref, 'settings.save')),
                              ),
                            ],
                          ),
                        ),
                        if (_status != null)
                          Padding(
                            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
                            child: Text(
                              _status!,
                              style: TextStyle(color: c.textMuted),
                            ),
                          ),
                      ],
                    ),
            ),
            const SizedBox(height: FinanfaSpace.lg),
            _SettingsSection(
              title: t(ref, 'settings.server'),
              padded: false,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  _SettingsRow(
                    icon: Icons.dns_outlined,
                    title: t(ref, 'settings.connectedTo'),
                    subtitle: widget.connection.baseUrl,
                  ),
                  Divider(height: 1, color: c.border),
                  _SettingsRow(
                    icon: Icons.key_outlined,
                    title: t(ref, 'settings.login'),
                    subtitle: widget.connection.token != null
                        ? t(ref, 'settings.signedIn')
                        : t(ref, 'settings.noLoginRequired'),
                  ),
                  Divider(height: 1, color: c.border),
                  _SettingsRow(
                    icon: Icons.info_outline,
                    title: t(ref, 'about.title'),
                    trailing: Icons.chevron_right_rounded,
                    onTap: () => Navigator.of(context).push(
                      MaterialPageRoute(
                        builder: (_) =>
                            AboutScreen(connection: widget.connection),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: FinanfaSpace.lg),
            SizedBox(
              width: double.infinity,
              child: OutlinedButton.icon(
                style: OutlinedButton.styleFrom(
                  foregroundColor: c.danger,
                  side: BorderSide(color: c.danger),
                  padding: const EdgeInsets.symmetric(vertical: 12),
                ),
                icon: const Icon(Icons.logout),
                label: Text(t(ref, 'settings.disconnect')),
                onPressed: () async {
                  await ref.read(serverConnectionProvider.notifier).forget();
                  if (context.mounted) {
                    Navigator.of(context).popUntil((route) => route.isFirst);
                  }
                },
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A compact, bespoke replacement for `RadioGroup`/`RadioListTile` — those
/// rendered as generic Material list rows (default ripple-circle radio,
/// full-width tile) that clashed with the flatter "Opérateur terminal"
/// direction elsewhere on this screen. Hand-rolled instead of a reskinned
/// `RadioListTile` because `RadioListTile`'s own styling hooks (`shape`,
/// `activeColor`/`fillColor`) can recolor the tile and the radio glyph but
/// can't reshape the indicator itself into the flat ring/filled-ring dot the
/// approved mockup uses — the built-in Radio always draws Material's own
/// circular check glyph. `Semantics` reproduces exactly what `RadioListTile`
/// would have given a screen reader (`button`, `selected`, and a label),
/// so this loses no accessibility versus the widget it replaces.
class _OptionGroup<T> extends StatelessWidget {
  final T value;
  final ValueChanged<T> onChanged;
  final List<(T, String)> options;
  const _OptionGroup({
    required this.value,
    required this.onChanged,
    required this.options,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        for (final (optionValue, label) in options)
          _OptionRow<T>(
            label: label,
            selected: optionValue == value,
            onTap: () => onChanged(optionValue),
          ),
      ],
    );
  }
}

class _OptionRow<T> extends StatelessWidget {
  final String label;
  final bool selected;
  final VoidCallback onTap;
  const _OptionRow({
    required this.label,
    required this.selected,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Semantics(
      button: true,
      selected: selected,
      label: label,
      child: InkWell(
        onTap: onTap,
        borderRadius: BorderRadius.circular(FinanfaRadii.md),
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: FinanfaSpace.lg,
            vertical: FinanfaSpace.sm + 2,
          ),
          child: Row(
            children: [
              // Unfilled ring in `c.border` when unselected, accent-filled
              // ring when selected — a flatter, sharper-edged stand-in for
              // the default Material radio glyph.
              Container(
                width: 18,
                height: 18,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  border: Border.all(
                    color: selected ? c.accent : c.border,
                    width: 1.5,
                  ),
                ),
                padding: const EdgeInsets.all(3),
                child: selected
                    ? DecoratedBox(
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: c.accent,
                        ),
                      )
                    : null,
              ),
              const SizedBox(width: FinanfaSpace.md),
              Text(label, style: context.textStyles.body),
            ],
          ),
        ),
      ),
    );
  }
}

/// A bounded, titled section — the whole screen used to be one flat
/// `ListView` with `Divider`s and floating labels between ungrouped rows
/// (real feedback: "trop basique", the structure/density specifically).
/// Every section is now a real boxed card with its title INSIDE the box,
/// matching the same border/radius/flat-elevation language as
/// `_ProviderTile`'s row dividers, instead of some parts being cards
/// (Providers) and others a bare list (Appearance, Server).
class _SettingsSection extends StatelessWidget {
  final String title;
  final Widget child;

  /// false for sections whose child already manages its own internal
  /// padding/dividers per row (Providers, Server) — true (default) for
  /// ones that just need the standard content inset (Appearance, Language).
  final bool padded;
  const _SettingsSection({
    required this.title,
    required this.child,
    this.padded = true,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Container(
      decoration: BoxDecoration(
        color: c.bgCard,
        borderRadius: BorderRadius.circular(FinanfaRadii.lg),
        border: Border.all(color: c.border),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              FinanfaSpace.lg,
              FinanfaSpace.md,
              FinanfaSpace.lg,
              FinanfaSpace.sm,
            ),
            child: Text(title, style: context.textStyles.sectionLabel),
          ),
          Divider(height: 1, color: c.border),
          padded
              ? Padding(
                  padding: const EdgeInsets.symmetric(
                    vertical: FinanfaSpace.xs,
                  ),
                  child: child,
                )
              : child,
        ],
      ),
    );
  }
}

/// A provider's config block within the Providers section — same content
/// as the old `_ProviderCard`, just laid out as a row inside the shared
/// section box instead of being its own separate floating `Card`.
class _ProviderTile extends StatelessWidget {
  final String title;
  final bool configured;
  final Widget child;
  const _ProviderTile({
    required this.title,
    required this.configured,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.all(FinanfaSpace.lg),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Text(title, style: context.textStyles.itemTitle),
              if (configured) ...[
                const SizedBox(width: FinanfaSpace.sm),
                Icon(Icons.check_circle, size: 16, color: c.success),
              ],
            ],
          ),
          const SizedBox(height: FinanfaSpace.md),
          child,
        ],
      ),
    );
  }
}

/// A single info/nav row inside the Server section — the plain `ListTile`
/// this replaces read fine but visually clashed once boxed inside
/// `_SettingsSection` (its default padding/icon color didn't line up with
/// `_ProviderTile`'s own rhythm above it in the same box).
class _SettingsRow extends StatelessWidget {
  final IconData icon;
  final String title;
  final String? subtitle;
  final IconData? trailing;
  final VoidCallback? onTap;
  const _SettingsRow({
    required this.icon,
    required this.title,
    this.subtitle,
    this.trailing,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: FinanfaSpace.lg,
          vertical: FinanfaSpace.md,
        ),
        child: Row(
          children: [
            Icon(icon, size: 20, color: c.textMuted),
            const SizedBox(width: FinanfaSpace.md),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(title, style: context.textStyles.body),
                  if (subtitle != null)
                    Text(
                      subtitle!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: context.textStyles.caption,
                    ),
                ],
              ),
            ),
            if (trailing != null) Icon(trailing, size: 18, color: c.textMuted),
          ],
        ),
      ),
    );
  }
}
