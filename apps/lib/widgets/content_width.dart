import 'package:flutter/material.dart';

/// Caps content to a comfortable reading/interaction width and centers it —
/// a no-op on a phone-width window (the cap only bites once available width
/// exceeds it) but keeps message bubbles, settings rows, and connector
/// cards from stretching edge-to-edge across a wide desktop window. Nothing
/// in this app had any desktop-width handling before this; every screen
/// was sized purely for a phone, which is what made it look broken/
/// unfinished at a real desktop window width.
class ContentWidth extends StatelessWidget {
  final Widget child;
  final double maxWidth;
  const ContentWidth({super.key, required this.child, this.maxWidth = 720});

  @override
  Widget build(BuildContext context) {
    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        // Center alone would shrink-wrap `child` to its own intrinsic
        // width; this forces it back out to fill up to maxWidth (or the
        // full window width on a narrower phone screen) so e.g. a Column
        // with crossAxisAlignment.stretch still stretches correctly.
        child: SizedBox(width: double.infinity, child: child),
      ),
    );
  }
}
