import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:finanfa/core/api/finanfa_api_client.dart';
import 'package:finanfa/core/models/timeline_item.dart';
import 'package:finanfa/core/server_connection.dart';
import 'package:finanfa/state/api_client_provider.dart';
import 'package:finanfa/widgets/timeline_tile.dart';

// A tool's image used to arrive as a plain "🖼️ /path" line. It now renders
// inline from the server's workspace-file route; these cover both states
// that still show a line: audio (no player dependency) and images whose
// fetch fails (or when no server connection exists at all).
class _NoopClient extends http.BaseClient {
  @override
  Future<http.StreamedResponse> send(http.BaseRequest request) {
    throw UnimplementedError("no request expected in this widget test");
  }
}

Widget _wrap(TimelineItem item, {required bool withConnection}) => ProviderScope(
  overrides: [
    if (withConnection)
      apiClientProvider.overrideWithValue(
        FinanfaApiClient(
          const ServerConnection(baseUrl: "http://127.0.0.1:1"),
          httpClient: _NoopClient(),
        ),
      )
    else
      apiClientProvider.overrideWithValue(null),
  ],
  child: MaterialApp(home: Scaffold(body: TimelineTile(item: item))),
);

const _image = MediaItem(
  id: "m1",
  mediaKind: "image",
  path: "/tmp/shot.png",
  mimeType: "image/png",
);

void main() {
  testWidgets("an image with a server connection renders inline, falling back to its path when it cannot load", (tester) async {
    await tester.pumpWidget(_wrap(_image, withConnection: true));
    await tester.pumpAndSettle();

    // The widget-test HTTP client refuses the request, so the real coverage
    // here is the fallback: the path line, not a red error box or a crash.
    expect(find.text("🖼️ /tmp/shot.png"), findsOneWidget);
  });

  testWidgets("an image without any connection keeps the plain path line", (tester) async {
    await tester.pumpWidget(_wrap(_image, withConnection: false));
    await tester.pumpAndSettle();

    expect(find.text("🖼️ /tmp/shot.png"), findsOneWidget);
  });

  testWidgets("audio keeps its line — playing it would need a new dependency", (tester) async {
    await tester.pumpWidget(
      _wrap(
        const MediaItem(
          id: "m2",
          mediaKind: "audio",
          path: "/tmp/voice.mp3",
          mimeType: "audio/mpeg",
        ),
        withConnection: true,
      ),
    );
    await tester.pumpAndSettle();

    expect(find.text("🎵 /tmp/voice.mp3"), findsOneWidget);
  });
}
