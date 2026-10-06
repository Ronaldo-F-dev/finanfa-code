/// Parses a Server-Sent Events text stream into (event, data) pairs.
///
/// `/api/ollama-models/pull` is the only server route this app talks to that
/// streams instead of answering once. The browser's EventSource parses this
/// format for the web client's identical call; this is the app-side
/// equivalent. Chunks can split anywhere — a JSON payload may arrive across
/// two reads — so an incomplete trailing line is buffered until the newline
/// that finishes it, and an event is only emitted on the blank line that
/// terminates it, same as the spec.
class SseParser {
  final _buffer = StringBuffer();
  String _event = '';
  final _data = StringBuffer();

  List<({String event, String data})> add(String chunk) {
    final events = <({String event, String data})>[];
    _buffer.write(chunk);
    var text = _buffer.toString();
    while (true) {
      final newline = text.indexOf('\n');
      if (newline == -1) break;
      var line = text.substring(0, newline);
      text = text.substring(newline + 1);
      if (line.endsWith('\r')) line = line.substring(0, line.length - 1);
      if (line.isEmpty) {
        if (_data.isNotEmpty) {
          events.add((
            event: _event.isEmpty ? 'message' : _event,
            data: _data.toString(),
          ));
        }
        _event = '';
        _data.clear();
        continue;
      }
      if (line.startsWith(':')) continue; // comment / keep-alive
      if (line.startsWith('event:')) {
        _event = line.substring(6).trim();
      } else if (line.startsWith('data:')) {
        if (_data.isNotEmpty) _data.write('\n');
        _data.write(line.substring(5).trimLeft());
      }
    }
    _buffer
      ..clear()
      ..write(text);
    return events;
  }
}
