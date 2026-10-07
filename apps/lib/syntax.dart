import 'package:flutter/painting.dart';
import 'package:highlight/highlight_core.dart' as hl;
import 'package:highlight/languages/bash.dart';
import 'package:highlight/languages/cpp.dart';
import 'package:highlight/languages/cs.dart';
import 'package:highlight/languages/css.dart';
import 'package:highlight/languages/diff.dart';
import 'package:highlight/languages/dockerfile.dart';
import 'package:highlight/languages/go.dart';
import 'package:highlight/languages/ini.dart';
import 'package:highlight/languages/java.dart';
import 'package:highlight/languages/javascript.dart';
import 'package:highlight/languages/json.dart';
import 'package:highlight/languages/kotlin.dart';
import 'package:highlight/languages/makefile.dart';
import 'package:highlight/languages/markdown.dart';
import 'package:highlight/languages/nginx.dart';
import 'package:highlight/languages/php.dart';
import 'package:highlight/languages/python.dart';
import 'package:highlight/languages/ruby.dart';
import 'package:highlight/languages/rust.dart';
import 'package:highlight/languages/sql.dart';
import 'package:highlight/languages/swift.dart';
import 'package:highlight/languages/typescript.dart';
import 'package:highlight/languages/xml.dart';
import 'package:highlight/languages/yaml.dart';

// Code colouring for the code blocks of a reply, the same languages as the web
// app (packages/web-client/src/highlight.ts). Only the languages people ask an
// assistant for are registered, to keep the app small. A fence with another
// language (or none) stays plain text: a wrong guess colours code misleadingly.
final Map<String, hl.Mode> _languages = {
  'bash': bash,
  'cpp': cpp,
  'csharp': cs,
  'css': css,
  'diff': diff,
  'dockerfile': dockerfile,
  'go': go,
  'ini': ini,
  'java': java,
  'javascript': javascript,
  'json': json,
  'kotlin': kotlin,
  'makefile': makefile,
  'markdown': markdown,
  'nginx': nginx,
  'php': php,
  'python': python,
  'ruby': ruby,
  'rust': rust,
  'sql': sql,
  'swift': swift,
  'typescript': typescript,
  'xml': xml,
  'yaml': yaml,
};

final hl.Highlight _highlighter = _buildHighlighter();

hl.Highlight _buildHighlighter() {
  final highlighter = hl.Highlight();
  _languages.forEach(highlighter.registerLanguage);
  return highlighter;
}

const _aliases = {
  'sh': 'bash',
  'shell': 'bash',
  'zsh': 'bash',
  'console': 'bash',
  'docker': 'dockerfile',
  'containerfile': 'dockerfile',
  'yml': 'yaml',
  'js': 'javascript',
  'jsx': 'javascript',
  'mjs': 'javascript',
  'ts': 'typescript',
  'tsx': 'typescript',
  'py': 'python',
  'html': 'xml',
  'svg': 'xml',
  'toml': 'ini',
  'conf': 'nginx',
  'rs': 'rust',
  'cs': 'csharp',
  'kt': 'kotlin',
  'md': 'markdown',
  'rb': 'ruby',
  'make': 'makefile',
  'c++': 'cpp',
  'c': 'cpp',
  'golang': 'go',
  'patch': 'diff',
};

/// The language name known here for a fence's label ("yml" -> "yaml"), or null when it is not registered.
String? resolveLanguage(String? label) {
  final key = (label ?? '').trim().toLowerCase().split(RegExp(r'\s+')).first;
  final name = _aliases[key] ?? key;
  return _languages.containsKey(name) ? name : null;
}

/// Colours for the dark code card, by highlight.js token class.
const _tokenColors = <String, Color>{
  'keyword': Color(0xFF7AA2F7),
  'selector-tag': Color(0xFF7AA2F7),
  'literal': Color(0xFF7AA2F7),
  'doctag': Color(0xFF7AA2F7),
  'section': Color(0xFF7AA2F7),
  'string': Color(0xFF9ECE6A),
  'regexp': Color(0xFF9ECE6A),
  'addition': Color(0xFF9ECE6A),
  'number': Color(0xFFFF9E64),
  'symbol': Color(0xFFFF9E64),
  'bullet': Color(0xFFFF9E64),
  'link': Color(0xFFFF9E64),
  'comment': Color(0xFF6B7280),
  'quote': Color(0xFF6B7280),
  'built_in': Color(0xFFBB9AF7),
  'type': Color(0xFFBB9AF7),
  'meta': Color(0xFFBB9AF7),
  'attr': Color(0xFF73DACA),
  'attribute': Color(0xFF73DACA),
  'variable': Color(0xFF73DACA),
  'template-variable': Color(0xFF73DACA),
  'name': Color(0xFF73DACA),
  'params': Color(0xFF73DACA),
  'title': Color(0xFFE0AF68),
  'selector-id': Color(0xFFE0AF68),
  'selector-class': Color(0xFFE0AF68),
  'deletion': Color(0xFFF7768E),
};

void _collect(List<hl.Node> nodes, TextStyle base, Color? inherited, List<TextSpan> out) {
  for (final node in nodes) {
    final color = _tokenColors[node.className] ?? inherited;
    if (node.value != null) {
      out.add(TextSpan(text: node.value, style: color == null ? base : base.copyWith(color: color)));
    }
    final children = node.children;
    if (children != null) _collect(children, base, color, out);
  }
}

/// The code as coloured spans in [base], or null when [label] names no registered language (the caller then shows plain text).
List<TextSpan>? highlightSpans(String code, String? label, TextStyle base) {
  final language = resolveLanguage(label);
  if (language == null) return null;
  try {
    final result = _highlighter.parse(code, language: language);
    final spans = <TextSpan>[];
    _collect(result.nodes ?? const [], base, null, spans);
    return spans;
  } catch (_) {
    return null;
  }
}
