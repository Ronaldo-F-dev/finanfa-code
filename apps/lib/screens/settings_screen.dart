import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/server_connection.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/server_connection_provider.dart';
import '../state/theme_provider.dart';
import '../theme.dart';
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
      body: ListView(
        children: [
          _SectionLabel(t(ref, 'settings.appearance')),
          RadioGroup<ThemeMode>(
            groupValue: themeMode,
            onChanged: (mode) {
              if (mode != null) {
                ref.read(themeModeProvider.notifier).setMode(mode);
              }
            },
            child: Column(
              children: [
                RadioListTile<ThemeMode>(
                  value: ThemeMode.system,
                  title: Text(t(ref, 'settings.system')),
                ),
                RadioListTile<ThemeMode>(
                  value: ThemeMode.light,
                  title: Text(t(ref, 'settings.light')),
                ),
                RadioListTile<ThemeMode>(
                  value: ThemeMode.dark,
                  title: Text(t(ref, 'settings.dark')),
                ),
              ],
            ),
          ),
          const Divider(),
          _SectionLabel(t(ref, 'settings.language')),
          RadioGroup<String>(
            groupValue: language,
            onChanged: (code) {
              if (code != null) {
                ref.read(languageProvider.notifier).setLanguage(code);
              }
            },
            child: Column(
              children: [
                for (final code in supportedLanguages)
                  RadioListTile<String>(
                    value: code,
                    title: Text(_languageNames[code] ?? code),
                  ),
              ],
            ),
          ),
          const Divider(),
          _SectionLabel(t(ref, 'settings.providers')),
          if (!_loaded)
            const Padding(
              padding: EdgeInsets.all(16),
              child: Center(child: CircularProgressIndicator()),
            )
          else ...[
            _ProviderCard(
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
                        style: TextStyle(color: c.textMuted, fontSize: 12),
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
            _ProviderCard(
              title: t(ref, 'settings.otherProviderTitle'),
              configured: _saved['baseUrl'] != null,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  LabeledField(
                    label: t(ref, 'settings.baseUrl'),
                    child: TextField(
                      controller: _baseUrlController,
                      decoration: InputDecoration(hintText: _saved['baseUrl'] ?? 'https://…/v1'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  LabeledField(
                    label: t(ref, 'settings.model'),
                    child: TextField(
                      controller: _modelController,
                      decoration: InputDecoration(hintText: _saved['model'] ?? 'e.g. llama3.1'),
                    ),
                  ),
                  const SizedBox(height: 8),
                  LabeledField(
                    label: t(ref, 'settings.apiKeyOptional'),
                    child: TextField(
                      controller: _apiKeyController,
                      obscureText: true,
                      decoration: InputDecoration(hintText: _saved['apiKey'] ?? ''),
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
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 4,
                ),
                child: Text(_status!, style: TextStyle(color: c.textMuted)),
              ),
          ],
          const Divider(),
          _SectionLabel(t(ref, 'settings.server')),
          ListTile(
            leading: Icon(Icons.dns_outlined, color: c.textMuted),
            title: Text(t(ref, 'settings.connectedTo')),
            subtitle: Text(widget.connection.baseUrl),
          ),
          ListTile(
            leading: Icon(Icons.key_outlined, color: c.textMuted),
            title: Text(t(ref, 'settings.login')),
            subtitle: Text(
              widget.connection.token != null
                  ? t(ref, 'settings.signedIn')
                  : t(ref, 'settings.noLoginRequired'),
            ),
          ),
          ListTile(
            leading: Icon(Icons.info_outline, color: c.textMuted),
            title: Text(t(ref, 'about.title')),
            onTap: () => Navigator.of(context).push(
              MaterialPageRoute(
                builder: (_) => AboutScreen(connection: widget.connection),
              ),
            ),
          ),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: OutlinedButton.icon(
              style: OutlinedButton.styleFrom(
                foregroundColor: c.danger,
                side: BorderSide(color: c.danger),
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
    );
  }
}

class _ProviderCard extends StatelessWidget {
  final String title;
  final bool configured;
  final Widget child;
  const _ProviderCard({
    required this.title,
    required this.configured,
    required this.child,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Card(
      margin: const EdgeInsets.symmetric(horizontal: FinanfaSpace.lg, vertical: FinanfaSpace.sm),
      child: Padding(
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
      ),
    );
  }
}

class _SectionLabel extends StatelessWidget {
  final String text;
  const _SectionLabel(this.text);
  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(
        FinanfaSpace.lg,
        FinanfaSpace.lg,
        FinanfaSpace.lg,
        FinanfaSpace.xs,
      ),
      child: Text(text, style: context.textStyles.sectionLabel),
    );
  }
}
