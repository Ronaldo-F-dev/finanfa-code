import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api/finanfa_api_client.dart';
import '../core/server_connection.dart';
import '../state/language_provider.dart';
import '../state/server_connection_provider.dart';
import '../theme.dart';
import '../widgets/labeled_field.dart';

class ConnectScreen extends ConsumerStatefulWidget {
  const ConnectScreen({super.key});
  @override
  ConsumerState<ConnectScreen> createState() => _ConnectScreenState();
}

class _ConnectScreenState extends ConsumerState<ConnectScreen> {
  final _urlController = TextEditingController(text: 'http://localhost:4600');
  final _usernameController = TextEditingController();
  final _passwordController = TextEditingController();
  bool _needsLogin = false;
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _urlController.dispose();
    _usernameController.dispose();
    _passwordController.dispose();
    super.dispose();
  }

  Future<void> _connect() async {
    final url = _urlController.text.trim();
    if (url.isEmpty) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      var connection = ServerConnection(baseUrl: url);
      final client = FinanfaApiClient(connection);
      if (!await client.ping()) {
        setState(() => _error = t(ref, 'connect.unreachable'));
        return;
      }
      if (_needsLogin) {
        final token = await client.login(
          _usernameController.text.trim(),
          _passwordController.text,
        );
        connection = connection.copyWith(token: token);
      }
      await ref
          .read(serverConnectionProvider.notifier)
          .setConnection(connection);
    } on FinanfaApiException catch (e) {
      setState(() => _error = e.message);
    } catch (e) {
      setState(() => _error = t(ref, 'connect.unreachable'));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 420),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  const FinanfaMark(size: 44),
                  const SizedBox(height: FinanfaSpace.lg),
                  Text(t(ref, 'connect.title'), style: Theme.of(context).textTheme.displaySmall),
                  const SizedBox(height: FinanfaSpace.xs),
                  Text(t(ref, 'connect.subtitle'), style: context.textStyles.caption),
                  const SizedBox(height: FinanfaSpace.xxl),
                  LabeledField(
                    label: t(ref, 'connect.serverUrl'),
                    child: TextField(
                      controller: _urlController,
                      keyboardType: TextInputType.url,
                      decoration: InputDecoration(
                        hintText: t(ref, 'connect.serverUrlHint'),
                      ),
                    ),
                  ),
                  Padding(
                    padding: const EdgeInsets.only(top: FinanfaSpace.sm, left: 4, right: 4),
                    child: Text(t(ref, 'connect.serverUrlHelp'), style: context.textStyles.caption),
                  ),
                  const SizedBox(height: FinanfaSpace.md),
                  Row(
                    children: [
                      Switch(
                        value: _needsLogin,
                        onChanged: (v) => setState(() => _needsLogin = v),
                        activeThumbColor: c.accent,
                      ),
                      const SizedBox(width: 4),
                      Expanded(
                        child: Text(
                          t(ref, 'connect.requiresLogin'),
                          style: TextStyle(color: c.text),
                        ),
                      ),
                    ],
                  ),
                  if (_needsLogin) ...[
                    const SizedBox(height: 8),
                    LabeledField(
                      label: t(ref, 'connect.username'),
                      child: TextField(controller: _usernameController),
                    ),
                    const SizedBox(height: 10),
                    LabeledField(
                      label: t(ref, 'connect.password'),
                      child: TextField(controller: _passwordController, obscureText: true),
                    ),
                  ],
                  if (_error != null) ...[
                    const SizedBox(height: 16),
                    Text(
                      _error!,
                      style: TextStyle(color: c.danger, fontSize: 13.5),
                    ),
                  ],
                  const SizedBox(height: 20),
                  FilledButton(
                    onPressed: _busy ? null : _connect,
                    child: _busy
                        ? const SizedBox(
                            width: 20,
                            height: 20,
                            child: CircularProgressIndicator(
                              strokeWidth: 2,
                              color: Colors.white,
                            ),
                          )
                        : Text(t(ref, 'connect.connect')),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
