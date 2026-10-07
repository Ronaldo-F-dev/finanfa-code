import 'package:finanfa/i18n/tool_names.dart';
import 'package:finanfa/typography.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('toolLabel', () {
    test('turns an id into words in English', () {
      expect(toolLabel('ask_user', 'en'), 'Ask user');
      expect(toolLabel('git_push', 'en'), 'Git push');
    });
    test('uses a hand-written French name when there is one, words otherwise', () {
      expect(toolLabel('ask_user', 'fr'), 'Poser une question');
      expect(toolLabel('serial_open', 'fr'), 'Serial open');
    });
    test('shows an MCP tool as server: action', () {
      expect(toolLabel('mcp__github__create_issue', 'en'), 'github: Create issue');
    });
  });

  group('stripEmDashes', () {
    test('turns a spaced dash into a comma and a bare one into a hyphen', () {
      expect(stripEmDashes('Bonjour — voici la suite'), 'Bonjour, voici la suite');
      expect(stripEmDashes('2020—2024'), '2020-2024');
    });
    test('leaves code alone, fenced (even unfinished) or inline', () {
      expect(stripEmDashes('a `x — y` b — c'), 'a `x — y` b, c');
      expect(
        stripEmDashes('```\nx — y\n```\nok — fin'),
        '```\nx — y\n```\nok, fin',
      );
      expect(stripEmDashes('avant — ```\nx — y'), 'avant, ```\nx — y');
    });
    test('returns text without a dash untouched', () {
      expect(stripEmDashes('rien à changer'), 'rien à changer');
    });
  });
}
