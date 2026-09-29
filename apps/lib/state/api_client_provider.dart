import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/finanfa_api_client.dart';
import 'server_connection_provider.dart';

/// null until a server connection is actually configured — every screen
/// that needs the API should read serverConnectionProvider itself first
/// (for its own loading/empty state) rather than only checking this for
/// null, same "connection is the source of truth" shape as the store above.
final apiClientProvider = Provider<FinanfaApiClient?>((ref) {
  final connection = ref.watch(serverConnectionProvider).valueOrNull;
  if (connection == null) return null;
  return FinanfaApiClient(connection);
});
