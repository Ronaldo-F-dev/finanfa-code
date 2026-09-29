import 'package:flutter/foundation.dart';

import '../core/api/agent_socket.dart';
import '../core/models/session_models.dart';
import '../core/models/timeline_item.dart';
import '../core/server_connection.dart';

/// Dart port of App.tsx's own use of useAgentSocket — a ChangeNotifier
/// (rather than Riverpod's own AsyncNotifier machinery) since this is
/// fundamentally a live, long-running WebSocket subscription with many
/// independent pieces of state updating at different times, exactly the
/// shape ChangeNotifier + a single `notifyListeners()` per update fits;
/// wrap it in a ChangeNotifierProvider once a UI exists to consume it.
///
/// One instance can be reused across a whole app session — `open()` tears
/// down any previous AgentSocket first, same as useAgentSocket's own effect
/// re-running when its (model, sessionId, projectId) inputs change.
class AgentSessionController extends ChangeNotifier {
  AgentSocket? _socket;

  List<TimelineItem> timeline = const [];
  bool connected = false;
  BusyState busy = BusyState.idle;
  PermissionRequest? permissionRequest;
  StatusInfo? status;
  SessionInfo? sessionInfo;
  List<McpServerStatus> mcpServers = const [];
  bool mcpLoaded = false;
  List<ToolStatus> toolsStatus = const [];
  ModelUnavailable? modelUnavailable;
  List<TodoItem> todos = const [];

  /// A pending "⚠ ..." local-model warning to show as a dismissible popup —
  /// null once the user has acknowledged it. See AgentSocket.localModelWarning.
  String? localModelWarning;

  /// True once the current connection attempt has actually failed (as
  /// opposed to merely not having connected yet) — drives a persistent
  /// "can't reach the server" banner. See AgentSocket.connectionFailed.
  bool connectionFailed = false;

  /// Opens a real WebSocket connection — mirrors useAgentSocket's effect:
  /// call again with different arguments to reconnect for a new chat, a
  /// different session, or a different project, same as changing that
  /// hook's own dependency array would.
  Future<void> open({
    required ServerConnection connection,
    String? model,
    String? sessionId,
    String? projectId,
  }) async {
    await _socket?.dispose();
    timeline = const [];
    status = null;
    busy = BusyState.idle;
    permissionRequest = null;
    sessionInfo = null;
    mcpServers = const [];
    mcpLoaded = false;
    modelUnavailable = null;
    todos = const [];
    localModelWarning = null;
    connectionFailed = false;
    notifyListeners();

    final socket = AgentSocket(
      connection: connection,
      model: model,
      sessionId: sessionId,
      projectId: projectId,
    );
    _socket = socket;
    socket.timeline.listen((v) => _update(() => timeline = v));
    socket.connected.listen((v) => _update(() => connected = v));
    socket.busy.listen((v) => _update(() => busy = v));
    socket.permissionRequest.listen(
      (v) => _update(() => permissionRequest = v),
    );
    socket.status.listen((v) => _update(() => status = v));
    socket.sessionInfo.listen((v) => _update(() => sessionInfo = v));
    socket.mcpServers.listen(
      (v) => _update(() {
        mcpServers = v;
        mcpLoaded = true;
      }),
    );
    socket.toolsStatus.listen((v) => _update(() => toolsStatus = v));
    socket.modelUnavailable.listen((v) => _update(() => modelUnavailable = v));
    socket.todos.listen((v) => _update(() => todos = v));
    socket.localModelWarning.listen(
      (v) => _update(() => localModelWarning = v),
    );
    socket.connectionFailed.listen(
      (v) => _update(() => connectionFailed = v),
    );
    socket.connect();
  }

  /// Called once the user has tapped "I understand" in the warning popup.
  void dismissLocalModelWarning() => _update(() => localModelWarning = null);

  void _update(void Function() apply) {
    apply();
    notifyListeners();
  }

  void sendMessage(
    String text, {
    List<Attachment>? images,
    bool? deepResearch,
  }) => _socket?.sendMessage(text, images: images, deepResearch: deepResearch);
  void answerPermission(int requestId, String answer) =>
      _socket?.answerPermission(requestId, answer);
  void interrupt() => _socket?.interrupt();
  void switchModel(String model, String family, {String? baseUrl}) =>
      _socket?.switchModel(model, family, baseUrl: baseUrl);
  void mcpConnect(String name) => _socket?.mcpConnect(name);
  void mcpToggle(String name, bool enabled) =>
      _socket?.mcpToggle(name, enabled);
  void mcpReload() => _socket?.mcpReload();
  void setToolEnabled(String name, bool enabled) =>
      _socket?.setToolEnabled(name, enabled);
  void setEffort(String level) => _socket?.setEffort(level);
  void requestToolsStatus() => _socket?.requestToolsStatus();
  void compact() => _socket?.compact();
  void setPlanMode(bool enabled) => _socket?.setPlanMode(enabled);

  @override
  Future<void> dispose() async {
    await _socket?.dispose();
    super.dispose();
  }
}
