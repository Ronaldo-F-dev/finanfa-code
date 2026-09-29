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

class ToolCallItem extends TimelineItem {
  final String toolName;
  final String description;
  final ToolRiskLevel riskLevel;
  const ToolCallItem({
    required super.id,
    required this.toolName,
    required this.description,
    required this.riskLevel,
  });
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
