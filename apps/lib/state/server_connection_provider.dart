import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/server_connection.dart';

/// Whatever's actually persisted right now, loaded once at app start —
/// null means "no server configured yet", the signal a connection/setup
/// screen uses to know it should ask for one instead of trying to reach
/// anything. Updated by connectToServer/forgetServer below, which write
/// back through the same ServerConnectionStore this reads from, keeping
/// runtime state and the keychain in sync.
final serverConnectionStoreProvider = Provider(
  (ref) => ServerConnectionStore(),
);

final serverConnectionProvider =
    AsyncNotifierProvider<ServerConnectionNotifier, ServerConnection?>(
      ServerConnectionNotifier.new,
    );

class ServerConnectionNotifier extends AsyncNotifier<ServerConnection?> {
  @override
  Future<ServerConnection?> build() =>
      ref.read(serverConnectionStoreProvider).load();

  Future<void> setConnection(ServerConnection connection) async {
    await ref.read(serverConnectionStoreProvider).save(connection);
    state = AsyncData(connection);
  }

  Future<void> forget() async {
    await ref.read(serverConnectionStoreProvider).clear();
    state = const AsyncData(null);
  }
}
