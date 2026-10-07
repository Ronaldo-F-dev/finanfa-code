import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:google_fonts/google_fonts.dart';

import '../core/models/timeline_item.dart';
import '../state/language_provider.dart';
import '../state/tts_provider.dart';
import '../theme.dart';

/// One fenced fragment of a message: either plain prose or a ```lang code
/// block. Real, reported gap: assistant replies were rendered as one flat
/// SelectableText, so a fenced diff the agent sent (e.g. proposing a ci.yml
/// change) showed up as unstyled text mixed in with prose instead of a
/// real code block — see export/mockups/mobile-clair.png's diff card.
sealed class _MessageSegment {
  const _MessageSegment();
}

class _TextSegment extends _MessageSegment {
  final String text;
  const _TextSegment(this.text);
}

class _CodeSegment extends _MessageSegment {
  final String lang;
  final String code;
  const _CodeSegment(this.lang, this.code);
}

final _fencedCodeBlock = RegExp(r'```([\w-]*)\n([\s\S]*?)```');

List<_MessageSegment> _splitMessageSegments(String text) {
  final segments = <_MessageSegment>[];
  var cursor = 0;
  for (final match in _fencedCodeBlock.allMatches(text)) {
    if (match.start > cursor) {
      segments.add(_TextSegment(text.substring(cursor, match.start)));
    }
    segments.add(_CodeSegment(match.group(1) ?? '', match.group(2) ?? ''));
    cursor = match.end;
  }
  if (cursor < text.length) segments.add(_TextSegment(text.substring(cursor)));
  return segments;
}

/// Renders one TimelineItem — mirrors packages/web-client/src/components/
/// ChatMessage.tsx's per-kind branching (user bubble, assistant bubble,
/// system/error log line, tool-call chip, media) in Flutter widgets.
class TimelineTile extends StatelessWidget {
  final TimelineItem item;
  const TimelineTile({super.key, required this.item});

  @override
  Widget build(BuildContext context) {
    return switch (item) {
      UserMessageItem(:final text) => _Bubble(text: text, isUser: true),
      AssistantMessageItem(:final text, :final streaming) => _Bubble(
        text: text.isEmpty && streaming ? '…' : text,
        isUser: false,
        showCopy: !streaming && text.isNotEmpty,
      ),
      LogItem(:final text, :final variant) => _LogLine(
        text: text,
        isError: variant == LogVariant.error,
      ),
      ThinkingItem(:final text, :final streaming) => _ThinkingTile(
        text: text,
        streaming: streaming,
      ),
      ToolCallItem(
        :final toolName,
        :final description,
        :final riskLevel,
        :final result,
      ) =>
        _ToolCallTile(
          toolName: toolName,
          description: description,
          riskLevel: riskLevel,
          result: result,
        ),
      MediaItem(:final path, :final mediaKind) => _LogLine(
        text: '${mediaKind == "image" ? "🖼️" : "🎵"} $path',
        isError: false,
      ),
    };
  }
}

class _Bubble extends StatelessWidget {
  final String text;
  final bool isUser;
  final bool showCopy;
  const _Bubble({
    required this.text,
    required this.isUser,
    this.showCopy = false,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    // User messages never carry a fenced code block worth parsing (they're
    // typed by hand); only an assistant reply's real markdown-ish fences —
    // e.g. a proposed diff — get split into separate prose/code segments.
    final segments = isUser
        ? [_TextSegment(text)]
        : _splitMessageSegments(text);
    final maxWidth = MediaQuery.of(context).size.width * 0.78;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: Column(
        crossAxisAlignment: isUser
            ? CrossAxisAlignment.end
            : CrossAxisAlignment.start,
        children: [
          for (final segment in segments)
            if (segment is _CodeSegment)
              Container(
                margin: const EdgeInsets.only(top: 4),
                constraints: BoxConstraints(maxWidth: maxWidth),
                child: _CodeBlock(lang: segment.lang, code: segment.code),
              )
            else if (segment is _TextSegment && segment.text.trim().isNotEmpty)
              Container(
                margin: const EdgeInsets.only(top: 4),
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 12,
                ),
                constraints: BoxConstraints(maxWidth: maxWidth),
                decoration: BoxDecoration(
                  color: isUser ? c.userBubble : c.bgCard,
                  // Tighter, more asymmetric "Opérateur terminal" shape —
                  // 6 on the three non-tail corners, 2 on the tail corner
                  // (was 18/4).
                  borderRadius: BorderRadius.only(
                    topLeft: const Radius.circular(6),
                    topRight: const Radius.circular(6),
                    bottomLeft: Radius.circular(isUser ? 6 : 2),
                    bottomRight: Radius.circular(isUser ? 2 : 6),
                  ),
                  border: isUser ? null : Border.all(color: c.border),
                ),
                child: SelectableText(
                  segment.text.trim(),
                  // In dark mode the user bubble is now a bold solid fill
                  // (`c.userBubble` == `c.accentFill`) rather than a soft
                  // tint — `c.text` only reaches ~4.24:1 contrast against
                  // it (just under the 4.5:1 target), so dark-mode user
                  // bubbles use pure white text instead. Light mode's user
                  // bubble is still a pale tint, where `c.text` (near-black)
                  // already has ample contrast, so it's left alone.
                  style: context.textStyles.body.copyWith(
                    height: 1.35,
                    color:
                        isUser &&
                            Theme.of(context).brightness == Brightness.dark
                        ? Colors.white
                        : null,
                  ),
                ),
              ),
          if (showCopy)
            Padding(
              padding: const EdgeInsets.only(top: 2),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  _CopyButton(text: text),
                  const SizedBox(width: 12),
                  _ListenButton(text: text),
                ],
              ),
            ),
        ],
      ),
    );
  }
}

/// Real, reported request: a one-tap way to copy an agent reply instead of
/// relying on manual text selection.
class _CopyButton extends ConsumerStatefulWidget {
  final String text;
  const _CopyButton({required this.text});
  @override
  ConsumerState<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends ConsumerState<_CopyButton> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.text));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: _copy,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              _copied ? Icons.check : Icons.copy_outlined,
              size: 14,
              color: c.textMuted,
            ),
            const SizedBox(width: 4),
            Text(
              _copied ? t(ref, 'chat.copied') : t(ref, 'chat.copy'),
              style: TextStyle(color: c.textMuted, fontSize: 11.5),
            ),
          ],
        ),
      ),
    );
  }
}

/// Real, reported request: hear an agent reply read aloud (text-to-speech).
/// Tapping again while playing stops it — only one message plays at a time
/// (see tts_provider.dart), so a stray still-speaking previous reply never
/// overlaps a newly requested one.
class _ListenButton extends ConsumerStatefulWidget {
  final String text;
  const _ListenButton({required this.text});
  @override
  ConsumerState<_ListenButton> createState() => _ListenButtonState();
}

class _ListenButtonState extends ConsumerState<_ListenButton> {
  bool _speaking = false;

  Future<void> _toggle() async {
    final tts = ref.read(ttsProvider);
    if (_speaking) {
      await tts.stop();
      if (mounted) setState(() => _speaking = false);
      return;
    }
    setState(() => _speaking = true);
    tts.setCompletionHandler(() {
      if (mounted) setState(() => _speaking = false);
    });
    await tts.speak(widget.text);
  }

  @override
  void dispose() {
    if (_speaking) ref.read(ttsProvider).stop();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return InkWell(
      borderRadius: BorderRadius.circular(8),
      onTap: _toggle,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              _speaking ? Icons.stop_circle_outlined : Icons.volume_up_outlined,
              size: 14,
              color: c.textMuted,
            ),
            const SizedBox(width: 4),
            Text(
              _speaking ? t(ref, 'chat.stopListening') : t(ref, 'chat.listen'),
              style: TextStyle(color: c.textMuted, fontSize: 11.5),
            ),
          ],
        ),
      ),
    );
  }
}

/// A fenced code block rendered as its own dark card — header with the
/// fence's language tag and a copy button, monospace body. When the fence
/// is ```diff (the shape a proposed patch actually arrives in), +/- lines
/// get real diff coloring; anything else is plain monospace, no invented
/// syntax highlighting for languages this doesn't actually parse.
class _CodeBlock extends ConsumerStatefulWidget {
  final String lang;
  final String code;
  const _CodeBlock({required this.lang, required this.code});

  @override
  ConsumerState<_CodeBlock> createState() => _CodeBlockState();
}

class _CodeBlockState extends ConsumerState<_CodeBlock> {
  bool _copied = false;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.code));
    if (!mounted) return;
    setState(() => _copied = true);
    Future.delayed(const Duration(seconds: 2), () {
      if (mounted) setState(() => _copied = false);
    });
  }

  @override
  Widget build(BuildContext context) {
    final isDiff = widget.lang.toLowerCase() == 'diff';
    final lines = widget.code.split('\n');
    if (lines.isNotEmpty && lines.last.isEmpty) lines.removeLast();
    final mono = GoogleFonts.ibmPlexMono(
      fontSize: 12.5,
      height: 1.5,
      color: const Color(0xFFE9ECF4),
    );

    return Container(
      decoration: BoxDecoration(
        color: const Color(0xFF11141C),
        borderRadius: BorderRadius.circular(FinanfaRadii.md),
      ),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
            decoration: const BoxDecoration(
              border: Border(bottom: BorderSide(color: Color(0xFF262C3A))),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    widget.lang.isEmpty ? 'code' : widget.lang,
                    style: GoogleFonts.ibmPlexMono(
                      fontSize: 11,
                      color: const Color(0xFF8D96AC),
                    ),
                  ),
                ),
                InkWell(
                  onTap: _copy,
                  borderRadius: BorderRadius.circular(6),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 4,
                      vertical: 2,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          _copied ? Icons.check : Icons.copy_outlined,
                          size: 12,
                          color: const Color(0xFF8D96AC),
                        ),
                        const SizedBox(width: 4),
                        Text(
                          _copied ? t(ref, 'chat.copied') : t(ref, 'chat.copy'),
                          style: GoogleFonts.ibmPlexMono(
                            fontSize: 11,
                            color: const Color(0xFF8D96AC),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            child: SelectableText.rich(
              TextSpan(
                children: [
                  for (final line in lines)
                    TextSpan(
                      text: '$line\n',
                      style: isDiff && line.startsWith('+')
                          ? mono.copyWith(color: const Color(0xFF34D399))
                          : isDiff && line.startsWith('-')
                          ? mono.copyWith(color: const Color(0xFFF87171))
                          : mono,
                    ),
                ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _LogLine extends StatelessWidget {
  final String text;
  final bool isError;
  const _LogLine({required this.text, required this.isError});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final color = isError ? c.danger : c.textMuted;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Icon(
            isError ? Icons.error_outline : Icons.info_outline,
            size: 16,
            color: color,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(text, style: TextStyle(color: color, fontSize: 13.5)),
          ),
        ],
      ),
    );
  }
}

class _ToolChip extends StatelessWidget {
  final String toolName;
  final String description;
  final ToolRiskLevel riskLevel;

  /// Optional end-of-row widget — the expand chevron (or the muted "…" for
  /// a call still running) `_ToolCallTile` adds.
  final Widget? trailing;

  /// Set only when there is something to reveal; a running call's chip
  /// stays inert, exactly as before results existed.
  final VoidCallback? onTap;
  const _ToolChip({
    required this.toolName,
    required this.description,
    required this.riskLevel,
    this.trailing,
    this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final mono = Theme.of(context).textTheme.labelMedium;
    // riskLevel is a permission classification, not a real execution
    // outcome (the protocol carries no success/failure/timing for a tool
    // call — see useAgentSocket.ts's own tool_call message), so this icon
    // reads as "how much trust this call needed", not "it succeeded".
    final (icon, iconColor) = switch (riskLevel) {
      ToolRiskLevel.dangerous => (Icons.warning_rounded, c.danger),
      ToolRiskLevel.ask => (Icons.pan_tool_alt_rounded, c.warning),
      ToolRiskLevel.safe => (Icons.check_rounded, c.success),
    };
    final chip = Container(
      margin: const EdgeInsets.symmetric(vertical: FinanfaSpace.xs),
      padding: const EdgeInsets.symmetric(
        horizontal: FinanfaSpace.md,
        vertical: FinanfaSpace.sm + 2,
      ),
      decoration: BoxDecoration(
        color: c.bgElevated,
        borderRadius: BorderRadius.circular(FinanfaRadii.md),
        border: Border.all(color: c.border),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Container(
            width: 20,
            height: 20,
            margin: const EdgeInsets.only(top: 1),
            decoration: BoxDecoration(
              color: iconColor.withValues(alpha: 0.15),
              shape: BoxShape.circle,
            ),
            child: Icon(icon, size: 13, color: iconColor),
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Text(toolName, style: mono?.copyWith(fontSize: 13)),
                if (description.isNotEmpty) ...[
                  const SizedBox(width: 6),
                  Expanded(
                    child: Text(
                      description,
                      overflow: TextOverflow.ellipsis,
                      style: context.textStyles.caption,
                    ),
                  ),
                ],
              ],
            ),
          ),
          ?trailing,
        ],
      ),
    );
    if (onTap == null) return chip;
    return GestureDetector(onTap: onTap, child: chip);
  }
}

/// A tool call with its real output — collapsed to the same chip the app
/// always showed, expandable to the tool's actual result, mirroring the web
/// client's and the VS Code webview's IN/OUT block. A call whose result
/// hasn't arrived yet shows the chip with a muted "…" and stays inert.
class _ToolCallTile extends StatefulWidget {
  final String toolName;
  final String description;
  final ToolRiskLevel riskLevel;
  final ToolResult? result;
  const _ToolCallTile({
    required this.toolName,
    required this.description,
    required this.riskLevel,
    required this.result,
  });

  @override
  State<_ToolCallTile> createState() => _ToolCallTileState();
}

class _ToolCallTileState extends State<_ToolCallTile> {
  // Collapsed by default, same as the web and VS Code clients — a long
  // turn with several tool calls would otherwise flood the conversation.
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    final mono = Theme.of(context).textTheme.labelMedium;
    final result = widget.result;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        _ToolChip(
          toolName: widget.toolName,
          description: widget.description,
          riskLevel: widget.riskLevel,
          trailing: result == null
              ? Text('…', style: context.textStyles.caption)
              : Icon(
                  _expanded ? Icons.expand_less : Icons.expand_more,
                  size: 16,
                  color: c.textMuted,
                ),
          onTap: result == null
              ? null
              : () => setState(() => _expanded = !_expanded),
        ),
        if (_expanded && result != null)
          Container(
            margin: const EdgeInsets.only(bottom: FinanfaSpace.xs, left: 8),
            padding: const EdgeInsets.all(FinanfaSpace.sm + 2),
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(
              color: c.bgCard,
              borderRadius: BorderRadius.circular(FinanfaRadii.md),
              border: Border.all(color: result.isError ? c.danger : c.border),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                result.content.isEmpty ? '…' : result.content,
                style: mono?.copyWith(
                  fontSize: 12,
                  color: result.isError ? c.danger : c.textMuted,
                ),
              ),
            ),
          ),
      ],
    );
  }
}

/// The model's reasoning, streamed before the reply — the app equivalent of
/// the web client's collapsed "Reasoning" block and the CLI's dim italic
/// text. Collapsed by default; a running block shows a muted "…", and a tap
/// reveals the reasoning itself.
class _ThinkingTile extends ConsumerStatefulWidget {
  final String text;
  final bool streaming;
  const _ThinkingTile({required this.text, required this.streaming});

  @override
  ConsumerState<_ThinkingTile> createState() => _ThinkingTileState();
}

class _ThinkingTileState extends ConsumerState<_ThinkingTile> {
  bool _expanded = false;

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        GestureDetector(
          onTap: () => setState(() => _expanded = !_expanded),
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: FinanfaSpace.xs),
            padding: const EdgeInsets.symmetric(
              horizontal: FinanfaSpace.md,
              vertical: FinanfaSpace.sm + 2,
            ),
            decoration: BoxDecoration(
              color: c.bgElevated,
              borderRadius: BorderRadius.circular(FinanfaRadii.md),
              border: Border.all(color: c.border),
            ),
            child: Row(
              children: [
                Icon(Icons.auto_awesome, size: 14, color: c.accent),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    t(ref, 'thinking.title'),
                    style: Theme.of(
                      context,
                    ).textTheme.labelMedium?.copyWith(fontSize: 13),
                  ),
                ),
                if (widget.streaming)
                  Text('…', style: context.textStyles.caption)
                else
                  Icon(
                    _expanded ? Icons.expand_less : Icons.expand_more,
                    size: 16,
                    color: c.textMuted,
                  ),
              ],
            ),
          ),
        ),
        if (_expanded)
          Container(
            margin: const EdgeInsets.only(bottom: FinanfaSpace.xs, left: 8),
            padding: const EdgeInsets.all(FinanfaSpace.sm + 2),
            constraints: const BoxConstraints(maxHeight: 220),
            decoration: BoxDecoration(
              color: c.bgCard,
              borderRadius: BorderRadius.circular(FinanfaRadii.md),
              border: Border.all(color: c.border),
            ),
            child: SingleChildScrollView(
              child: SelectableText(
                widget.text.isEmpty ? '…' : widget.text,
                style: Theme.of(context).textTheme.labelMedium?.copyWith(
                  fontSize: 12,
                  fontStyle: FontStyle.italic,
                  color: c.textMuted,
                ),
              ),
            ),
          ),
      ],
    );
  }
}
