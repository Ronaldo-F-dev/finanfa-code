import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'screens/chat_screen.dart';
import 'screens/connect_screen.dart';
import 'state/server_connection_provider.dart';
import 'state/theme_provider.dart';
import 'theme.dart';

void main() {
  runApp(const ProviderScope(child: FinanfaApp()));
}

class FinanfaApp extends ConsumerWidget {
  const FinanfaApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final themeMode = ref.watch(themeModeProvider);
    return MaterialApp(
      title: 'finanfa',
      debugShowCheckedModeBanner: false,
      theme: finanfaLightTheme,
      darkTheme: finanfaDarkTheme,
      themeMode: themeMode,
      home: const _RootScreen(),
    );
  }
}

class _RootScreen extends ConsumerWidget {
  const _RootScreen();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final connectionAsync = ref.watch(serverConnectionProvider);
    return connectionAsync.when(
      loading: () =>
          const Scaffold(body: Center(child: CircularProgressIndicator())),
      error: (err, _) => Scaffold(
        body: Center(child: Text('Failed to load server settings: $err')),
      ),
      data: (connection) => connection == null
          ? const ConnectScreen()
          : ChatScreen(connection: connection),
    );
  }
}
