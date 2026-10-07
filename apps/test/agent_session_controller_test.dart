import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/server_connection.dart';
import 'package:finanfa/state/agent_session_controller.dart';

// open() rebuilds every piece of per-session state before wiring the new
// socket; the previous connection's `connected` used to survive that reset,
// so a session switch whose new connection then failed still showed the
// composer as usable (a stale `true` from the session just left).
void main() {
  test('opening a new session clears the previous connected state', () async {
    final controller = AgentSessionController();
    controller.connected = true; // as if the previous session had connected

    await controller.open(
      connection: const ServerConnection(baseUrl: 'http://127.0.0.1:1'),
    );

    expect(controller.connected, isFalse);
    // Deliberately not disposed: AgentSocket.dispose() awaits the WebSocket
    // channel's sink close, which never resolves against flutter_test's
    // faked network. The controller and its socket are simply dropped.
  });
}
