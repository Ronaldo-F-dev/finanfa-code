import 'dart:convert';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../core/models/timeline_item.dart';
import '../core/server_connection.dart';
import '../state/agent_session_controller.dart';
import '../state/agent_session_provider.dart';
import '../state/api_client_provider.dart';
import '../state/language_provider.dart';
import '../state/project_provider.dart';
import '../state/server_connection_provider.dart';
import '../state/sessions_provider.dart';
import '../theme.dart';
import '../widgets/busy_indicator.dart';
import '../widgets/content_width.dart';
import '../widgets/permission_sheet.dart';
import '../widgets/picker_sheets.dart';
import '../widgets/timeline_tile.dart';
import '../widgets/todo_board.dart';
import 'artifacts_screen.dart';
import 'channels_screen.dart';
import 'connectors_screen.dart';
import 'projects_screen.dart';
import 'settings_screen.dart';
import 'tools_screen.dart';

const _imageExtensions = {'png', 'jpg', 'jpeg', 'gif', 'webp'};
const _imageMimeTypes = {
  'png': 'image/png',
  'jpg': 'image/jpeg',
  'jpeg': 'image/jpeg',
  'gif': 'image/gif',
  'webp': 'image/webp',
};

/// The AppBar's second line — host + live status, mirroring the design
/// export's "srv-01 · 4 outils actifs" pattern (export/mockups/mobile-clair.png)
/// with real data: the connected server's host and the current session's
/// real tool count, not a fabricated figure.
String _appBarSubtitle(
  WidgetRef ref,
  AgentSessionController controller,
  ServerConnection connection,
) {
  final host = Uri.tryParse(connection.baseUrl)?.host;
  final hostLabel = (host == null || host.isEmpty) ? connection.baseUrl : host;
  if (!controller.connected) {
    return '$hostLabel · ${t(ref, 'chat.disconnected')}';
  }
  final toolCount = controller.sessionInfo?.toolCount ?? 0;
  final status = toolCount > 0
      ? t(ref, 'chat.toolsActive').replaceFirst('{count}', '$toolCount')
      : t(ref, 'chat.connected');
  return '$hostLabel · $status';
}

class ChatScreen extends ConsumerStatefulWidget {
  final ServerConnection connection;
  const ChatScreen({super.key, required this.connection});
  @override
  ConsumerState<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends ConsumerState<ChatScreen> {
  final _textController = TextEditingController();
  final _scrollController = ScrollController();
  String? _openedSessionId;
  bool _hasOpened = false;
  int? _lastPermissionRequestId;
  String? _lastShownWarning;
  final List<Attachment> _pendingImages = [];
  final List<({String name, String path})> _pendingFiles = [];
  bool _uploading = false;

  final SpeechToText _speech = SpeechToText();
  bool _speechAvailable = false;
  bool _listening = false;
  // The composer's own text right before dictation started — speech_to_text
  // reports each recognition result as the FULL phrase so far, not a delta,
  // so re-appending on every partial result would duplicate words; this is
  // added back in front of each result instead of accumulating deltas.
  String _textBeforeDictation = '';

  @override
  void initState() {
    super.initState();
    _speech
        .initialize()
        .then((available) {
          if (mounted) setState(() => _speechAvailable = available);
        })
        .catchError((_) {
          if (mounted) setState(() => _speechAvailable = false);
        });
  }

  @override
  void dispose() {
    _textController.dispose();
    _scrollController.dispose();
    _speech.stop();
    super.dispose();
  }

  /// Real feature request: dictate a message instead of typing it. Toggled
  /// by the mic button — tapping again (or the platform detecting silence)
  /// stops listening; whatever was recognized stays in the text field for
  /// the user to review/edit before sending, same as typing normally.
  Future<void> _toggleListening() async {
    if (!_speechAvailable) return;
    if (_listening) {
      await _speech.stop();
      setState(() => _listening = false);
      return;
    }
    _textBeforeDictation = _textController.text;
    setState(() => _listening = true);
    final languageCode = ref.read(languageProvider) == 'fr' ? 'fr_FR' : 'en_US';
    await _speech.listen(
      onResult: (result) {
        final prefix = _textBeforeDictation.isEmpty
            ? ''
            : '$_textBeforeDictation ';
        _textController.text = '$prefix${result.recognizedWords}';
        _textController.selection = TextSelection.collapsed(
          offset: _textController.text.length,
        );
        if (result.finalResult && mounted) {
          setState(() => _listening = false);
        }
      },
      // ignore: deprecated_member_use
      localeId: languageCode,
    );
  }

  String? _openedProjectId;

  void _openSession(String? sessionId) {
    final projectId = ref.read(currentProjectProvider);
    if (_hasOpened &&
        _openedSessionId == sessionId &&
        _openedProjectId == projectId) {
      return;
    }
    _hasOpened = true;
    _openedSessionId = sessionId;
    _openedProjectId = projectId;
    Future.microtask(
      () => ref
          .read(agentSessionProvider)
          .open(
            connection: widget.connection,
            sessionId: sessionId,
            projectId: projectId,
          ),
    );
  }

  void _scrollToBottom() {
    if (!_scrollController.hasClients) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollController.hasClients) return;
      _scrollController.animateTo(
        _scrollController.position.maxScrollExtent,
        duration: const Duration(milliseconds: 200),
        curve: Curves.easeOut,
      );
    });
  }

  /// Real, reported request: this server already knows exactly what a
  /// local model can/can't do (see effort-tiers.ts's own per-tier
  /// verification) — the crash-risk warning it sends once per connection
  /// (see index.ts's set_model/set_effort handlers) doesn't need to sit
  /// permanently in the chat transcript; a one-time popup the user
  /// acknowledges and moves past is enough.
  void _showLocalModelWarningDialog(String warning) {
    showDialog<void>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(t(ref, 'warning.title')),
        content: Text(warning.replaceFirst('⚠', '').trim()),
        actions: [
          FilledButton(
            onPressed: () {
              ref.read(agentSessionProvider).dismissLocalModelWarning();
              Navigator.of(ctx).pop();
            },
            child: Text(t(ref, 'warning.understood')),
          ),
        ],
      ),
    );
  }

  void _send() {
    final text = _textController.text.trim();
    if (text.isEmpty && _pendingImages.isEmpty && _pendingFiles.isEmpty) {
      return;
    }
    // Real, reported friction: an uploaded file's full path used to be
    // spliced directly into the editable text field, mixed in with
    // whatever the user typed — one stray keystroke (or Cmd+A / a swipe
    // gesture) could clip a character off the middle of the path, quietly
    // corrupting a reference the model would then fail to resolve. Kept as
    // separate, non-editable chips (like the image thumbnails) instead,
    // and only stitched into the actual message text right here, at send
    // time — never sitting inside the text field itself.
    final fileRefs = _pendingFiles
        .map((f) => '[Attached file: ${f.path}]')
        .join('\n');
    final combinedText = [
      if (text.isNotEmpty) text,
      if (fileRefs.isNotEmpty) fileRefs,
    ].join('\n');
    ref
        .read(agentSessionProvider)
        .sendMessage(
          combinedText.isEmpty ? '(see attached image)' : combinedText,
          images: _pendingImages.isEmpty ? null : List.of(_pendingImages),
        );
    _textController.clear();
    setState(() {
      _pendingImages.clear();
      _pendingFiles.clear();
    });
    _scrollToBottom();
  }

  /// Mirrors App.tsx's handleFiles: an image attaches inline (base64, sent
  /// with the next message); anything else uploads to the project and gets
  /// referenced by path in the message text, since only images travel over
  /// the WebSocket itself.
  Future<void> _pickAttachment() async {
    // file_picker 13 dropped FilePickerResult/PlatformFile.bytes: pickFiles()
    // now always allows multiple selection and returns the files directly,
    // with bytes read lazily via readAsBytes() instead of an eager `withData`
    // flag.
    final files = await FilePicker.pickFiles();
    if (files.isEmpty) return;
    setState(() => _uploading = true);
    try {
      for (final file in files) {
        final bytes = await file.readAsBytes();
        final ext = (file.extension ?? '').toLowerCase();
        if (_imageExtensions.contains(ext)) {
          setState(
            () => _pendingImages.add(
              Attachment(
                mimeType: _imageMimeTypes[ext]!,
                base64: base64Encode(bytes),
              ),
            ),
          );
        } else {
          final client = ref.read(apiClientProvider);
          if (client == null) continue;
          // The active project, not the default workspace: the session's
          // cwd is that project's folder, and the path below is what the
          // model will hand to read_file — uploading to the default project
          // produced a path outside the agent's own cwd (mirrors the web
          // client, which has always passed its active project here).
          final path = await client.uploadFile(
            file.name,
            base64Encode(bytes),
            projectId: ref.read(currentProjectProvider),
          );
          setState(() => _pendingFiles.add((name: file.name, path: path)));
        }
      }
    } finally {
      if (mounted) setState(() => _uploading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    // A brand-new chat (no session id in the route yet) opens as soon as
    // this screen builds — mirrors App.tsx defaulting activeSessionId to
    // undefined until the server assigns a real id after the first turn.
    // Watched (not read) so a project switch from the Projects screen — a
    // session belongs to exactly one project's cwd — reconnects to a fresh
    // chat in the new project automatically, same as App.tsx's own
    // handleSelectProject resetting activeSessionId.
    final watchedProjectId = ref.watch(currentProjectProvider);
    if (!_hasOpened || _openedProjectId != watchedProjectId) {
      _openSession(null);
    }

    final controller = ref.watch(agentSessionProvider);
    // How much the current model thinks (low, medium or high): medium unless the user picked another level.
    final effortLevel = controller.sessionInfo?.effortLevel ?? 'medium';
    final c = context.colors;

    ref.listen(agentSessionProvider, (previous, next) {
      _scrollToBottom();
      final req = next.permissionRequest;
      if (req != null && req.requestId != _lastPermissionRequestId) {
        _lastPermissionRequestId = req.requestId;
        showPermissionSheet(
          context,
          req,
          (answer) => ref
              .read(agentSessionProvider)
              .answerPermission(req.requestId, answer),
        );
      }
      final warning = next.localModelWarning;
      if (warning != null && warning != _lastShownWarning) {
        _lastShownWarning = warning;
        _showLocalModelWarningDialog(warning);
      }
    });

    // Bare navigation callbacks, no Navigator.pop() baked in — the narrow
    // overlay Drawer (_SessionsDrawer) pops itself before calling one of
    // these; the wide persistent panel (_SessionsPanel) calls them
    // directly, since there's no overlay route to dismiss.
    void onSelect(String id) => _openSession(id);
    void onNewChat() => _openSession(null);
    void onOpenSettings() => Navigator.of(context).push(
      MaterialPageRoute(
        builder: (_) => SettingsScreen(connection: widget.connection),
      ),
    );
    void onOpenConnectors() =>
        Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => const ConnectorsScreen()));
    void onOpenProjects() =>
        Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => const ProjectsScreen()));
    void onOpenArtifacts() =>
        Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => const ArtifactsScreen()));
    void onOpenChannels() =>
        Navigator.of(context)
            .push(MaterialPageRoute(builder: (_) => const ChannelsScreen()));
    void onOpenTools() => Navigator.of(context)
        .push(MaterialPageRoute(builder: (_) => const ToolsScreen()));

    // Desktop-width windows: show the sessions panel permanently instead of
    // behind a hamburger — see _SessionsPanel's doc comment. `wide` is
    // recomputed every build from the live window width, so resizing a
    // desktop window across the breakpoint switches layouts immediately.
    final wide = MediaQuery.sizeOf(context).width >= 900;

    final scaffold = Scaffold(
      drawer: wide
          ? null
          : _SessionsDrawer(
              connection: widget.connection,
              activeSessionId: controller.sessionInfo?.id,
              onSelect: onSelect,
              onNewChat: onNewChat,
              onOpenSettings: onOpenSettings,
              onOpenConnectors: onOpenConnectors,
              onOpenTools: onOpenTools,
              onOpenProjects: onOpenProjects,
              onOpenArtifacts: onOpenArtifacts,
              onOpenChannels: onOpenChannels,
            ),
      appBar: AppBar(
        titleSpacing: 0,
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              controller.sessionInfo?.title ?? t(ref, 'chat.newChat'),
              overflow: TextOverflow.ellipsis,
            ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 6,
                  height: 6,
                  margin: const EdgeInsets.only(right: 6),
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: controller.connected ? c.success : c.textMuted,
                  ),
                ),
                Flexible(
                  child: Text(
                    _appBarSubtitle(ref, controller, widget.connection),
                    overflow: TextOverflow.ellipsis,
                    style: context.textStyles.caption.copyWith(fontSize: 12),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
      body: Column(
        children: [
          // Real, reported bug: a WS connection that fails to establish (or
          // drops, e.g. the configured server IP changed) left the UI
          // looking normal — a small muted dot in the AppBar subtitle and a
          // composer stuck on "Connecting…" forever — instead of clearly
          // telling the user to go fix the address. Persistent and
          // tappable, straight into Settings, matching the existing
          // model-unavailable banner's styling.
          if (controller.connectionFailed)
            _Banner(
              text:
                  '${t(ref, 'chat.cannotReachServer')} · ${t(ref, 'chat.openSettings')}',
              color: c.danger,
              onTap: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => SettingsScreen(connection: widget.connection),
                ),
              ),
            ),
          if (controller.modelUnavailable case final m?)
            _Banner(text: m.message, color: c.danger),
          // The agent's todo_write checklist — received and stored all
          // along, previously never rendered in the app.
          TodoBoard(todos: controller.todos, title: t(ref, 'todos.title')),
          Expanded(
            child: ContentWidth(
              child: !controller.connected && _openedSessionId != null
                  // Real, reported bug: resuming an existing conversation
                  // tears down and reopens the whole socket (open() clears
                  // the timeline immediately, before the new connection's
                  // history arrives — see AgentSessionController.open), so
                  // for that whole round trip this showed the new-chat empty
                  // state's suggestion cards instead of any loading feedback,
                  // reading as "stuck"/slow rather than "in progress".
                  ? const Center(child: CircularProgressIndicator())
                  : controller.timeline.isEmpty && !controller.busy.active
                  ? _EmptyState(
                      onPickSuggestion: (text) {
                        _textController.text = text;
                        _textController.selection = TextSelection.collapsed(
                          offset: text.length,
                        );
                      },
                    )
                  : ListView.builder(
                      controller: _scrollController,
                      padding: const EdgeInsets.all(16),
                      itemCount:
                          controller.timeline.length +
                          (controller.busy.active ? 1 : 0),
                      itemBuilder: (context, index) {
                        if (index == controller.timeline.length) {
                          return BusyIndicatorTile(
                            label: controller.busy.label,
                          );
                        }
                        return TimelineTile(item: controller.timeline[index]);
                      },
                    ),
            ),
          ),
          SafeArea(
            top: false,
            child: Padding(
              padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
              child: ContentWidth(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_pendingImages.isNotEmpty)
                      SizedBox(
                        height: 56,
                        child: ListView.separated(
                          scrollDirection: Axis.horizontal,
                          itemCount: _pendingImages.length,
                          separatorBuilder: (_, _) => const SizedBox(width: 8),
                          itemBuilder: (context, i) => Stack(
                            children: [
                              ClipRRect(
                                borderRadius: BorderRadius.circular(8),
                                child: Image.memory(
                                  base64Decode(_pendingImages[i].base64),
                                  width: 56,
                                  height: 56,
                                  fit: BoxFit.cover,
                                ),
                              ),
                              Positioned(
                                right: -4,
                                top: -4,
                                child: GestureDetector(
                                  onTap: () => setState(
                                    () => _pendingImages.removeAt(i),
                                  ),
                                  child: CircleAvatar(
                                    radius: 9,
                                    backgroundColor: c.danger,
                                    child: const Icon(
                                      Icons.close,
                                      size: 12,
                                      color: Colors.white,
                                    ),
                                  ),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    if (_pendingFiles.isNotEmpty)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 6),
                        child: Wrap(
                          spacing: 6,
                          runSpacing: 6,
                          children: [
                            for (var i = 0; i < _pendingFiles.length; i++)
                              _FileChip(
                                name: _pendingFiles[i].name,
                                onRemove: () =>
                                    setState(() => _pendingFiles.removeAt(i)),
                              ),
                          ],
                        ),
                      ),
                    Row(
                      children: [
                        IconButton(
                          icon: _uploading
                              ? const SizedBox(
                                  width: 18,
                                  height: 18,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 2,
                                  ),
                                )
                              : const Icon(Icons.attach_file),
                          tooltip: t(ref, 'chat.attach'),
                          onPressed: _uploading ? null : _pickAttachment,
                        ),
                        if (_speechAvailable)
                          IconButton(
                            icon: Icon(
                              _listening ? Icons.mic : Icons.mic_none,
                              color: _listening ? c.danger : null,
                            ),
                            tooltip: t(ref, 'chat.dictate'),
                            onPressed: _toggleListening,
                          ),
                        _ComposerChip(
                          icon: Icons.smart_toy_outlined,
                          label:
                              controller.sessionInfo?.model.split('/').last ??
                              t(ref, 'chat.model'),
                          onTap: () => showModelPickerSheet(
                            context,
                            ref,
                            controller.sessionInfo?.model,
                            // A model whose provider has no key yet: the key is added in Settings.
                            onNeedsKey: () => Navigator.of(context).push(
                              MaterialPageRoute(
                                builder: (_) => SettingsScreen(
                                  connection: widget.connection,
                                ),
                              ),
                            ),
                          ),
                        ),
                        const SizedBox(width: 6),
                        _ComposerChip(
                          icon: Icons.speed_outlined,
                          label: t(ref, 'effort.$effortLevel'),
                          onTap: () =>
                              showEffortPickerSheet(context, ref, effortLevel),
                        ),
                      ],
                    ),
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Expanded(
                          child: TextField(
                            controller: _textController,
                            minLines: 1,
                            maxLines: 5,
                            textInputAction: TextInputAction.send,
                            onSubmitted: (_) => _send(),
                            enabled: controller.connected,
                            decoration: InputDecoration(
                              hintText: controller.connected
                                  ? t(ref, 'chat.composerHint')
                                  : t(ref, 'chat.connecting'),
                            ),
                          ),
                        ),
                        const SizedBox(width: 8),
                        if (controller.busy.active)
                          IconButton.filled(
                            style: IconButton.styleFrom(
                              backgroundColor: c.danger,
                            ),
                            icon: const Icon(Icons.stop),
                            onPressed: () =>
                                ref.read(agentSessionProvider).interrupt(),
                          )
                        else
                          IconButton.filled(
                            style: IconButton.styleFrom(
                              backgroundColor: c.accent,
                            ),
                            icon: const Icon(Icons.arrow_upward),
                            onPressed: controller.connected ? _send : null,
                          ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ],
      ),
    );

    if (!wide) return scaffold;
    // Wide desktop window: the persistent panel + a keyless copy of the
    // Scaffold with its own drawer already nulled out above — Scaffold
    // itself has no "drawer, but always open and not an overlay" mode, so
    // the panel sits beside it in a Row instead.
    return Row(
      children: [
        _SessionsPanel(
          connection: widget.connection,
          activeSessionId: controller.sessionInfo?.id,
          onSelect: onSelect,
          onNewChat: onNewChat,
          onOpenSettings: onOpenSettings,
          onOpenConnectors: onOpenConnectors,
              onOpenTools: onOpenTools,
          onOpenProjects: onOpenProjects,
          onOpenArtifacts: onOpenArtifacts,
          onOpenChannels: onOpenChannels,
        ),
        Expanded(child: scaffold),
      ],
    );
  }
}

/// A pending non-image attachment — the full path (needed by the model, see
/// _send() above) never touches an editable text field, only this chip's
/// label (just the filename) and a tap-to-remove control.
class _FileChip extends ConsumerWidget {
  final String name;
  final VoidCallback onRemove;
  const _FileChip({required this.name, required this.onRemove});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
      decoration: BoxDecoration(
        color: c.bgElevated,
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: c.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.insert_drive_file_outlined, size: 14, color: c.textMuted),
          const SizedBox(width: 6),
          ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 140),
            child: Text(
              name,
              overflow: TextOverflow.ellipsis,
              maxLines: 1,
              style: TextStyle(color: c.text, fontSize: 12.5),
            ),
          ),
          const SizedBox(width: 4),
          InkWell(
            onTap: onRemove,
            borderRadius: BorderRadius.circular(10),
            child: Padding(
              padding: const EdgeInsets.all(2),
              child: Icon(Icons.close, size: 14, color: c.textMuted),
            ),
          ),
        ],
      ),
    );
  }
}

class _ComposerChip extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const _ComposerChip({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(16),
      onTap: onTap,
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        decoration: BoxDecoration(
          color: c.bgElevated,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: c.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: c.textMuted),
            const SizedBox(width: 4),
            ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 96),
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                maxLines: 1,
                style: TextStyle(color: c.textMuted, fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _Banner extends StatelessWidget {
  final String text;
  final Color color;
  final VoidCallback? onTap;
  const _Banner({required this.text, required this.color, this.onTap});
  @override
  Widget build(BuildContext context) {
    final content = Container(
      width: double.infinity,
      color: color.withValues(alpha: 0.12),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 10),
      child: Text(text, style: TextStyle(color: color, fontSize: 13)),
    );
    return onTap == null ? content : InkWell(onTap: onTap, child: content);
  }
}

/// Replaces a bare "ask me something" line on a blank canvas — the plainest
/// screen in the app and the first thing anyone sees on every new chat, so
/// worth an actual welcome layout instead of one line of muted text.
class _EmptyState extends ConsumerWidget {
  final ValueChanged<String> onPickSuggestion;
  const _EmptyState({required this.onPickSuggestion});

  static const _suggestionKeys = [
    'chat.suggestion1',
    'chat.suggestion2',
    'chat.suggestion3',
  ];

  static const _suggestionIcons = [
    Icons.code_rounded,
    Icons.add_circle_outline_rounded,
    Icons.bar_chart_rounded,
  ];

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connection = ref.watch(serverConnectionProvider).valueOrNull;
    final host = connection == null
        ? null
        : (Uri.tryParse(connection.baseUrl)?.host);
    return Align(
      alignment: Alignment.center,
      child: SingleChildScrollView(
        padding: const EdgeInsets.symmetric(horizontal: 28),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const FinanfaMark(size: 36, filled: false),
            const SizedBox(height: 20),
            Text(
              t(ref, 'chat.emptyState'),
              style: Theme.of(context).textTheme.displaySmall
                  ?.copyWith(fontSize: 24),
            ),
            if (host != null) ...[
              const SizedBox(height: FinanfaSpace.sm),
              Text(
                t(ref, 'chat.connectedTo').replaceFirst('{host}', host),
                style: context.textStyles.caption.copyWith(fontSize: 13.5),
              ),
            ],
            const SizedBox(height: FinanfaSpace.xxl),
            for (var i = 0; i < _suggestionKeys.length; i++)
              Padding(
                padding: const EdgeInsets.only(bottom: FinanfaSpace.md),
                child: _SuggestionCard(
                  icon: _suggestionIcons[i],
                  label: t(ref, _suggestionKeys[i]),
                  onTap: () => onPickSuggestion(t(ref, _suggestionKeys[i])),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// A tappable suggestion row — leading icon in a soft accent tile, label,
/// trailing chevron — replacing the old centered pill chips to match
/// export/mockups/mobile-clair.png's empty-state card list.
class _SuggestionCard extends StatelessWidget {
  final IconData icon;
  final String label;
  final VoidCallback onTap;
  const _SuggestionCard({
    required this.icon,
    required this.label,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Material(
      color: c.bgCard,
      borderRadius: BorderRadius.circular(FinanfaRadii.lg),
      child: InkWell(
        borderRadius: BorderRadius.circular(FinanfaRadii.lg),
        onTap: onTap,
        child: Container(
          decoration: BoxDecoration(
            borderRadius: BorderRadius.circular(FinanfaRadii.lg),
            border: Border.all(color: c.border),
          ),
          padding: const EdgeInsets.symmetric(
            horizontal: FinanfaSpace.lg,
            vertical: FinanfaSpace.lg,
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: c.accent.withValues(alpha: 0.12),
                  borderRadius: BorderRadius.circular(FinanfaRadii.sm),
                ),
                child: Icon(icon, size: 18, color: c.accent),
              ),
              const SizedBox(width: FinanfaSpace.md),
              Expanded(
                child: Text(
                  label,
                  style: TextStyle(
                    color: c.text,
                    fontSize: 14.5,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ),
              Icon(Icons.chevron_right_rounded, color: c.textMuted, size: 20),
            ],
          ),
        ),
      ),
    );
  }
}

/// Overlay form (narrow/phone-width windows) — a standard `Drawer` opened
/// via the AppBar's hamburger, holding [_SessionsPanelContent].
class _SessionsDrawer extends StatelessWidget {
  final ServerConnection connection;
  final String? activeSessionId;
  final void Function(String id) onSelect;
  final VoidCallback onNewChat;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenConnectors;
  final VoidCallback onOpenTools;
  final VoidCallback onOpenProjects;
  final VoidCallback onOpenArtifacts;
  final VoidCallback onOpenChannels;
  const _SessionsDrawer({
    required this.connection,
    required this.activeSessionId,
    required this.onSelect,
    required this.onNewChat,
    required this.onOpenSettings,
    required this.onOpenConnectors,
    required this.onOpenTools,
    required this.onOpenProjects,
    required this.onOpenArtifacts,
    required this.onOpenChannels,
  });

  @override
  Widget build(BuildContext context) {
    return Drawer(
      child: _SessionsPanelContent(
        connection: connection,
        activeSessionId: activeSessionId,
        onSelect: (id) {
          Navigator.of(context).pop();
          onSelect(id);
        },
        onNewChat: () {
          Navigator.of(context).pop();
          onNewChat();
        },
        onOpenSettings: () {
          Navigator.of(context).pop();
          onOpenSettings();
        },
        onOpenConnectors: () {
          Navigator.of(context).pop();
          onOpenConnectors();
        },
        onOpenTools: () {
          Navigator.of(context).pop();
          onOpenTools();
        },
        onOpenProjects: () {
          Navigator.of(context).pop();
          onOpenProjects();
        },
        onOpenArtifacts: () {
          Navigator.of(context).pop();
          onOpenArtifacts();
        },
        onOpenChannels: () {
          Navigator.of(context).pop();
          onOpenChannels();
        },
      ),
    );
  }
}

/// Persistent form (desktop-width windows, see `_ChatScreenState.build`'s
/// breakpoint check) — the SAME content rendered inline in a fixed-width
/// side panel instead of behind a hamburger, with no `Navigator.pop()`
/// baked into its callbacks (there's no overlay route to dismiss). Real,
/// reported feedback: on a wide desktop window there was already enough
/// room to show this permanently, and requiring a click to reveal it
/// otherwise looked broken/incomplete rather than like an intentional
/// desktop layout — see `widgets/content_width.dart`'s doc comment for the
/// same root issue (this app had zero desktop-width handling before now).
class _SessionsPanel extends StatelessWidget {
  final ServerConnection connection;
  final String? activeSessionId;
  final void Function(String id) onSelect;
  final VoidCallback onNewChat;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenConnectors;
  final VoidCallback onOpenTools;
  final VoidCallback onOpenProjects;
  final VoidCallback onOpenArtifacts;
  final VoidCallback onOpenChannels;
  const _SessionsPanel({
    required this.connection,
    required this.activeSessionId,
    required this.onSelect,
    required this.onNewChat,
    required this.onOpenSettings,
    required this.onOpenConnectors,
    required this.onOpenTools,
    required this.onOpenProjects,
    required this.onOpenArtifacts,
    required this.onOpenChannels,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return SizedBox(
      width: 300,
      // A real, only-found-by-running-it bug: unlike Drawer (which wraps
      // its child in Material itself), this panel sits directly beside the
      // Scaffold in a Row — so ListTile/InkWell below, which need a
      // Material ancestor, crashed with "No Material widget found" here
      // even though the exact same _SessionsPanelContent renders fine
      // inside the narrow-mode Drawer.
      child: Material(
        color: c.bgElevated,
        child: Column(
          children: [
            Expanded(
              child: _SessionsPanelContent(
                connection: connection,
                activeSessionId: activeSessionId,
                onSelect: onSelect,
                onNewChat: onNewChat,
                onOpenSettings: onOpenSettings,
                onOpenConnectors: onOpenConnectors,
                onOpenTools: onOpenTools,
                onOpenProjects: onOpenProjects,
                onOpenArtifacts: onOpenArtifacts,
                onOpenChannels: onOpenChannels,
              ),
            ),
            VerticalDivider(width: 1, color: c.border),
          ],
        ),
      ),
    );
  }
}

class _SessionsPanelContent extends ConsumerWidget {
  final ServerConnection connection;
  final String? activeSessionId;
  final void Function(String id) onSelect;
  final VoidCallback onNewChat;
  final VoidCallback onOpenSettings;
  final VoidCallback onOpenConnectors;
  final VoidCallback onOpenTools;
  final VoidCallback onOpenProjects;
  final VoidCallback onOpenArtifacts;
  final VoidCallback onOpenChannels;
  const _SessionsPanelContent({
    required this.connection,
    required this.activeSessionId,
    required this.onSelect,
    required this.onNewChat,
    required this.onOpenSettings,
    required this.onOpenConnectors,
    required this.onOpenTools,
    required this.onOpenProjects,
    required this.onOpenArtifacts,
    required this.onOpenChannels,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    final sessionsAsync = ref.watch(sessionListProvider);
    return SafeArea(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 20, 20, 8),
            child: Row(
              children: [
                const FinanfaMark(size: 36),
                const SizedBox(width: 12),
                Text(
                  'finanfa',
                  style: TextStyle(
                    fontSize: 19,
                    fontWeight: FontWeight.w700,
                    color: c.text,
                    letterSpacing: -0.3,
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: FilledButton.icon(
              onPressed: onNewChat,
              icon: const Icon(Icons.add),
              label: Text(t(ref, 'chat.newChat')),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 4),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(
                t(ref, 'chat.chats'),
                style: TextStyle(
                  color: c.textMuted,
                  fontSize: 11,
                  letterSpacing: 0.6,
                ),
              ),
            ),
          ),
          Expanded(
            child: sessionsAsync.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (err, _) => Center(
                child: Text(
                  t(ref, 'chat.failedToLoadChats'),
                  style: TextStyle(color: c.textMuted),
                ),
              ),
              data: (sessions) {
                if (sessions.isEmpty) {
                  return Center(
                    child: Text(
                      t(ref, 'chat.noChats'),
                      style: TextStyle(color: c.textMuted),
                    ),
                  );
                }
                return ListView.builder(
                  itemCount: sessions.length,
                  itemBuilder: (context, index) {
                    final s = sessions[index];
                    final isActive = s.id == activeSessionId;
                    return ListTile(
                      selected: isActive,
                      selectedTileColor: c.accent.withValues(alpha: 0.12),
                      title: Text(
                        s.title ?? t(ref, 'chat.newChat'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                      onTap: () => onSelect(s.id),
                      trailing: IconButton(
                        icon: const Icon(Icons.close, size: 18),
                        onPressed: () async {
                          await ref
                              .read(apiClientProvider)
                              ?.deleteSession(s.id);
                          ref.invalidate(sessionListProvider);
                        },
                      ),
                    );
                  },
                );
              },
            ),
          ),
          const Divider(height: 1),
          const SizedBox(height: 4),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            child: Column(
              children: [
                ListTile(
                  leading: _DrawerIcon(
                    Icons.folder_outlined,
                    const Color(0xFF7C5CFF),
                  ),
                  title: Text(t(ref, 'drawer.projects')),
                  onTap: onOpenProjects,
                ),
                ListTile(
                  leading: _DrawerIcon(
                    Icons.hub_outlined,
                    const Color(0xFF2BB3A3),
                  ),
                  title: Text(t(ref, 'drawer.connectors')),
                  onTap: onOpenConnectors,
                ),
                ListTile(
                  leading: _DrawerIcon(
                    Icons.handyman_outlined,
                    const Color(0xFF2E9E6B),
                  ),
                  title: Text(t(ref, 'drawer.tools')),
                  onTap: onOpenTools,
                ),
                ListTile(
                  leading: _DrawerIcon(
                    Icons.attachment_outlined,
                    const Color(0xFFE0A030),
                  ),
                  title: Text(t(ref, 'drawer.artifacts')),
                  onTap: onOpenArtifacts,
                ),
                ListTile(
                  leading: _DrawerIcon(
                    Icons.forum_outlined,
                    const Color(0xFF3D9BE9),
                  ),
                  title: Text(t(ref, 'drawer.channels')),
                  onTap: onOpenChannels,
                ),
                ListTile(
                  leading: _DrawerIcon(Icons.settings_outlined, c.textMuted),
                  title: Text(t(ref, 'chat.settings')),
                  onTap: onOpenSettings,
                ),
              ],
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// A small colored icon chip for drawer rows — plain muted icons made every
/// destination look identical; a distinct tint per row is a common pattern
/// in polished sidebar UIs (Notion, Linear) that gives at-a-glance scanning.
class _DrawerIcon extends StatelessWidget {
  final IconData icon;
  final Color color;
  const _DrawerIcon(this.icon, this.color);

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 32,
      height: 32,
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.14),
        borderRadius: BorderRadius.circular(FinanfaRadii.sm),
      ),
      child: Icon(icon, size: 18, color: color),
    );
  }
}
