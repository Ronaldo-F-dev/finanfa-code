/// Mirrors the plain-object shapes useAgentSocket.ts/App.tsx read directly
/// off WebSocket/REST JSON — kept as thin, nullable-tolerant models rather
/// than anything fancier, since the wire format is this project's own
/// server, not a third-party API that needs defensive parsing.
library;

class BusyState {
  final bool active;
  final String? label;
  const BusyState({required this.active, this.label});
  static const idle = BusyState(active: false);
}

class PermissionRequest {
  final int requestId;
  final String prompt;
  const PermissionRequest({required this.requestId, required this.prompt});
}

class StatusInfo {
  final int tokens;
  final double costUsd;
  final String model;
  final bool? planMode;
  const StatusInfo({
    required this.tokens,
    required this.costUsd,
    required this.model,
    this.planMode,
  });

  factory StatusInfo.fromJson(Map<String, dynamic> json) => StatusInfo(
    tokens: (json["tokens"] as num).toInt(),
    costUsd: (json["costUsd"] as num).toDouble(),
    model: json["model"] as String,
    planMode: json["planMode"] as bool?,
  );
}

class SessionInfo {
  final String id;
  final String? title;
  final String model;
  final String providerKind;
  final int toolCount;
  final String? effort;
  const SessionInfo({
    required this.id,
    this.title,
    required this.model,
    required this.providerKind,
    required this.toolCount,
    this.effort,
  });

  factory SessionInfo.fromJson(Map<String, dynamic> json) => SessionInfo(
    id: json["id"] as String,
    title: json["title"] as String?,
    model: json["model"] as String,
    providerKind: json["providerKind"] as String,
    toolCount: (json["toolCount"] as num).toInt(),
    effort: json["effort"] as String?,
  );
}

class EffortNeedsDownload {
  final String level;
  final String ollamaModel;
  const EffortNeedsDownload({required this.level, required this.ollamaModel});
}

class ToolStatus {
  final String name;
  final String riskLevel;
  final bool enabled;
  const ToolStatus({
    required this.name,
    required this.riskLevel,
    required this.enabled,
  });

  factory ToolStatus.fromJson(Map<String, dynamic> json) => ToolStatus(
    name: json["name"] as String,
    riskLevel: json["riskLevel"] as String,
    enabled: json["enabled"] as bool,
  );
}

class McpServerStatus {
  final String name;
  final String transport;
  final bool connected;
  final bool disabled;
  final bool needsAuth;
  final bool inProject;
  const McpServerStatus({
    required this.name,
    required this.transport,
    required this.connected,
    required this.disabled,
    required this.needsAuth,
    required this.inProject,
  });

  factory McpServerStatus.fromJson(Map<String, dynamic> json) =>
      McpServerStatus(
        name: json["name"] as String,
        transport: json["transport"] as String,
        connected: json["connected"] as bool,
        disabled: json["disabled"] as bool,
        needsAuth: json["needsAuth"] as bool,
        inProject: json["inProject"] as bool,
      );
}

class ModelUnavailable {
  final String model;
  final String family;
  final String message;
  const ModelUnavailable({
    required this.model,
    required this.family,
    required this.message,
  });
}

enum TodoStatus { pending, inProgress, completed }

TodoStatus todoStatusFromString(String raw) => switch (raw) {
  "in_progress" => TodoStatus.inProgress,
  "completed" => TodoStatus.completed,
  _ => TodoStatus.pending,
};

class TodoItem {
  final String content;
  final TodoStatus status;
  const TodoItem({required this.content, required this.status});

  factory TodoItem.fromJson(Map<String, dynamic> json) => TodoItem(
    content: json["content"] as String,
    status: todoStatusFromString(json["status"] as String),
  );
}

class ModelOption {
  final String id;
  final String label;
  final String family;
  final String? baseUrl;
  final String? localModelId;
  // A model configured in config.localServices — `running: false` means
  // it isn't started yet and will auto-start on selection (see
  // local-model-manager's generic supervisor); the picker uses this pair
  // to show a "starting" pill instead of implying it's already live.
  final bool local;
  final bool running;
  const ModelOption({
    required this.id,
    required this.label,
    required this.family,
    this.baseUrl,
    this.localModelId,
    this.local = false,
    this.running = false,
  });

  factory ModelOption.fromJson(Map<String, dynamic> json) => ModelOption(
    id: json["id"] as String,
    label: (json["label"] as String?) ?? (json["id"] as String),
    family: (json["family"] as String?) ?? "openai-compatible",
    baseUrl: json["baseUrl"] as String?,
    localModelId: json["localModelId"] as String?,
    local: json["local"] as bool? ?? false,
    running: json["running"] as bool? ?? false,
  );
}

class SessionListItem {
  final String id;
  final String? title;
  final String mtime;
  const SessionListItem({required this.id, this.title, required this.mtime});

  factory SessionListItem.fromJson(Map<String, dynamic> json) =>
      SessionListItem(
        id: json["id"] as String,
        title: json["title"] as String?,
        mtime: json["mtime"] as String,
      );
}

class EffortTierOption {
  final String id;
  final String label;
  final String model;
  final bool installed;
  const EffortTierOption({
    required this.id,
    required this.label,
    required this.model,
    required this.installed,
  });

  factory EffortTierOption.fromJson(Map<String, dynamic> json) =>
      EffortTierOption(
        id: json["id"] as String,
        label: json["label"] as String,
        model: json["model"] as String,
        installed: json["installed"] as bool? ?? true,
      );
}

class ChannelField {
  final String key;
  final String label;
  final bool secret;
  final String? placeholder;
  final bool configured;
  final bool envOverride;
  const ChannelField({
    required this.key,
    required this.label,
    required this.secret,
    this.placeholder,
    required this.configured,
    required this.envOverride,
  });

  factory ChannelField.fromJson(Map<String, dynamic> json) => ChannelField(
    key: json['key'] as String,
    label: json['label'] as String,
    secret: json['secret'] as bool? ?? false,
    placeholder: json['placeholder'] as String?,
    configured: json['configured'] as bool? ?? false,
    envOverride: json['envOverride'] as bool? ?? false,
  );
}

class ChannelWebhookPath {
  final String label;
  final String url;
  const ChannelWebhookPath({required this.label, required this.url});

  factory ChannelWebhookPath.fromJson(Map<String, dynamic> json) =>
      ChannelWebhookPath(label: json['label'] as String, url: json['url'] as String);
}

class ChannelStatus {
  final String id;
  final String name;
  final String setupNote;
  final List<ChannelWebhookPath>? webhookPaths;
  final List<ChannelField> fields;
  final bool configured;
  const ChannelStatus({
    required this.id,
    required this.name,
    required this.setupNote,
    this.webhookPaths,
    required this.fields,
    required this.configured,
  });

  factory ChannelStatus.fromJson(Map<String, dynamic> json) => ChannelStatus(
    id: json['id'] as String,
    name: json['name'] as String,
    setupNote: json['setupNote'] as String,
    webhookPaths: (json['webhookPaths'] as List?)
        ?.map((w) => ChannelWebhookPath.fromJson(w as Map<String, dynamic>))
        .toList(),
    fields: (json['fields'] as List)
        .map((f) => ChannelField.fromJson(f as Map<String, dynamic>))
        .toList(),
    configured: json['configured'] as bool? ?? false,
  );
}

class OllamaModelInfo {
  final String name;
  final int size;
  final String? parameterSize;
  final String? family;
  final bool? supportsTools;
  const OllamaModelInfo({
    required this.name,
    required this.size,
    this.parameterSize,
    this.family,
    this.supportsTools,
  });

  factory OllamaModelInfo.fromJson(Map<String, dynamic> json) => OllamaModelInfo(
    name: json['name'] as String,
    size: (json['size'] as num?)?.toInt() ?? 0,
    parameterSize: json['parameterSize'] as String?,
    family: json['family'] as String?,
    supportsTools: json['supportsTools'] as bool?,
  );
}

class ProjectItem {
  final String id;
  final String name;
  final String createdAt;
  final int fileCount;
  const ProjectItem({
    required this.id,
    required this.name,
    required this.createdAt,
    required this.fileCount,
  });

  factory ProjectItem.fromJson(Map<String, dynamic> json) => ProjectItem(
    id: json["id"] as String,
    name: json["name"] as String,
    createdAt: json["createdAt"] as String,
    fileCount: (json["fileCount"] as num).toInt(),
  );
}

/// One server-sent event from `/api/ollama-models/pull` — mirrors the three
/// events the web client consumes through its EventSource for the same URL.
sealed class OllamaPullEvent {
  const OllamaPullEvent();
}

class OllamaPullProgress extends OllamaPullEvent {
  final int? completed;
  final int? total;
  const OllamaPullProgress({this.completed, this.total});

  /// 0-100, or null while the server hasn't reported a total yet.
  int? get percent {
    final t = total;
    if (t == null || t <= 0) return null;
    return (((completed ?? 0) / t) * 100).round();
  }
}

class OllamaPullDone extends OllamaPullEvent {
  const OllamaPullDone();
}

class OllamaPullError extends OllamaPullEvent {
  final String message;
  const OllamaPullError(this.message);
}
