/// finanfa never shows the long dash: the agent is told not to write it, and
/// what still slips through is rewritten here before it is displayed. Code
/// (fenced or inline) is left exactly as written. Mirrors
/// packages/core/src/util/typography.ts.
final _codeSpans = RegExp(r'(```[\s\S]*?(?:```|$)|`[^`\n]*`)');

/// The long dash itself: it is the one thing this file must be able to name.
const _longDash = '—';

String stripEmDashes(String text) {
  if (!text.contains(_longDash)) return text;
  final out = StringBuffer();
  var cursor = 0;
  String clean(String part) =>
      part.replaceAll(RegExp(r'\s+—\s+'), ', ').replaceAll(_longDash, '-');
  for (final match in _codeSpans.allMatches(text)) {
    out.write(clean(text.substring(cursor, match.start)));
    out.write(match.group(0));
    cursor = match.end;
  }
  out.write(clean(text.substring(cursor)));
  return out.toString();
}
