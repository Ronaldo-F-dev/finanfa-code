import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../state/language_provider.dart';
import '../theme.dart';

/// Mirrors packages/web-client/src/components/BusyIndicator.tsx — a plain
/// spinner-plus-label row at the end of the timeline while a turn is in
/// flight, not a full-screen blocker.
class BusyIndicatorTile extends ConsumerWidget {
  final String? label;
  const BusyIndicatorTile({super.key, this.label});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Row(
        children: [
          SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator(strokeWidth: 2, color: c.accent),
          ),
          const SizedBox(width: 10),
          Text(
            label ?? t(ref, 'busy.working'),
            style: TextStyle(color: c.textMuted, fontSize: 13.5),
          ),
        ],
      ),
    );
  }
}
