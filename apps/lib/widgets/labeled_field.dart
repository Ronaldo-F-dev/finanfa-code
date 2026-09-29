import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../theme.dart';

/// A field with its caption always sitting above it, in a fixed, entirely
/// predictable layout — not Material's built-in floating label (which
/// starts *inside* the field and jumps up on focus/typing). A real, reported
/// bug came from trying to force that behavior globally via
/// InputDecorationTheme.floatingLabelBehavior instead: it reserves label
/// space even for the hint-only fields that never use InputDecoration's own
/// `labelText`, throwing off every Row that pairs a field with a button
/// (Settings' "save" rows) since the field's height grew while the button's
/// didn't. This widget only ever affects the one field it wraps.
class LabeledField extends StatelessWidget {
  final String label;
  final Widget child;
  const LabeledField({super.key, required this.label, required this.child});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 4, bottom: 6),
          child: Text(
            label.toUpperCase(),
            style: GoogleFonts.ibmPlexMono(
              color: c.textMuted,
              fontSize: 10,
              fontWeight: FontWeight.w600,
              letterSpacing: 0.8,
            ),
          ),
        ),
        child,
      ],
    );
  }
}
