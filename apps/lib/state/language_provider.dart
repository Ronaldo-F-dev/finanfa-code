import 'dart:ui';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../i18n/strings.dart';

const _languageKey = 'finanfa.language';
const supportedLanguages = ['en', 'fr'];

String _deviceDefaultLanguage() {
  final code = PlatformDispatcher.instance.locale.languageCode;
  return supportedLanguages.contains(code) ? code : 'en';
}

class LanguageNotifier extends Notifier<String> {
  @override
  String build() {
    _load();
    return _deviceDefaultLanguage();
  }

  Future<void> _load() async {
    final prefs = await SharedPreferences.getInstance();
    final saved = prefs.getString(_languageKey);
    if (saved != null && supportedLanguages.contains(saved)) state = saved;
  }

  Future<void> setLanguage(String code) async {
    state = code;
    final prefs = await SharedPreferences.getInstance();
    await prefs.setString(_languageKey, code);
  }
}

final languageProvider = NotifierProvider<LanguageNotifier, String>(
  LanguageNotifier.new,
);

/// Shorthand for `tr(ref.watch(languageProvider), key)` — used throughout
/// the screens/widgets instead of hardcoded English strings.
String t(WidgetRef ref, String key) => tr(ref.watch(languageProvider), key);
