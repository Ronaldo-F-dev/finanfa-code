import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'agent_session_controller.dart';

/// One shared AgentSessionController for the whole app — call `.open(...)`
/// on it (via ref.read) whenever a screen wants to start/switch chats;
/// widgets that only need to render its state should use
/// ChangeNotifierProvider's own listenable rebuild via
/// `ref.watch(agentSessionProvider)`.
final agentSessionProvider = ChangeNotifierProvider<AgentSessionController>((
  ref,
) {
  final controller = AgentSessionController();
  ref.onDispose(controller.dispose);
  return controller;
});
