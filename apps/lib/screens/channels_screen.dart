import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/finanfa_api_client.dart';
import '../core/models/session_models.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../theme.dart';

final _channelsProvider = FutureProvider.autoDispose<List<ChannelStatus>>((
  ref,
) async {
  final client = ref.watch(apiClientProvider);
  if (client == null) return [];
  return client.fetchChannelsConfig();
});

/// Mirrors packages/web-client/src/components/ChannelsPanel.tsx — same
/// real REST API (/api/channels-config), so a Telegram/Discord/Slack/...
/// bot configured from the phone reaches the exact same finanfa-code
/// server the desktop web UI does.
class ChannelsScreen extends ConsumerWidget {
  const ChannelsScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final channelsAsync = ref.watch(_channelsProvider);
    return Scaffold(
      appBar: AppBar(title: Text(t(ref, 'channels.title'))),
      body: channelsAsync.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, _) => Center(child: Text(t(ref, 'channels.failedToLoad'))),
        data: (channels) => ListView(
          padding: const EdgeInsets.all(12),
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 8),
              child: Text(
                t(ref, 'channels.hint'),
                style: TextStyle(color: context.colors.textMuted, fontSize: 13),
              ),
            ),
            for (final c in channels)
              _ChannelCard(
                channel: c,
                onSaved: () => ref.invalidate(_channelsProvider),
              ),
          ],
        ),
      ),
    );
  }
}

class _ChannelCard extends ConsumerStatefulWidget {
  final ChannelStatus channel;
  final VoidCallback onSaved;
  const _ChannelCard({required this.channel, required this.onSaved});
  @override
  ConsumerState<_ChannelCard> createState() => _ChannelCardState();
}

class _ChannelCardState extends ConsumerState<_ChannelCard> {
  bool _expanded = false;
  final Map<String, TextEditingController> _controllers = {};
  bool _saving = false;
  bool _registeringDiscord = false;
  String? _status;

  TextEditingController _controllerFor(String key) =>
      _controllers.putIfAbsent(key, TextEditingController.new);

  @override
  void dispose() {
    for (final c in _controllers.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    setState(() => _saving = true);
    final client = ref.read(apiClientProvider);
    try {
      final values = {
        for (final f in widget.channel.fields) f.key: _controllerFor(f.key).text.trim(),
      };
      await client?.saveChannelConfig(widget.channel.id, values);
      for (final c in _controllers.values) {
        c.clear();
      }
      widget.onSaved();
      if (mounted) setState(() => _status = t(ref, 'channels.saved'));
    } on FinanfaApiException catch (e) {
      if (mounted) setState(() => _status = e.message);
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  Future<void> _registerDiscord() async {
    setState(() => _registeringDiscord = true);
    final client = ref.read(apiClientProvider);
    try {
      await client?.registerDiscordCommand();
      if (mounted) {
        setState(() => _status = t(ref, 'channels.discordCommandRegistered'));
      }
    } on FinanfaApiException catch (e) {
      if (mounted) setState(() => _status = e.message);
    } finally {
      if (mounted) setState(() => _registeringDiscord = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final channel = widget.channel;
    return Card(
      margin: const EdgeInsets.symmetric(vertical: 6),
      child: InkWell(
        borderRadius: BorderRadius.circular(16),
        onTap: () => setState(() => _expanded = !_expanded),
        child: Padding(
          padding: const EdgeInsets.all(14),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      channel.name,
                      style: TextStyle(fontWeight: FontWeight.w600, color: c.text),
                    ),
                  ),
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 2),
                    decoration: BoxDecoration(
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(
                        color: channel.configured ? c.success : c.border,
                      ),
                    ),
                    child: Text(
                      channel.configured
                          ? t(ref, 'channels.configured')
                          : t(ref, 'channels.notConfigured'),
                      style: TextStyle(
                        fontSize: 10.5,
                        fontWeight: FontWeight.w600,
                        color: channel.configured ? c.success : c.textMuted,
                      ),
                    ),
                  ),
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    color: c.textMuted,
                  ),
                ],
              ),
              if (_expanded) ...[
                const SizedBox(height: 10),
                Text(
                  channel.setupNote,
                  style: TextStyle(color: c.textMuted, fontSize: 12.5),
                ),
                const SizedBox(height: 10),
                for (final f in channel.fields)
                  Padding(
                    padding: const EdgeInsets.only(bottom: 8),
                    child: TextField(
                      controller: _controllerFor(f.key),
                      obscureText: f.secret,
                      enabled: !f.envOverride,
                      decoration: InputDecoration(
                        labelText: f.label,
                        hintText: f.configured
                            ? t(ref, 'channels.savedPlaceholder')
                            : f.placeholder,
                        suffixIcon: f.envOverride
                            ? Tooltip(
                                message: t(ref, 'channels.envOverride'),
                                child: const Icon(Icons.lock_outline, size: 18),
                              )
                            : null,
                      ),
                    ),
                  ),
                FilledButton(
                  onPressed: _saving ? null : _save,
                  child: _saving
                      ? const SizedBox(
                          width: 18,
                          height: 18,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: Colors.white,
                          ),
                        )
                      : Text(t(ref, 'channels.save')),
                ),
                if (channel.webhookPaths != null) ...[
                  const SizedBox(height: 12),
                  for (final w in channel.webhookPaths!)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: Row(
                        children: [
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  w.label,
                                  style: TextStyle(color: c.textMuted, fontSize: 11.5),
                                ),
                                Text(
                                  w.url,
                                  style: TextStyle(
                                    color: c.text,
                                    fontSize: 12,
                                    fontFamily: 'monospace',
                                  ),
                                  overflow: TextOverflow.ellipsis,
                                ),
                              ],
                            ),
                          ),
                          IconButton(
                            icon: const Icon(Icons.copy_outlined, size: 18),
                            onPressed: () =>
                                Clipboard.setData(ClipboardData(text: w.url)),
                          ),
                        ],
                      ),
                    ),
                ],
                if (channel.id == 'discord')
                  OutlinedButton(
                    onPressed: _registeringDiscord ? null : _registerDiscord,
                    child: Text(
                      _registeringDiscord
                          ? t(ref, 'channels.registering')
                          : t(ref, 'channels.registerDiscordCommand'),
                    ),
                  ),
                if (_status != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 6),
                    child: Text(_status!, style: TextStyle(color: c.textMuted)),
                  ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}
