import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';

/// One shared FlutterTts instance for the whole app — real feature
/// request: read an agent reply aloud. Shared (not one per bubble) so
/// tapping "listen" on a second message stops whichever one was already
/// playing instead of both talking over each other.
final ttsProvider = Provider<FlutterTts>((ref) {
  final tts = FlutterTts();
  ref.onDispose(tts.stop);
  return tts;
});
