import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'package:google_fonts/google_fonts.dart';

/// finanfa's own native-app identity — deliberately NOT the same warm
/// terracotta/cream palette as packages/web-client/src/index.css (real,
/// reported feedback: that palette reads as "too close to Claude's own
/// look"). Indigo + cool neutrals instead: distinct from Claude's rust/
/// coral and from ChatGPT's teal, and the blue reads as trust/finance-
/// appropriate for an app named finanfa.
///
/// Values below come from the design system export (export/tokens/,
/// generated separately — see export/README.md), mapped onto this same
/// field set so every screen that already reads `context.colors` picked up
/// the new palette without needing its own changes.
class FinanfaColors {
  final Color bg;
  final Color bgElevated;
  final Color bgCard;
  final Color border;
  final Color text;
  final Color textMuted;
  final Color accent;
  final Color accentFill;
  final Color danger;
  final Color success;
  final Color userBubble;

  const FinanfaColors({
    required this.bg,
    required this.bgElevated,
    required this.bgCard,
    required this.border,
    required this.text,
    required this.textMuted,
    required this.accent,
    required this.accentFill,
    required this.danger,
    required this.success,
    required this.userBubble,
  });

  static const light = FinanfaColors(
    bg: Color(0xFFF4F6FB),
    bgElevated: Color(0xFFEDF0F7),
    bgCard: Color(0xFFFFFFFF),
    border: Color(0xFFE2E7F2),
    text: Color(0xFF0E1016),
    textMuted: Color(0xFF5A6479),
    accent: Color(0xFF3652E0),
    accentFill: Color(0xFF3652E0),
    danger: Color(0xFFD14343),
    success: Color(0xFF0F9D6E),
    userBubble: Color(0xFFE8ECFD),
  );

  static const dark = FinanfaColors(
    bg: Color(0xFF0E1016),
    bgElevated: Color(0xFF1D222E),
    bgCard: Color(0xFF161A23),
    border: Color(0xFF262C3A),
    text: Color(0xFFE9ECF4),
    textMuted: Color(0xFF8D96AC),
    accent: Color(0xFF5B72FF),
    // Filled buttons in dark mode use this instead of `accent` directly —
    // #4A60F0 keeps a >=4.5:1 contrast ratio against white button text,
    // per the design export's usage rules (export/README.md).
    accentFill: Color(0xFF4A60F0),
    danger: Color(0xFFF87171),
    success: Color(0xFF34D399),
    userBubble: Color(0xFF222C57),
  );
}

/// export/tokens/finanfa_theme.dart's radius scale.
class FinanfaRadii {
  static const sm = 9.0; // pills, small fields
  static const md = 12.0; // buttons
  static const lg = 14.0; // cards
  static const xl = 20.0; // composer, sheets
}

/// A single spacing scale (4/8/12/16/20/24/32) so paddings/gaps across
/// screens read as one consistent rhythm instead of ad hoc magic numbers
/// (the app had e.g. 4, 6, 8, 10, 12, 14 all used intercheangeably for the
/// same "small gap" role across chat/connectors/settings/connect screens).
/// Existing tight spots (6px chip padding, 4px icon-to-label gaps) are left
/// alone — this scale is for section/card/list rhythm, not every gap in
/// the app.
class FinanfaSpace {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 12.0;
  static const lg = 16.0;
  static const xl = 20.0;
  static const xxl = 24.0;
  static const xxxl = 32.0;
}

extension FinanfaColorsX on BuildContext {
  FinanfaColors get colors => Theme.of(this).brightness == Brightness.dark
      ? FinanfaColors.dark
      : FinanfaColors.light;
}

/// A small named set of text styles layered on top of [ThemeData.textTheme],
/// for the roles that kept getting reinvented inline (a metadata caption at
/// 11/12/12.5/13/13.5px depending on which screen you were looking at, a
/// card/section title sometimes mono/sometimes not). Screens should reach
/// for these instead of a fresh inline `TextStyle` for these specific roles;
/// one-off styling (bubble text, code blocks) stays where it is.
class FinanfaTextStyles {
  final FinanfaColors c;
  const FinanfaTextStyles(this.c);

  /// Card/list-item primary label — connector name, provider name. Bigger
  /// and heavier than the body default so it visually dominates the
  /// secondary metadata sitting under it.
  TextStyle get itemTitle => TextStyle(
    color: c.text,
    fontSize: 15,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.1,
  );

  /// Secondary metadata under an itemTitle — transport, timestamp, host.
  /// Deliberately smaller/muted so it recedes behind itemTitle/body text.
  TextStyle get caption => TextStyle(color: c.textMuted, fontSize: 12.5, height: 1.3);

  /// Uppercase-ish section headers (settings sections, drawer group labels).
  TextStyle get sectionLabel => TextStyle(
    color: c.textMuted,
    fontSize: 11,
    letterSpacing: 0.6,
    fontWeight: FontWeight.w600,
  );

  /// Body copy slightly larger/looser than default — message bubbles,
  /// paragraph-y content.
  TextStyle get body => TextStyle(color: c.text, fontSize: 15, height: 1.4);
}

extension FinanfaTextStylesX on BuildContext {
  FinanfaTextStyles get textStyles => FinanfaTextStyles(colors);
}

ThemeData _buildTheme(FinanfaColors c, Brightness brightness) {
  final scheme = ColorScheme(
    brightness: brightness,
    primary: c.accent,
    onPrimary: Colors.white,
    secondary: c.accent,
    onSecondary: Colors.white,
    error: c.danger,
    onError: Colors.white,
    surface: c.bg,
    onSurface: c.text,
  );
  // Space Grotesk for headings/brand, IBM Plex Sans for UI text — see
  // export/README.md. google_fonts fetches+caches on first use rather than
  // bundling font files by hand; it falls back to the platform default
  // instead of failing outright if that first fetch has no network.
  final base = GoogleFonts.ibmPlexSansTextTheme(
    Typography.blackMountainView.apply(bodyColor: c.text, displayColor: c.text),
  );
  final headingFont = GoogleFonts.spaceGroteskTextTheme();
  final monoFont = GoogleFonts.ibmPlexMonoTextTheme();
  final textTheme = base.copyWith(
    displaySmall: headingFont.displaySmall?.copyWith(color: c.text, fontWeight: FontWeight.w600),
    titleLarge: headingFont.titleLarge?.copyWith(color: c.text, fontWeight: FontWeight.w600),
    titleMedium: headingFont.titleMedium?.copyWith(color: c.text, fontWeight: FontWeight.w600),
    // Tool/file names and code — export/README.md's IBM Plex Mono.
    labelMedium: monoFont.labelMedium?.copyWith(color: c.text, fontWeight: FontWeight.w500),
    labelSmall: monoFont.labelSmall?.copyWith(color: c.textMuted, fontWeight: FontWeight.w600, letterSpacing: 1.2),
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: scheme,
    scaffoldBackgroundColor: c.bg,
    appBarTheme: AppBarTheme(
      backgroundColor: c.bg,
      foregroundColor: c.text,
      elevation: 0,
      scrolledUnderElevation: 0.5,
      surfaceTintColor: Colors.transparent,
      titleTextStyle: textTheme.titleLarge,
    ),
    cardTheme: CardThemeData(
      color: c.bgCard,
      elevation: 3,
      shadowColor: Colors.black.withValues(alpha: brightness == Brightness.dark ? 0.5 : 0.08),
      surfaceTintColor: Colors.transparent,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(FinanfaRadii.lg),
        side: BorderSide(color: c.border),
      ),
    ),
    listTileTheme: ListTileThemeData(
      iconColor: c.textMuted,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(FinanfaRadii.md)),
    ),
    dividerColor: c.border,
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.bgElevated,
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(FinanfaRadii.xl),
        borderSide: BorderSide.none,
      ),
      hintStyle: TextStyle(color: c.textMuted),
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.accentFill,
        foregroundColor: Colors.white,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(FinanfaRadii.md)),
        padding: const EdgeInsets.symmetric(vertical: 14),
      ),
    ),
    drawerTheme: DrawerThemeData(backgroundColor: c.bgElevated),
    dialogTheme: DialogThemeData(
      backgroundColor: c.bgCard,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(FinanfaRadii.xl)),
    ),
    textTheme: textTheme,
  );
}

final finanfaLightTheme = _buildTheme(FinanfaColors.light, Brightness.light);
final finanfaDarkTheme = _buildTheme(FinanfaColors.dark, Brightness.dark);

/// The app's one brand mark — the redesigned ₣ (see export/README.md,
/// direction "1a Franc"), reused everywhere finanfa needs to look like a
/// real product instead of a bare Material list (drawer header, About
/// screen), rather than every screen inventing its own ad hoc icon
/// treatment. A single solid accent fill, per the export's own usage rule:
/// one accent color per screen, no gradients.
class FinanfaMark extends StatelessWidget {
  final double size;
  // export/mockups/mobile-clair.png uses two distinct treatments, not one:
  // a filled accent-square badge in the drawer header, and a *bare* colored
  // glyph with no background at all for the empty-state hero. Defaulting to
  // filled (the more common spot — drawer, About) since callers that want
  // the bare mark (the empty state) opt in explicitly, rather than the
  // other way around silently doing the wrong thing more often.
  final bool filled;
  const FinanfaMark({super.key, this.size = 40, this.filled = true});

  @override
  Widget build(BuildContext context) {
    final c = context.colors;
    if (!filled) {
      return SizedBox(
        width: size,
        height: size,
        child: SvgPicture.asset('assets/branding/finanfa-mark-accent.svg'),
      );
    }
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(size * 0.28),
        color: c.accent,
      ),
      padding: EdgeInsets.all(size * 0.22),
      child: SvgPicture.asset('assets/branding/finanfa-mark-white.svg'),
    );
  }
}
