import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:finanfa/core/api/finanfa_api_client.dart';
import 'package:finanfa/core/server_connection.dart';

/// The media URL is built in one place so the inline-image widget and the
/// REST client can never disagree on it. No request is ever sent here — the
/// HTTP client is only a constructor placeholder.
class _NoopClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    throw UnimplementedError("no request expected in this unit test");
  }
}

void main() {
  final client = FinanfaApiClient(
    const ServerConnection(baseUrl: "http://192.168.1.10:4600/", token: "tok"),
    httpClient: _NoopClient(),
  );

  test("builds the same /api/workspace-file route the web client uses", () {
    final uri = client.workspaceFileUri("/tmp/shot.png", projectId: "p1");

    expect(uri.path, "/api/workspace-file");
    expect(uri.queryParameters, {"path": "/tmp/shot.png", "project": "p1"});
    // A trailing slash in the configured base URL must not double up.
    expect(uri.origin, "http://192.168.1.10:4600");
  });

  test("omits the project parameter when no project is active", () {
    final uri = client.workspaceFileUri("/tmp/shot.png");

    expect(uri.queryParameters, {"path": "/tmp/shot.png"});
  });

  test("carries the bearer token so an auth-enabled server accepts the fetch", () {
    expect(client.authHeaders["Authorization"], "Bearer tok");
  });
}
