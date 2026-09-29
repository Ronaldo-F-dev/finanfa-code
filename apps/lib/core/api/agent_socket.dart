import 'dart:async';
import 'dart:convert';

import 'package:web_socket_channel/web_socket_channel.dart';

import '../models/session_models.dart';
import '../models/timeline_item.dart';
import '../server_connection.dart';

/// Dart port of packages/web-client/src/hooks/useAgentSocket.ts — same
/// wire protocol (one finanfa-code web-server, two real clients), reworked
/// from a React hook into a plain, testable class exposing Streams instead
/// of hook state. No UI dependency at all (this is `lib/core`, not a
/// widget) — a screen wires these streams into whatever the eventual
/// design turns out to be.
///
/// One instance = one WebSocket connection = one chat session (brand-new,
/// or resuming `sessionId`), exactly like one useAgentSocket call. Create
/// a new instance (after disposing the old one) to switch model/session/
/// project, same "reconnect on changed inputs" behavior the hook's own
/// effect dependency array gave it.
class AgentSocket {
  final ServerConnection connection;
  final String? model;
  final String? sessionId;
  final String? projectId;

  WebSocketChannel? _channel;
  StreamSubscription? _sub;
  int _nextLocalId = 1;
  String? _streamingAssistantId;

  final _timelineController = StreamController<List<TimelineItem>>.broadcast();
  final _connectedController = StreamController<bool>.broadcast();
  final _busyController = StreamController<BusyState>.broadcast();
  final _permissionController =
      StreamController<PermissionRequest?>.broadcast();
  final _statusController = StreamController<StatusInfo?>.broadcast();
  final _sessionInfoController = StreamController<SessionInfo?>.broadcast();
  final _mcpServersController =
      StreamController<List<McpServerStatus>>.broadcast();
  final _toolsStatusController = StreamController<List<ToolStatus>>.broadcast();
  final _modelUnavailableController =
      StreamController<ModelUnavailable?>.broadcast();
  final _todosController = StreamController<List<TodoItem>>.broadcast();
  final _localModelWarningController = StreamController<String?>.broadcast();
  final _connectionFailedController = StreamController<bool>.broadcast();

  final List<TimelineItem> _timeline = [];
  bool _connected = false;

  Stream<List<TimelineItem>> get timeline => _timelineController.stream;
  Stream<bool> get connected => _connectedController.stream;
  Stream<BusyState> get busy => _busyController.stream;
  Stream<PermissionRequest?> get permissionRequest =>
      _permissionController.stream;
  Stream<StatusInfo?> get status => _statusController.stream;
  Stream<SessionInfo?> get sessionInfo => _sessionInfoController.stream;
  Stream<List<McpServerStatus>> get mcpServers => _mcpServersController.stream;
  Stream<List<ToolStatus>> get toolsStatus => _toolsStatusController.stream;
  Stream<ModelUnavailable?> get modelUnavailable =>
      _modelUnavailableController.stream;
  Stream<List<TodoItem>> get todos => _todosController.stream;

  /// A "⚠ ..." system message (the local-model context/crash-risk warning
  /// the server sends once per connection — see index.ts's set_model/
  /// set_effort handlers) — real, reported request: surface this as a
  /// dismissible popup instead of a permanent line in the chat transcript,
  /// since every model/provider capability is already knowable server-side.
  Stream<String?> get localModelWarning => _localModelWarningController.stream;

  /// Real, reported bug: a WebSocket connection that fails to establish (or
  /// drops mid-session, e.g. the server's LAN IP changed and the configured
  /// baseUrl is now unreachable) left `connected` false with nothing else
  /// distinguishing "still connecting" from "genuinely can't reach the
  /// server" — the UI looked normal (a small muted dot) instead of telling
  /// the user to go check Settings. `true` once a real connect attempt has
  /// failed (onError/onDone/`channel.ready` rejecting); reset to `false`
  /// right as a fresh `connect()` attempt starts.
  Stream<bool> get connectionFailed => _connectionFailedController.stream;

  bool get isConnected => _connected;

  AgentSocket({
    required this.connection,
    this.model,
    this.sessionId,
    this.projectId,
  });

  String _id() => (_nextLocalId++).toString();

  void connect() {
    if (!_connectionFailedController.isClosed) {
      _connectionFailedController.add(false);
    }
    final query = <String, String>{
      'model': ?model,
      'session': ?sessionId,
      'project': ?projectId,
      'token': ?connection.token,
    };
    final uri = Uri.parse('${connection.webSocketUrl}/ws')
        .replace(queryParameters: query.isEmpty ? null : query);
    final channel = WebSocketChannel.connect(uri);
    _channel = channel;
    _sub = channel.stream.listen(
      _handleMessage,
      onDone: () => _fail(),
      onError: (_) => _fail(),
      cancelOnError: false,
    );
    // web_socket_channel's ready future resolves once the handshake
    // actually completes — matches ws.onopen, not just "connect() was called".
    channel.ready.then((_) => _setConnected(true)).catchError((_) => _fail());
  }

  void _fail() {
    _setConnected(false);
    if (!_connectionFailedController.isClosed) {
      _connectionFailedController.add(true);
    }
  }

  void _setConnected(bool value) {
    _connected = value;
    if (!_connectedController.isClosed) _connectedController.add(value);
  }

  void _pushTimeline() {
    if (!_timelineController.isClosed) {
      _timelineController.add(List.unmodifiable(_timeline));
    }
  }

  void _handleMessage(dynamic raw) {
    final msg = jsonDecode(raw as String) as Map<String, dynamic>;
    switch (msg['type']) {
      case 'assistant_delta':
        final text = msg['text'] as String;
        if (_streamingAssistantId == null) {
          final id = _id();
          _streamingAssistantId = id;
          _timeline.add(
            AssistantMessageItem(id: id, text: text, streaming: true),
          );
        } else {
          final idx = _timeline.indexWhere(
            (it) =>
                it is AssistantMessageItem && it.id == _streamingAssistantId,
          );
          if (idx != -1) {
            final current = _timeline[idx] as AssistantMessageItem;
            _timeline[idx] = current.copyWith(text: current.text + text);
          }
        }
        _pushTimeline();
        break;
      case 'assistant_end':
        final id = _streamingAssistantId;
        _streamingAssistantId = null;
        if (id != null) {
          final idx = _timeline.indexWhere(
            (it) => it is AssistantMessageItem && it.id == id,
          );
          if (idx != -1) {
            _timeline[idx] = (_timeline[idx] as AssistantMessageItem).copyWith(
              streaming: false,
            );
          }

          _pushTimeline();
        }
        break;
      case 'system':
        final text = msg['text'] as String;
        if (text.startsWith('⚠')) {
          _localModelWarningController.add(text);
        } else {
          _timeline.add(
            LogItem(id: _id(), variant: LogVariant.system, text: text),
          );
          _pushTimeline();
        }
        break;
      case 'error':
        _timeline.add(
          LogItem(
            id: _id(),
            variant: LogVariant.error,
            text: msg['text'] as String,
          ),
        );
        _pushTimeline();
        break;
      case 'tool_call':
        _timeline.add(
          ToolCallItem(
            id: _id(),
            toolName: msg['toolName'] as String,
            description: msg['description'] as String,
            riskLevel: toolRiskLevelFromString(msg['riskLevel'] as String),
          ),
        );
        _pushTimeline();
        break;
      case 'media':
        _timeline.add(
          MediaItem(
            id: _id(),
            mediaKind: msg['kind'] as String,
            path: msg['path'] as String,
            mimeType: msg['mimeType'] as String,
          ),
        );
        _pushTimeline();
        break;
      case 'todos':
        _todosController.add(
          (msg['todos'] as List)
              .map((t) => TodoItem.fromJson(t as Map<String, dynamic>))
              .toList(),
        );
        break;
      case 'busy':
        _busyController.add(
          BusyState(
            active: msg['busy'] as bool,
            label: msg['label'] as String?,
          ),
        );
        break;
      case 'status':
        _statusController.add(
          StatusInfo.fromJson(msg['status'] as Map<String, dynamic>),
        );
        break;
      case 'ask':
        _permissionController.add(
          PermissionRequest(
            requestId: msg['requestId'] as int,
            prompt: msg['prompt'] as String,
          ),
        );
        break;
      case 'session_info':
        _sessionInfoController.add(SessionInfo.fromJson(msg));
        break;
      case 'mcp_status':
        _mcpServersController.add(
          (msg['servers'] as List)
              .map((s) => McpServerStatus.fromJson(s as Map<String, dynamic>))
              .toList(),
        );
        break;
      case 'tools_status':
        _toolsStatusController.add(
          (msg['tools'] as List)
              .map((t) => ToolStatus.fromJson(t as Map<String, dynamic>))
              .toList(),
        );
        break;
      case 'model_unavailable':
        _modelUnavailableController.add(
          ModelUnavailable(
            model: msg['model'] as String,
            family: msg['family'] as String,
            message: msg['message'] as String,
          ),
        );
        break;
      case 'history':
        final messages = msg['messages'] as List;
        final items = messages.map<TimelineItem>((raw) {
          final m = raw as Map<String, dynamic>;
          final role = m['role'] as String;
          final id = _id();
          if (role == 'error')
            return LogItem(
              id: id,
              variant: LogVariant.error,
              text: m['content'] as String,
            );
          if (role == 'assistant')
            return AssistantMessageItem(
              id: id,
              text: m['content'] as String,
              streaming: false,
            );
          return UserMessageItem(id: id, text: m['content'] as String);
        }).toList();
        if (msg['replace'] == true) {
          _timeline
            ..clear()
            ..addAll(items);
        } else {
          _timeline.insertAll(0, items);
        }
        _pushTimeline();
        break;
      default:
        break;
    }
  }

  void _send(Map<String, dynamic> payload) {
    final channel = _channel;
    if (channel == null || !_connected) return;
    channel.sink.add(jsonEncode(payload));
  }

  void sendMessage(
    String text, {
    List<Attachment>? images,
    bool? deepResearch,
  }) {
    _timeline.add(UserMessageItem(id: _id(), text: text, images: images));
    _pushTimeline();
    _send({
      'type': 'user_message',
      'text': text,
      'images': ?images?.map((i) => i.toJson()).toList(),
      'deepResearch': ?deepResearch,
    });
  }

  void answerPermission(int requestId, String answer) {
    _send({
      'type': 'permission_response',
      'requestId': requestId,
      'answer': answer,
    });
    _permissionController.add(null);
  }

  void interrupt() => _send({'type': 'interrupt'});
  void switchModel(String newModel, String family, {String? baseUrl}) => _send({
    'type': 'set_model',
    'model': newModel,
    'family': family,
    'baseUrl': ?baseUrl,
  });
  void mcpConnect(String name) => _send({'type': 'mcp_connect', 'name': name});
  void mcpToggle(String name, bool enabled) =>
      _send({'type': enabled ? 'mcp_enable' : 'mcp_disable', 'name': name});
  void mcpReload() => _send({'type': 'mcp_reload'});
  void setToolEnabled(String name, bool enabled) =>
      _send({'type': 'set_tool_enabled', 'name': name, 'enabled': enabled});
  void setEffort(String level) => _send({'type': 'set_effort', 'level': level});
  void requestToolsStatus() => _send({'type': 'tools_status'});
  void compact() => _send({'type': 'compact'});
  void setPlanMode(bool enabled) =>
      _send({'type': 'set_plan_mode', 'enabled': enabled});

  Future<void> dispose() async {
    await _sub?.cancel();
    await _channel?.sink.close();
    for (final c in [
      _timelineController,
      _connectedController,
      _busyController,
      _permissionController,
      _statusController,
      _sessionInfoController,
      _mcpServersController,
      _toolsStatusController,
      _modelUnavailableController,
      _todosController,
      _localModelWarningController,
      _connectionFailedController,
    ]) {
      await c.close();
    }
  }
}
