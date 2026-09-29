import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// What this app needs to reach a finanfa-code web-server instance: its
/// base URL (typically a FINANFA_TUNNEL public URL, or a LAN address for a
/// server running on the same network) and, only when that server has
/// gateway auth enabled (FINANFA_WEB_ACCOUNTS/FINANFA_WEB_USERS/OIDC — see
/// packages/web-server/src/auth.ts), a bearer token from POST /api/auth/login.
/// A server with no gateway auth configured works with `token: null`.
class ServerConnection {
  final String baseUrl;
  final String? token;
  const ServerConnection({required this.baseUrl, this.token});

  /// baseUrl with any trailing slash removed, so callers can always do
  /// "${normalizedBaseUrl}/api/..." without ever risking a doubled slash.
  String get normalizedBaseUrl => baseUrl.endsWith('/')
      ? baseUrl.substring(0, baseUrl.length - 1)
      : baseUrl;

  String get webSocketUrl =>
      normalizedBaseUrl.replaceFirst(RegExp(r'^http'), 'ws');

  ServerConnection copyWith({String? baseUrl, String? token}) =>
      ServerConnection(
        baseUrl: baseUrl ?? this.baseUrl,
        token: token ?? this.token,
      );
}

/// Persists the server connection in the platform keychain/keystore (not
/// SharedPreferences) since it can carry a real bearer token — same trust
/// level finanfa-code's own core/config.ts gives an on-disk API key
/// (owner-only file permissions there; a secure-storage-backed keychain
/// entry here, since a mobile app has no equivalent of chmod 600).
class ServerConnectionStore {
  static const _baseUrlKey = 'finanfa.server.baseUrl';
  static const _tokenKey = 'finanfa.server.token';

  final FlutterSecureStorage _storage;
  ServerConnectionStore({FlutterSecureStorage? storage})
    : _storage =
          storage ??
          const FlutterSecureStorage(
            // The default "data protection keychain" requires a
            // keychain-access-groups entitlement signed with a real Apple
            // development certificate — this fails outright
            // (PlatformException -34018, "a required entitlement isn't
            // present") on a Mac set to "Sign to Run Locally" (no dev
            // team), which is the default for local development before
            // enrolling in the Apple Developer Program. The legacy
            // (non-data-protection) Keychain this falls back to needs no
            // such entitlement and works the same either way.
            mOptions: MacOsOptions(usesDataProtectionKeychain: false),
          );

  Future<ServerConnection?> load() async {
    final baseUrl = await _storage.read(key: _baseUrlKey);
    if (baseUrl == null || baseUrl.isEmpty) return null;
    final token = await _storage.read(key: _tokenKey);
    return ServerConnection(baseUrl: baseUrl, token: token);
  }

  Future<void> save(ServerConnection connection) async {
    await _storage.write(key: _baseUrlKey, value: connection.baseUrl);
    if (connection.token != null) {
      await _storage.write(key: _tokenKey, value: connection.token);
    } else {
      await _storage.delete(key: _tokenKey);
    }
  }

  Future<void> clear() async {
    await _storage.delete(key: _baseUrlKey);
    await _storage.delete(key: _tokenKey);
  }
}
