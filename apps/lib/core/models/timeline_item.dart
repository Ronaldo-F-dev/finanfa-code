/// Mirrors packages/web-client/src/hooks/useAgentSocket.ts's TimelineItem
/// union exactly, so this native client stays a drop-in second consumer of
/// the same WebSocket protocol rather than inventing its own shape.
sealed class TimelineItem {
  final String id;
  const TimelineItem({required this.id});
}

class UserMessageItem extends TimelineItem {
  final String text;
  final List<Attachment>? images;
  const UserMessageItem({required super.id, required this.text, this.images});
}

class AssistantMessageItem extends TimelineItem {
  final String text;
  final bool streaming;
  const AssistantMessageItem({
    required super.id,
    required this.text,
    required this.streaming,
  });

  AssistantMessageItem copyWith({String? text, bool? streaming}) =>
      AssistantMessageItem(
        id: id,
        text: text ?? this.text,
        streaming: streaming ?? this.streaming,
      );
}

enum LogVariant { system, error }

class LogItem extends TimelineItem {
  final LogVariant variant;
  final String text;
  const LogItem({required super.id, required this.variant, required this.text});
}

enum ToolRiskLevel { safe, ask, dangerous }

ToolRiskLevel toolRiskLevelFromString(String raw) => switch (raw) {
  "ask" => ToolRiskLevel.ask,
  "dangerous" => ToolRiskLevel.dangerous,
  _ => ToolRiskLevel.safe,
};

/// A finished tool call's output — `isError` colors it the way an error log
/// line is colored; `content` is the tool's real output, not a summary.
class ToolResult {
  final bool isError;
  final String content;
  const ToolResult({required this.isError, required this.content});
}

class ToolCallItem extends TimelineItem {
  final String toolName;
  final String description;
  final ToolRiskLevel riskLevel;

  /// The model's own stable tool_use id — what a later "tool_result" event
  /// is matched against (same correlation the web client and the VS Code
  /// webview use), already carried by every tool_call announcement.
  final String toolCallId;

  /// Filled in once the matching "tool_result" arrives; null while the call
  /// is still running.
  final ToolResult? result;

  const ToolCallItem({
    required super.id,
    required this.toolCallId,
    required this.toolName,
    required this.description,
    required this.riskLevel,
    this.result,
  });

  ToolCallItem copyWith({ToolResult? result}) => ToolCallItem(
    id: id,
    toolCallId: toolCallId,
    toolName: toolName,
    description: description,
    riskLevel: riskLevel,
    result: result ?? this.result,
  );
}

class MediaItem extends TimelineItem {
  final String mediaKind; // "audio" | "image"
  final String path;
  final String mimeType;
  const MediaItem({
    required super.id,
    required this.mediaKind,
    required this.path,
    required this.mimeType,
  });
}

class Attachment {
  final String mimeType;
  final String base64;
  const Attachment({required this.mimeType, required this.base64});

  Map<String, dynamic> toJson() => {"mimeType": mimeType, "base64": base64};
}
