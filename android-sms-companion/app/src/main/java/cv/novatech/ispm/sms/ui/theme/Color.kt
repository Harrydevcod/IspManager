package cv.novatech.ispm.sms.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.compositeOver

/**
 * The desktop's tokens (src/renderer/styles.css), dark and light, so the phone
 * reads as the same product. Change them there first, then here.
 */
@Immutable
data class IspmColors(
  val isDark: Boolean,
  val bg: Color,
  val surface: Color,
  val surface2: Color,
  val surface3: Color,
  val border: Color,
  val border2: Color,
  val text: Color,
  val text2: Color,
  val text3: Color,
  val accent: Color,
  val onAccent: Color,
  val accentBg: Color,
  val success: Color,
  val successBg: Color,
  val danger: Color,
  val dangerBg: Color,
  val warn: Color,
  val warnBg: Color,
  val info: Color,
  val infoBg: Color
)

private val darkBg = Color(0xFF05070D)

// Dark tints are sRGB blends over --bg: the desktop's color-mix(in oklch) drags a
// near-grey background's hue into red and green, and on a phone they stopped reading.
private fun tint(c: Color, alpha: Float = 0.16f) = c.copy(alpha = alpha).compositeOver(darkBg)

val DarkColors = IspmColors(
  isDark = true,
  bg = darkBg,
  surface = Color(0xFF0E1524),
  surface2 = Color(0xFF131C2E),
  surface3 = Color(0xFF1A2438),
  border = Color(0xFF1E2A42),
  border2 = Color(0xFF2A3A58),
  text = Color(0xFFE8EEFC),
  text2 = Color(0xFF94A5C4),
  text3 = Color(0xFF7786A3),
  accent = Color(0xFF3380FF),
  onAccent = darkBg,
  accentBg = tint(Color(0xFF3380FF)),
  success = Color(0xFF22D38A),
  successBg = tint(Color(0xFF22D38A)),
  danger = Color(0xFFFF3D5A),
  dangerBg = tint(Color(0xFFFF3D5A)),
  warn = Color(0xFFFFB020),
  warnBg = tint(Color(0xFFFFB020)),
  info = Color(0xFF38D6FF),
  infoBg = tint(Color(0xFF38D6FF), 0.14f)
)

// Light: the desktop's editorial warm off-white with the heritage gold accent,
// converted from its OKLCH values (not an inverted dark theme).
val LightColors = IspmColors(
  isDark = false,
  bg = Color(0xFFF6F3F0),
  surface = Color(0xFFFEFDFB),
  surface2 = Color(0xFFF9F7F4),
  surface3 = Color(0xFFF1EEEA),
  border = Color(0xFFDEDAD5),
  border2 = Color(0xFFC0B9B2),
  text = Color(0xFF2A2620),
  text2 = Color(0xFF5A544E),
  text3 = Color(0xFF625D56),
  accent = Color(0xFF8F4900),
  onAccent = Color(0xFFFFFBF3),
  accentBg = Color(0xFFF3E6D8),
  success = Color(0xFF006E38),
  successBg = Color(0xFFD5F7E2),
  danger = Color(0xFFA90012),
  dangerBg = Color(0xFFFFE0DA),
  warn = Color(0xFF8A5700),
  warnBg = Color(0xFFFFE9C8),
  info = Color(0xFF005E98),
  infoBg = Color(0xFFD3F2FF)
)

val LocalIspmColors = staticCompositionLocalOf { DarkColors }

// Short names for the call sites; each reads the theme in effect.
val Bg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.bg
val Surface: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.surface
val Surface2: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.surface2
val Surface3: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.surface3
val BorderC: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.border
val Border2: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.border2
val TextPrimary: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.text
val TextSecondary: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.text2
val TextMuted: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.text3
val Accent: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.accent
val OnAccent: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.onAccent
val AccentBg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.accentBg
val Success: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.success
val SuccessBg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.successBg
val Danger: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.danger
val DangerBg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.dangerBg
val Warn: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.warn
val WarnBg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.warnBg
val Info: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.info
val InfoBg: Color @Composable @ReadOnlyComposable get() = LocalIspmColors.current.infoBg

/** Severity from the desktop ("red" / "amber" / anything else). */
@Composable @ReadOnlyComposable
fun severityColor(severity: String): Color = when (severity) {
  "red" -> Danger
  "amber" -> Warn
  else -> Success
}

@Composable @ReadOnlyComposable
fun severityBg(severity: String): Color = when (severity) {
  "red" -> DangerBg
  "amber" -> WarnBg
  else -> SuccessBg
}
