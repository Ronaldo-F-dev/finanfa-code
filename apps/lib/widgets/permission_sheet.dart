import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/models/session_models.dart';
import '../state/language_provider.dart';
import '../theme.dart';

/// Mirrors packages/web-client/src/components/PermissionModal.tsx — a tool
/// call needing "ask" confirmation blocks the turn until answered with
/// exactly the y/n/a/t vocabulary PermissionManager.promptUser expects.
Future<void> showPermissionSheet(
  BuildContext context,
  PermissionRequest request,
  void Function(String answer) onAnswer,
) {
  return showModalBottomSheet(
    context: context,
    isDismissible: false,
    enableDrag: false,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
    ),
    builder: (ctx) => _PermissionSheetContent(
      request: request,
      onAnswer: (answer) {
        onAnswer(answer);
        Navigator.of(ctx).pop();
      },
    ),
  );
}

class _PermissionSheetContent extends ConsumerWidget {
  final PermissionRequest request;
  final void Function(String answer) onAnswer;
  const _PermissionSheetContent({
    required this.request,
    required this.onAnswer,
  });

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final c = context.colors;
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 20, 20, 20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              request.prompt,
              style: TextStyle(color: c.text, fontSize: 15, height: 1.4),
            ),
            const SizedBox(height: 20),
            Row(
              children: [
                Expanded(
                  child: FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: c.success),
                    onPressed: () => onAnswer('y'),
                    child: Text(t(ref, 'permission.yes')),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: FilledButton(
                    style: FilledButton.styleFrom(backgroundColor: c.danger),
                    onPressed: () => onAnswer('n'),
                    child: Text(t(ref, 'permission.no')),
                  ),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => onAnswer('a'),
                    child: Text(t(ref, 'permission.alwaysAction')),
                  ),
                ),
                const SizedBox(width: 10),
                Expanded(
                  child: OutlinedButton(
                    onPressed: () => onAnswer('t'),
                    child: Text(t(ref, 'permission.alwaysTool')),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}
