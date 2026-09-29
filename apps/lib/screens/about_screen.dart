import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:package_info_plus/package_info_plus.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/server_connection.dart';
import '../state/language_provider.dart';
import '../theme.dart';

class AboutScreen extends ConsumerStatefulWidget {
  final ServerConnection connection;
  const AboutScreen({super.key, required this.connection});
  @override
  ConsumerState<AboutScreen> createState() => _AboutScreenState();
}

class _AboutScreenState extends ConsumerState<AboutScreen> {
  PackageInfo? _info;

  @override
  void initState() {
    super.initState();
    PackageInfo.fromPlatform().then((info) {
      if (mounted) setState(() => _info = info);
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Scaffold(
      appBar: AppBar(title: Text(t(ref, 'about.title'))),
      body: ListView(
        padding: const EdgeInsets.all(24),
        children: [
          const FinanfaMark(size: 56),
          const SizedBox(height: 14),
          Text(
            'finanfa',
            style: TextStyle(
              fontSize: 24,
              fontWeight: FontWeight.w700,
              color: c.text,
            ),
          ),
          if (_info != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                '${t(ref, 'about.version')} ${_info!.version} (${_info!.buildNumber})',
                style: TextStyle(color: c.textMuted, fontSize: 13),
              ),
            ),
          const SizedBox(height: 24),
          ListTile(
            leading: Icon(Icons.dns_outlined, color: c.textMuted),
            title: Text(t(ref, 'about.server')),
            subtitle: Text(widget.connection.baseUrl),
          ),
          ListTile(
            leading: Icon(Icons.code, color: c.textMuted),
            title: Text(t(ref, 'about.repo')),
            subtitle: const Text('github.com/Ronaldo-F-dev/finanfa-code'),
            onTap: () => launchUrl(
              Uri.parse('https://github.com/Ronaldo-F-dev/finanfa-code'),
            ),
          ),
          const SizedBox(height: 16),
          Text(
            t(ref, 'about.description'),
            style: TextStyle(color: c.textMuted, fontSize: 13, height: 1.4),
          ),
        ],
      ),
    );
  }
}
