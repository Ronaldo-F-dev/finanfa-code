import 'dart:convert';

import 'package:http/http.dart' as http;

import '../models/session_models.dart';
import '../server_connection.dart';
import '../sse.dart';

/// Thrown for any non-2xx REST response — carries the server's own `error`
/// message (every finanfa-code route reports failures as `{ error: "..." }`,
/// see packages/web-server/src/index.ts) instead of a generic HTTP status.
class FinanfaApiException implements Exception {
  final int statusCode;
  final String message;
  FinanfaApiException(this.statusCode, this.message);
  @override
  String toString() => 'FinanfaApiException($statusCode): $message';
}

/// A thin REST client for finanfa-code's web-server — mirrors exactly the
/// endpoints packages/web-client/src/App.tsx and its components call
/// directly via `fetch`, so this native client and the browser one stay two
/// consumers of one real API rather than this app growing its own.
class FinanfaApiClient {
  final ServerConnection connection;
  final http.Client _http;
  FinanfaApiClient(this.connection, {http.Client? httpClient})
    : _http = httpClient ?? http.Client();

  Map<String, String> get _headers => {
    'Content-Type': 'application/json',
    if (connection.token != null) 'Authorization': 'Bearer ${connection.token}',
  };

  Uri _uri(String path, [Map<String, String>? query]) =>
      Uri.parse('${connection.normalizedBaseUrl}$path')
          .replace(queryParameters: query?.isEmpty == true ? null : query);

  Future<T> _get<T>(
    String path,
    T Function(dynamic json) parse, {
    Map<String, String>? query,
  }) async {
    final res = await _http.get(_uri(path, query), headers: _headers);
    return parse(_decode(res));
  }

  Future<T> _post<T>(
    String path,
    Map<String, dynamic> body,
    T Function(dynamic json) parse,
  ) async {
    final res = await _http.post(
      _uri(path),
      headers: _headers,
      body: jsonEncode(body),
    );
    return parse(_decode(res));
  }

  dynamic _decode(http.Response res) {
    final body = res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body);
    if (res.statusCode >= 200 && res.statusCode < 300) return body;
    final message = (body is Map && body['error'] is String)
        ? body['error'] as String
        : 'HTTP ${res.statusCode}';
    throw FinanfaApiException(res.statusCode, message);
  }

  /// Real, actionable failure message instead of a generic connection
  /// error — checked before anything else, since every other call here is
  /// meaningless if the server can't be reached at all (wrong URL, no
  /// internet, tunnel not running).
  Future<bool> ping() async {
    try {
      final res = await _http
          .get(_uri('/api/tunnel-url'), headers: _headers)
          .timeout(const Duration(seconds: 8));
      return res.statusCode < 500;
    } catch (_) {
      return false;
    }
  }

  Future<({List<ModelOption> models, String defaultModel})> fetchModels({
    String? projectId,
  }) => _get(
    '/api/models',
    (json) => (
      models: (json['models'] as List)
          .map((m) => ModelOption.fromJson(m as Map<String, dynamic>))
          .toList(),
      defaultModel: json['defaultModel'] as String,
    ),
    query: projectId != null ? {'project': projectId} : null,
  );

  Future<List<ProjectItem>> fetchProjects() => _get(
    '/api/projects',
    (json) => (json['projects'] as List)
        .map((p) => ProjectItem.fromJson(p as Map<String, dynamic>))
        .toList(),
  );

  Future<ProjectItem> createProject(String name) => _post('/api/projects', {
    'name': name,
  }, (json) => ProjectItem.fromJson(json['project'] as Map<String, dynamic>));

  Future<List<SessionListItem>> fetchSessions({String? projectId}) => _get(
    '/api/sessions',
    (json) => (json['sessions'] as List)
        .map((s) => SessionListItem.fromJson(s as Map<String, dynamic>))
        .toList(),
    query: projectId != null ? {'project': projectId} : null,
  );

  Future<void> deleteSession(String id, {String? projectId}) async {
    final res = await _http.delete(
      _uri(
        '/api/sessions/$id',
        projectId != null ? {'project': projectId} : null,
      ),
      headers: _headers,
    );
    _decode(res);
  }

  Future<String?> fetchTunnelUrl() =>
      _get('/api/tunnel-url', (json) => json['url'] as String?);

  /// Uploads a non-image file so the model can reach it through its own
  /// read_file/read_document tools by path — mirrors App.tsx's handleFiles
  /// for anything that isn't inline-sendable image bytes.
  Future<String> uploadFile(
    String filename,
    String dataBase64, {
    String? projectId,
  }) => _post('/api/upload', {
    'filename': filename,
    'dataBase64': dataBase64,
    'project': ?projectId,
  }, (json) => json['path'] as String);

  /// Real login against a gateway-enabled server (see auth.ts) — returns
  /// the bearer token to persist via ServerConnectionStore. Throws
  /// FinanfaApiException(401, ...) for a wrong username/password, same as
  /// the server itself reports it.
  Future<String> login(String username, String password) => _post(
    '/api/auth/login',
    {'username': username, 'password': password},
    (json) => json['token'] as String,
  );

  /// Real, masked config values (secrets come back as e.g. "sk-a****xyz",
  /// never the plain value — same masking the web UI's own SettingsModal
  /// relies on) plus the saved multi-key pool, also masked.
  Future<({Map<String, String?> config, List<String> apiKeys})> fetchConfig({
    String? projectId,
  }) => _get(
    '/api/config',
    (json) => (
      config: (json['config'] as Map<String, dynamic>).map(
        (k, v) => MapEntry(k, v as String?),
      ),
      apiKeys: (json['apiKeys'] as List?)?.cast<String>() ?? const [],
    ),
    query: projectId != null ? {'project': projectId} : null,
  );

  /// Saves a partial config — an empty string clears that field, a missing
  /// key leaves it untouched, same convention as /config set. Real secret
  /// values only ever go out over the wire here, never come back in.
  Future<String?> saveConfig(Map<String, dynamic> partial) =>
      _post('/api/config', partial, (json) => json['note'] as String?);

  Future<void> deleteProject(String id) async {
    final res = await _http.delete(
      _uri('/api/projects/$id'),
      headers: _headers,
    );
    _decode(res);
  }

  Future<List<ChannelStatus>> fetchChannelsConfig() => _get(
    '/api/channels-config',
    (json) => (json['channels'] as List)
        .map((c) => ChannelStatus.fromJson(c as Map<String, dynamic>))
        .toList(),
  );

  Future<void> saveChannelConfig(String id, Map<String, String> fields) async {
    final res = await _http.post(
      _uri('/api/channels-config/$id'),
      headers: _headers,
      body: jsonEncode(fields),
    );
    _decode(res);
  }

  /// Registers Discord's /ask slash command using the already-saved
  /// Application ID/Bot Token — the real one-click alternative to the curl
  /// command docs/channels.md documents. Throws FinanfaApiException (same
  /// as every other call here) if the server reports a failure — e.g. no
  /// Application ID/Bot Token saved yet, or a real Discord API error.
  Future<void> registerDiscordCommand() async {
    final res = await _http.post(
      _uri('/api/channels-config/discord/register-command'),
      headers: _headers,
    );
    _decode(res);
  }

  Future<bool> fetchOllamaStatus() =>
      _get('/api/ollama-models/status', (json) => json['available'] as bool);

  Future<List<OllamaModelInfo>> fetchOllamaModels() => _get(
    '/api/ollama-models/installed',
    (json) => (json['models'] as List)
        .map((m) => OllamaModelInfo.fromJson(m as Map<String, dynamic>))
        .toList(),
  );

  /// Streams `/api/ollama-models/pull`'s server-sent events — the one route
  /// here that isn't plain request/response. The stream ends when the server
  /// closes its response, so a caller can keep a progress UI alive for the
  /// whole download; a server-side failure arrives as an [OllamaPullError]
  /// value (the request itself succeeded), not a thrown exception.
  Stream<OllamaPullEvent> pullModel(String name) async* {
    final request = http.Request(
      'GET',
      _uri('/api/ollama-models/pull', {'name': name}),
    );
    request.headers.addAll(_headers);
    final response = await _http.send(request);
    if (response.statusCode != 200) {
      throw FinanfaApiException(
        response.statusCode,
        'HTTP ${response.statusCode}',
      );
    }
    final parser = SseParser();
    await for (final chunk in response.stream.transform(utf8.decoder)) {
      for (final event in parser.add(chunk)) {
        switch (event.event) {
          case 'progress':
            final json = jsonDecode(event.data) as Map<String, dynamic>;
            yield OllamaPullProgress(
              completed: (json['completed'] as num?)?.toInt(),
              total: (json['total'] as num?)?.toInt(),
            );
          case 'done':
            yield const OllamaPullDone();
          case 'error':
            yield OllamaPullError(jsonDecode(event.data) as String);
        }
      }
    }
  }
}
