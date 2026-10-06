import 'package:flutter_test/flutter_test.dart';
import 'package:finanfa/core/sse.dart';

// The /api/ollama-models/pull endpoint streams SSE (the same three events
// the web client reads through its EventSource). SseParser is deliberately
// pure and DOM-free so the chunking edge cases real HTTP produces can be
// tested here instead of by hand against a live server.
void main() {
  test('buffers a line split across chunks, then emits the event', () {
    final parser = SseParser();

    expect(parser.add('event: progress\nda'), isEmpty);

    final events = parser.add('ta: {"completed":1,"total":4}\n\n');

    expect(events, [
      (event: 'progress', data: '{"completed":1,"total":4}'),
    ]);
  });

  test('emits several events from one chunk and handles CRLF line endings', () {
    final parser = SseParser();

    final events = parser.add(
      'event: progress\r\ndata: {"completed":1,"total":4}\r\n\r\n'
      'event: done\r\ndata: {}\r\n\r\n',
    );

    expect(events, [
      (event: 'progress', data: '{"completed":1,"total":4}'),
      (event: 'done', data: '{}'),
    ]);
  });

  test('ignores comment/keep-alive lines and keeps partial data buffered', () {
    final parser = SseParser();

    expect(parser.add(': keep-alive\n\n'), isEmpty);

    // No terminating blank line yet — the event must not fire early.
    expect(parser.add('event: error\ndata: "boom"'), isEmpty);
    expect(parser.add('\n\n'), [(event: 'error', data: '"boom"')]);
  });
}
