import 'package:finanfa/syntax.dart';
import 'package:flutter/painting.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const base = TextStyle(color: Color(0xFFE9ECF4));

  test('colours a Dockerfile: the instructions get their own colour, the text is unchanged', () {
    const code = 'FROM node:22-alpine\nRUN npm ci\nCMD ["node", "index.js"]';
    final spans = highlightSpans(code, 'dockerfile', base)!;
    expect(spans.map((s) => s.text).join(), code);
    expect(spans.any((s) => s.style?.color != base.color), isTrue);
  });

  test('knows the usual aliases', () {
    expect(resolveLanguage('docker'), 'dockerfile');
    expect(resolveLanguage('yml'), 'yaml');
    expect(resolveLanguage('sh'), 'bash');
    expect(resolveLanguage('TSX'), 'typescript');
    expect(resolveLanguage('html title'), 'xml');
  });

  test('an unknown or missing language is left to plain text', () {
    expect(highlightSpans('echo hi', 'klingon', base), isNull);
    expect(highlightSpans('echo hi', null, base), isNull);
    expect(highlightSpans('echo hi', '', base), isNull);
  });
}
