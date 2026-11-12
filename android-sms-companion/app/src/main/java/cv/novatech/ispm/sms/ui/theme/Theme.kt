package cv.novatech.ispm.sms.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.unit.dp

// The desktop's radii: controls 10, surfaces 14. Nothing is a pill.
val IspmShapes = Shapes(
  extraSmall = RoundedCornerShape(6.dp),
  small = RoundedCornerShape(10.dp),
  medium = RoundedCornerShape(14.dp),
  large = RoundedCornerShape(14.dp),
  extraLarge = RoundedCornerShape(18.dp)
)

/** Material components (Switch, dialogs, sheets, text fields) read these, so they follow the theme too. */
private fun IspmColors.toScheme(): ColorScheme {
  val base = if (isDark) darkColorScheme() else lightColorScheme()
  return base.copy(
    primary = accent, onPrimary = onAccent, primaryContainer = accentBg, onPrimaryContainer = text,
    secondary = text2, onSecondary = bg, secondaryContainer = accentBg, onSecondaryContainer = text,
    tertiary = info, onTertiary = bg,
    background = bg, onBackground = text,
    surface = surface, onSurface = text, surfaceVariant = surface2, onSurfaceVariant = text2,
    surfaceTint = surface,
    surfaceContainerLowest = bg, surfaceContainerLow = surface, surfaceContainer = surface,
    surfaceContainerHigh = surface2, surfaceContainerHighest = surface3,
    surfaceBright = surface3, surfaceDim = bg,
    inverseSurface = text, inverseOnSurface = bg, inversePrimary = accent,
    outline = border2, outlineVariant = border,
    error = danger, onError = onAccent, errorContainer = dangerBg, onErrorContainer = danger,
    scrim = bg.copy(alpha = 0.6f)
  )
}

@Composable
fun IspmTheme(dark: Boolean = isSystemInDarkTheme(), content: @Composable () -> Unit) {
  val colors = if (dark) DarkColors else LightColors
  CompositionLocalProvider(LocalIspmColors provides colors) {
    MaterialTheme(colorScheme = colors.toScheme(), typography = IspmTypography, shapes = IspmShapes, content = content)
  }
}
